import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createAssistantReview } from '../agent/assistant-review.mjs'
import { FOCUS_GUIDE, INSTRUCTIONS, REVIEW_GUIDE, promptFor, validateCall } from '../agent/protocol.mjs'
import assistantRoutes from '../routes/assistant.mjs'
import { applyOps, newProject } from '../core/project.js'
import { fixtureSharing } from './fixtures/sharing-fixture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const waitFor = async (predicate, limit = 400) => {
  for (let i = 0; i < limit; i++) { const value = await predicate(); if (value) return value; await sleep(25) }
  assert.fail('The assistant review fixture did not reach the expected state.')
}

// ---------------------------------------------------------------- the review state

function tracker() {
  const state = { version: 4, epoch: 1, project: newProject('Current'), events: [] }
  const review = createAssistantReview({ getVersion: () => state.version, getEpoch: () => state.epoch, getProject: () => state.project, onChange: value => state.events.push(value), now: () => 1000 })
  return { state, review }
}

test('a finished request with only its own edits can be undone in one step', () => {
  const { state, review } = tracker(), before = newProject('Before')
  review.observe({ state: 'thinking', runId: 'r1' }, before)
  assert.equal(review.active(), true)
  state.version = 7; state.project = newProject('After')
  const after = state.project
  review.observe({ state: 'done', runId: 'r1' }, after)
  const change = review.snapshot().change
  assert.equal(change.kind, 'request'); assert.equal(change.edits, 3); assert.equal(change.undoable, true); assert.equal(change.reason, '')
  assert.equal(review.undoTarget(change.id).change.before, before)
  state.version = 8; state.project = newProject('Later edit')
  assert.equal(review.snapshot().change.undoable, false)
  assert.match(review.undoTarget(change.id).reason, /changed after this assistant change/)
  state.version = 9; state.project = after
  assert.equal(review.snapshot().change.undoable, true, 'undoing the later edit makes the request undoable again')
})

test('user edits, project replacement or no edits during a request leave nothing to undo in one step', () => {
  const { state, review } = tracker()
  review.observe({ state: 'thinking', runId: 'r1' }, newProject('A'))
  review.commitBy(undefined); state.version = 6
  review.observe({ state: 'done', runId: 'r1' }, state.project)
  assert.equal(review.snapshot().change.undoable, false)
  assert.match(review.snapshot().change.reason, /edited the project while the assistant change was being made/)
  review.observe({ state: 'working', runId: 'r2' }, newProject('B'))
  state.epoch = 2; state.version = 9
  review.observe({ state: 'error', runId: 'r2' }, state.project)
  assert.equal(review.snapshot().change.undoable, false)
  review.observe({ state: 'thinking', runId: 'r3' }, newProject('C'))
  review.observe({ state: 'cancelled', runId: 'r3' }, null)
  assert.equal(review.snapshot().change.runId, 'r2', 'a request without edits keeps the previous change record')
  review.commitBy({ runId: 'other' })
  assert.equal(review.active(), false)
})

test('previews accumulate within one request, reset on request and refuse unsafe ops', () => {
  const { state, review } = tracker()
  review.observe({ state: 'thinking', runId: 'r1' }, newProject('A'))
  const first = review.stage(review.propose({ runId: 'r1', ops: [{ op: 'add_title', text: 'One' }], summary: 'Add a title' }))
  const second = review.stage(review.propose({ runId: 'r1', ops: [{ op: 'update', id: 'c1', set: { opacity: 0.5 } }], summary: 'Fade it' }))
  assert.notEqual(first.id, second.id)
  assert.equal(second.ops.length, 2); assert.equal(second.summary, 'Add a title; Fade it'); assert.equal(second.stale, false)
  const reset = review.stage(review.propose({ runId: 'r1', ops: [{ op: 'add_color', color: '#000' }], reset: true }))
  assert.equal(reset.ops.length, 1); assert.equal(reset.summary, '')
  for (const op of ['replace', 'import', 'library_apply']) assert.throws(() => review.propose({ runId: 'r1', ops: [{ op }] }), /cannot be previewed/)
  assert.throws(() => review.propose({ runId: 'r1', ops: [] }), /nonempty/)
  assert.throws(() => review.propose({ runId: 'r1', ops: ['add_title'] }), /object with an op name/)
  state.version = 5
  assert.equal(review.snapshot().proposal.stale, true)
  assert.throws(() => review.propose({ runId: 'r1', ops: [{ op: 'add_color', color: '#fff' }] }), /Send the complete edit again with reset:true/, 'a stale preview is never silently extended or dropped')
  assert.equal(review.propose({ runId: 'r2', ops: [{ op: 'add_color', color: '#fff' }] }).ops.length, 1, 'another request starts its own preview')
})

test('an applied preview becomes one undoable change and discard needs the current preview', () => {
  const { state, review } = tracker(), before = state.project
  review.stage(review.propose({ runId: null, ops: [{ op: 'add_color', color: '#000' }] }))
  assert.equal(review.discard('other'), false)
  review.beginApply(review.proposal(), before)
  assert.equal(review.snapshot().proposal, null); assert.equal(review.applying(), true); assert.equal(review.active(), true)
  state.version = 5; state.project = newProject('After')
  const change = review.finishApply(state.project)
  assert.equal(change.kind, 'preview'); assert.equal(change.undoable, true); assert.equal(review.snapshot().applying, null)
  assert.equal(review.undoTarget(change.id).change.before, before)
  review.undone(change.id)
  assert.equal(review.snapshot().change, null)
})

test('a preview carries processing steps, and a failed step keeps its notice until dismissed', () => {
  const { state, review } = tracker(), before = state.project
  const step = { path: '/api/stabilize/render', body: { src: 'media/a.mp4', clip: 'c1' } }
  assert.throws(() => review.propose({ steps: [{ path: '/api/ops', body: {} }] }), /Each step is \{path, body\}/)
  assert.throws(() => review.propose({ steps: [{ path: '/api/retime' }] }), /Each step is/)
  const first = review.propose({ runId: 'r1', steps: [step], summary: 'Steady it' })
  assert.deepEqual(first.ops, []); assert.deepEqual(first.steps, [step])
  review.stage({ ...first, steps: first.steps.map(item => ({ ...item, preview: { title: 'Stabilize' } })) })
  const second = review.propose({ runId: 'r1', ops: [{ op: 'add_color', color: '#000' }], steps: [{ path: '/api/audio/clean', body: { src: 'media/a.wav' } }] })
  assert.equal(second.steps.length, 2); assert.equal(second.ops.length, 1)
  assert.throws(() => review.propose({ runId: 'r1', steps: Array.from({ length: 17 }, () => step), reset: true }), /at most 16 processing steps/)
  review.stage({ ...second, steps: second.steps.map(item => ({ ...item, preview: { title: item.path } })) })
  review.beginApply(review.proposal(), before)
  review.applyProgress(1, 'Audio noise reduction')
  assert.deepEqual(review.snapshot().applying, { id: review.snapshot().applying.id, summary: 'Steady it', total: 2, index: 1, title: 'Audio noise reduction', finished: false, error: '' })
  review.commitBy({ applyId: review.snapshot().applying.id })
  review.commitBy(undefined)
  state.version = 6; state.project = newProject('Partly applied')
  const change = review.finishApply(state.project, 'Audio noise reduction did not finish: no audio.')
  assert.equal(change.undoable, false, 'a user edit during the apply keeps undo step by step')
  const notice = review.snapshot().applying
  assert.equal(notice.finished, true); assert.match(notice.error, /no audio/)
  assert.equal(review.discard(notice.id), true); assert.equal(review.snapshot().applying, null)
})

// ---------------------------------------------------------------- the routes

function routeFixture({ call } = {}) {
  let project = newProject('Routes'), version = 3
  const commits = [], calls = [], steps = []
  const review = createAssistantReview({ getVersion: () => version, getEpoch: () => 1, getProject: () => project })
  const ctx = {
    getProject: () => project, getVersion: () => version, getProjectGeneration: () => 1, getAssistantReview: () => review,
    assertCurrent: () => typeof call === 'function' ? call() : call, probe: async src => ({ duration: 2, hasAudio: false, hasVideo: true, width: 160, height: 90 }),
    pushActivity: () => {},
    editOps: async (ops, who, summary, options) => {
      if (options.expectedVersion !== version) throw new Error('The project changed.')
      project = applyOps(project, ops).project; version++; commits.push({ who, summary }); return { version }
    },
    commit: (next, who, lines) => { project = next; version++; commits.push({ who, lines }) },
    callAPI: async (method, route, body) => {
      calls.push({ method, route, body })
      const step = steps.shift()
      if (step?.error) throw new Error(step.error)
      if (step?.commit) { project = applyOps(project, step.commit).project; version++ }
      return step?.result ?? { state: 'done', applied: true }
    },
  }
  return { routes: assistantRoutes(ctx).routes, review, commits, calls, steps, get project() { return project }, get version() { return version }, set version(value) { version = value } }
}

test('propose checks ops against the project without saving and returns the outline it would have', async () => {
  const f = routeFixture({ call: { runId: 'r1' } })
  const before = f.project
  const result = await f.routes['POST /api/assistant/propose']({ ops: [{ op: 'add_title', track: 'V3', text: 'Preview', dur: 2 }], summary: 'Title' })
  assert.equal(result.previewed, true); assert.equal(result.applied, false)
  assert.deepEqual(result.created, ['c1']); assert.match(result.outline, /c1 title "Preview"/)
  assert.equal(f.project, before); assert.equal(f.version, 3)
  await assert.rejects(f.routes['POST /api/assistant/propose']({ ops: [{ op: 'update', id: 'missing', set: {} }] }), /no clip missing/)
  assert.equal(f.review.snapshot().proposal.ops.length, 1, 'an invalid addition leaves the checked preview')
  const media = await f.routes['POST /api/assistant/propose']({ ops: [{ op: 'append', src: 'media/new.mp4', track: 'V1' }] })
  assert.match(media.outline, /media\/new\.mp4/)
  await assert.rejects(f.routes['POST /api/assistant/proposal/apply']({ id: f.review.snapshot().proposal.id }), /Only the editor/)
})

test('apply commits the whole preview once at its base version, and undo restores the project before it', async () => {
  const f = routeFixture()
  const before = f.project
  await f.routes['POST /api/assistant/propose']({ ops: [{ op: 'add_title', track: 'V3', text: 'One', dur: 2 }], summary: 'One' })
  await f.routes['POST /api/assistant/propose']({ ops: [{ op: 'update', id: 'c1', set: { opacity: 0.5 } }], summary: 'Fade' })
  const { id } = f.review.snapshot().proposal
  await assert.rejects(f.routes['POST /api/assistant/proposal/apply']({ id: 'old' }), /no longer available/)
  const applied = await f.routes['POST /api/assistant/proposal/apply']({ id })
  assert.equal(applied.version, 4); assert.equal(f.commits.length, 1)
  assert.deepEqual(f.commits[0], { who: 'agent', summary: 'Applied preview: One; Fade' })
  assert.equal(f.project.tracks.find(track => track.id === 'V3').clips[0].opacity, 0.5)
  assert.equal(applied.change.undoable, true)
  const undone = f.routes['POST /api/assistant/change/undo']({ id: applied.change.id })
  assert.equal(undone.undone, true); assert.equal(f.project, before)
  assert.deepEqual(f.commits[1], { who: 'you', lines: ['Undo applied assistant preview'] })
  assert.throws(() => f.routes['POST /api/assistant/change/undo']({ id: applied.change.id }), /no longer the latest/)
})

test('a stale preview cannot be applied and discard removes it', async () => {
  const f = routeFixture()
  await f.routes['POST /api/assistant/propose']({ ops: [{ op: 'add_color', color: '#123456', start: 0, dur: 1 }] })
  const { id } = f.review.snapshot().proposal
  f.version = 9
  await assert.rejects(f.routes['POST /api/assistant/proposal/apply']({ id }), /changed after this preview/)
  assert.equal(f.routes['POST /api/assistant/proposal/discard']({ id }).discarded, true)
  assert.equal(f.review.snapshot().proposal, null)
})

test('describe validates clip IDs, time and composition', () => {
  const f = routeFixture()
  assert.match(f.routes['GET /api/describe'](null, new URLSearchParams('at=0')).text, /^At 00:00:00:00/)
  assert.throws(() => f.routes['GET /api/describe'](null, new URLSearchParams('ids=../x')), /comma-separated clip IDs/)
  assert.throws(() => f.routes['GET /api/describe'](null, new URLSearchParams('at=-1')), /timeline seconds/)
  assert.throws(() => f.routes['GET /api/describe'](null, new URLSearchParams('comp=k9')), /no composition k9/)
})

// ---------------------------------------------------------------- the agent contract

test('agents can read descriptions and propose, but cannot apply, discard or undo for the user', () => {
  assert.deepEqual(validateCall('reel_api', { method: 'GET', path: '/api/describe?ids=c1&at=2' }), { method: 'GET', path: '/api/describe?ids=c1&at=2' })
  assert.equal(validateCall('reel_api', { method: 'POST', path: '/api/assistant/propose', body: { ops: [] } }).path, '/api/assistant/propose')
  for (const route of ['/api/assistant/proposal/apply', '/api/assistant/proposal/discard', '/api/assistant/change/undo']) {
    assert.throws(() => validateCall('reel_api', { method: 'POST', path: route, body: {} }), /unavailable to agents/)
  }
})

test('the prompt adds the focus and preview guides only when the browser editor supplies them', () => {
  const plain = promptFor({ text: 'Cut it.', context: { selection: [] }, outline: { outline: 'x' } })
  assert.equal(plain.includes(FOCUS_GUIDE), false); assert.equal(plain.includes(REVIEW_GUIDE), false)
  assert.ok(plain.startsWith(`${INSTRUCTIONS}\n\n<immutable_reel_context>`), 'native requests keep the unchanged prompt')
  const browser = promptFor({ text: 'Cut it.', context: { review: true }, outline: { focus: 'Open: Main timeline' } })
  assert.ok(browser.startsWith(`${INSTRUCTIONS}\n${FOCUS_GUIDE}\n${REVIEW_GUIDE}\n\n<immutable_reel_context>`))
})

// ---------------------------------------------------------------- the actual server

async function freePort() {
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}

// The real server, bridge and sharing gate with a fake `claude` CLI on PATH. The fake agent
// runs a scripted list of reel_api calls and writes what it received to agent-log.json.
async function runningServer(t, steps, { tools = false, setup } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-review ')), bin = path.join(root, 'bin')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(bin)
  let initial = newProject('Review fixture')
  initial.tracks.find(track => track.id === 'V1').clips.push({ id: 'c1', kind: 'color', color: '#203040', start: 0, dur: 4 })
  if (setup) initial = setup(root, initial)
  fs.writeFileSync(path.join(root, 'reel.project.json'), JSON.stringify(initial))
  const log = path.join(root, 'agent-log.json'), script = path.join(root, 'agent.mjs')
  fs.writeFileSync(script, `let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const base=process.env.REEL_AGENT_ENDPOINT,id=process.env.REEL_AGENT_RUN_ID;const headers={authorization:'Bearer '+process.env.REEL_AGENT_RUN_TOKEN,'content-type':'application/json'};
const call=async(body)=>{const{callID}=await(await fetch(new URL('/v1/runs/'+id+'/calls',base),{method:'POST',headers,body:JSON.stringify(body)})).json();for(let i=0;i<400;i++){const r=await(await fetch(new URL('/v1/runs/'+id+'/calls/'+callID,base),{headers})).json();if(!r.pending){if(r.error)return{error:r.error};return r.result;}await new Promise(r=>setTimeout(r,20));}return{error:'Fixture tool timed out'}};
const results=[];const steps=${JSON.stringify(steps)};
for(const step of steps){if(step.waitFor){const fs=await import('node:fs');for(let i=0;i<1200&&!fs.existsSync(step.waitFor);i++)await new Promise(r=>setTimeout(r,25));results.push({waited:fs.existsSync(step.waitFor)});continue}const body=step.body&&JSON.parse(JSON.stringify(step.body).replace('"$created"',JSON.stringify(results.at(-1)?.created?.[0]??'')));results.push(await call({method:step.method,path:step.path,...(body?{body}:{})}));}
const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({prompt,results}));
console.log(JSON.stringify({type:'done',text:'Prepared the edit.'}));\n`)
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nif(process.argv[2]==='auth'&&process.argv[3]==='status')console.log(JSON.stringify({loggedIn:true,authMethod:'oauth',apiProvider:'anthropic'}));else import(${JSON.stringify(script)});\n`, { mode: 0o700 })
  const port = await freePort(), url = `http://127.0.0.1:${port}`
  // tools adds the real ffmpeg and ffprobe for processing jobs; the agent is always the fake CLI.
  const ffmpeg = tools ? path.dirname(execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' }).trim()) : null
  const child = spawn(process.execPath, [path.join(here, '../server.mjs'), '--root', root, '--port', String(port)], { env: { ...process.env, PATH: ffmpeg ? `${bin}:${ffmpeg}` : bin }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) } })
  await waitFor(async () => { if (child.exitCode !== null) assert.fail(output); try { return (await fetch(url + '/api/state')).ok } catch { return false } })
  let sharing
  const api = async (method, route, body) => {
    if (route === '/api/bridge/send') body = { ...body, sharing }
    const response = await fetch(url + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await api('POST', '/api/assistant/config', { provider: 'claude-code' })).status, 200)
  const review = (await api('GET', '/api/assistant/sharing')).body
  sharing = (await api('POST', '/api/assistant/sharing/grant', { reviewID: review.reviewID, sharing: fixtureSharing(review.scope.companion, review.scope.models) })).body.sharing
  const finish = async () => {
    await waitFor(async () => ['done', 'error'].includes((await api('GET', '/api/state')).body.assistant.state))
    return JSON.parse(fs.readFileSync(log, 'utf8'))
  }
  return { root, api, finish, output: () => output }
}

test('actual server preview mode refuses direct edits, shows the proposal and applies it as one undo step', async t => {
  const server = await runningServer(t, [
    { method: 'GET', path: '/api/outline' },
    { method: 'POST', path: '/api/ops', body: { ops: [{ op: 'add_title', track: 'V3', text: 'Direct title', dur: 2 }] } },
    { method: 'POST', path: '/api/assistant/propose', body: { ops: [{ op: 'add_title', track: 'V3', text: 'Previewed title', dur: 2 }], summary: 'Add a title' } },
    { method: 'POST', path: '/api/assistant/propose', body: { ops: [{ op: 'update', id: '$created', set: { opacity: 0.5 } }], summary: 'Fade it' } },
    { method: 'GET', path: '/api/describe?ids=c1&at=1' },
  ])
  const before = (await server.api('GET', '/api/project')).body
  const sent = await server.api('POST', '/api/bridge/send', { text: 'Add a faded title.', ids: ['c1'], comp: null, playhead: 1, review: true })
  assert.equal(sent.status, 200, JSON.stringify(sent))
  const agent = await server.finish()
  const completion = (await server.api('GET', '/api/state')).body.assistant
  assert.equal(completion.outcome, 'No project edits were applied during this request.', 'A staged preview is not a failed processing result')
  assert.ok(agent.prompt.includes(REVIEW_GUIDE)); assert.ok(agent.prompt.includes(FOCUS_GUIDE))
  assert.match(agent.prompt, /"review":true/)
  assert.match(agent.prompt, /c1 color \\"Color #203040\\" on V1 Video 1/, 'the run context describes the selected clip')
  assert.match(agent.results[0].focus, /Under the playhead/)
  assert.match(agent.results[1].error, /Preview changes is on/)
  assert.equal(agent.results[2].previewed, true); assert.deepEqual(agent.results[2].created, ['c2'])
  assert.equal(agent.results[3].ops, 2); assert.match(agent.results[3].outline, /c2 title "Previewed title"/)
  assert.match(agent.results[4].text, /c1 color "Color #203040"/)
  const unchanged = (await server.api('GET', '/api/project')).body
  assert.equal(unchanged.version, before.version); assert.deepEqual(unchanged.project, before.project)
  const state = (await server.api('GET', '/api/assistant/review')).body
  assert.equal(state.proposal.summary, 'Add a title; Fade it'); assert.equal(state.proposal.stale, false); assert.equal(state.proposal.ops.length, 2)
  const applied = await server.api('POST', '/api/assistant/proposal/apply', { id: state.proposal.id })
  assert.equal(applied.status, 200, JSON.stringify(applied)); assert.equal(applied.body.version, before.version + 1)
  const edited = (await server.api('GET', '/api/project')).body
  const title = edited.project.tracks.find(track => track.id === 'V3').clips[0]
  assert.equal(title.title.text, 'Previewed title'); assert.equal(title.opacity, 0.5)
  assert.equal(edited.activity.at(-1).who, 'agent')
  const undone = await server.api('POST', '/api/assistant/change/undo', { id: applied.body.change.id })
  assert.equal(undone.status, 200, JSON.stringify(undone))
  assert.deepEqual((await server.api('GET', '/api/project')).body.project, before.project)
  const redone = (await server.api('POST', '/api/undo', {})).body
  assert.equal(redone.project.tracks.find(track => track.id === 'V3').clips[0].title.text, 'Previewed title', 'the one-step undo is itself undoable')
})

test('actual server direct mode undoes a multi-edit request in one step, and refuses after a later edit', async t => {
  const server = await runningServer(t, [
    { method: 'POST', path: '/api/ops', body: { ops: [{ op: 'add_title', track: 'V3', text: 'First', dur: 2 }] } },
    { method: 'POST', path: '/api/ops', body: { ops: [{ op: 'update', id: 'c1', set: { opacity: 0.25 } }] } },
  ])
  const before = (await server.api('GET', '/api/project')).body
  await server.api('POST', '/api/bridge/send', { text: 'Add a title and dim the color.', ids: [], comp: null, playhead: 0 })
  const agent = await server.finish()
  assert.equal(agent.prompt.includes(REVIEW_GUIDE), false)
  assert.ok(agent.results.every(result => !result.error), JSON.stringify(agent.results))
  const state = await waitFor(async () => (await server.api('GET', '/api/assistant/review')).body.change)
  assert.equal(state.edits, 2); assert.equal(state.undoable, true)
  await server.api('POST', '/api/ops', { ops: [{ op: 'marker', t: 1, label: 'Later' }] })
  const refused = await server.api('POST', '/api/assistant/change/undo', { id: state.id })
  assert.equal(refused.status, 409); assert.match(refused.body.error, /changed after this assistant change/)
  await server.api('POST', '/api/undo', {})
  const undone = await server.api('POST', '/api/assistant/change/undo', { id: state.id })
  assert.equal(undone.status, 200, JSON.stringify(undone))
  assert.deepEqual((await server.api('GET', '/api/project')).body.project, before.project)
})

test('actual server returns write results without the whole project, so an agent undo cannot overflow its result', async t => {
  const server = await runningServer(t, [
    { method: 'POST', path: '/api/ops', body: { ops: [{ op: 'add_title', track: 'V3', text: 'Undone title', dur: 2 }] } },
    { method: 'POST', path: '/api/undo', body: {} },
  ])
  const before = (await server.api('GET', '/api/project')).body
  await server.api('POST', '/api/bridge/send', { text: 'Add a title, then undo it.', ids: [], comp: null, playhead: 0 })
  const agent = await server.finish()
  assert.ok(agent.results.every(result => !result.error), JSON.stringify(agent.results))
  assert.equal(Object.hasOwn(agent.results[1], 'project'), false)
  assert.equal(agent.results[1].version, before.version + 2)
  assert.deepEqual((await server.api('GET', '/api/project')).body.project, before.project)
})

test('actual server keeps an explicit main-timeline send on the main timeline after the editor reported a composition', async t => {
  const server = await runningServer(t, [{ method: 'GET', path: '/api/caps' }])
  assert.equal((await server.api('POST', '/api/ui-state', { openComp: 'k1', playhead: 0, selection: [] })).status, 200)
  await server.api('POST', '/api/bridge/send', { text: 'Describe the main timeline.', ids: [], comp: null, playhead: 0 })
  const agent = await server.finish()
  const context = JSON.parse(agent.prompt.match(/<immutable_reel_context>\n([\s\S]*?)\n<\/immutable_reel_context>/)[1]).context
  assert.equal(Object.hasOwn(context, 'comp'), false, JSON.stringify(context))
})

test('apply commits the ops, then runs each step in order at the current version and records one change', async () => {
  const f = routeFixture()
  f.project.assets['media/a.mp4'] = { duration: 6, hasVideo: true, hasAudio: true, width: 160, height: 90 }
  const before = f.project
  await f.routes['POST /api/assistant/propose']({ ops: [{ op: 'append', src: 'media/a.mp4', track: 'V1', dur: 4 }], summary: 'Add and steady' })
  const staged = await f.routes['POST /api/assistant/propose']({ steps: [
    { path: '/api/stabilize/render', body: { src: 'media/a.mp4', clip: 'c1', comp: null, zoom: 1.1 } },
    { path: '/api/retime', body: { src: 'media/a.mp4', clip: 'c1', comp: null, speed: 0.5, dur: 4 } },
  ] })
  assert.deepEqual(staged.steps.map(step => step.title), ['Stabilize (deshake render)', 'Slow motion at 50% with optical flow'])
  assert.match(staged.steps[0].lands, /Replaces the picture of a\.mp4 \(c1\) on V1 at 00:00:00:00/)
  assert.match(staged.steps[1].lands, /becomes 8 s long/)
  assert.equal(f.version, 3, 'proposing renders nothing and changes nothing')
  f.steps.push({ commit: [{ op: 'update', id: 'c1', set: { label: 'steadied' } }] }, { commit: [{ op: 'update', id: 'c1', set: { label: 'slowed' } }] })
  const { id } = f.review.snapshot().proposal
  const applied = await f.routes['POST /api/assistant/proposal/apply']({ id })
  assert.equal(applied.running, true); assert.equal(applied.steps, 2)
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(f.calls.map(call => [call.route, call.body.expectedVersion, call.body.wait]), [['/api/stabilize/render', 4, true], ['/api/retime', 5, true]])
  const state = f.review.snapshot()
  assert.equal(state.applying, null); assert.equal(state.change.edits, 3); assert.equal(state.change.undoable, true)
  f.routes['POST /api/assistant/change/undo']({ id: state.change.id })
  assert.equal(f.project, before, 'one undo removes the ops and every step')
})

test('a failing step stops the rest, keeps earlier edits undoable together and explains what did not run', async () => {
  const f = routeFixture()
  f.project.assets['media/a.mp4'] = { duration: 6, hasVideo: true, hasAudio: true }
  await f.routes['POST /api/assistant/propose']({ ops: [{ op: 'append', src: 'media/a.mp4', track: 'V1', dur: 4 }], steps: [
    { path: '/api/stabilize/render', body: { src: 'media/a.mp4', clip: 'c1' } },
    { path: '/api/retime', body: { src: 'media/a.mp4', clip: 'c1', speed: 0.5 } },
  ] })
  f.steps.push({ result: { state: 'failed', error: 'ffmpeg is missing' } })
  await f.routes['POST /api/assistant/proposal/apply']({ id: f.review.snapshot().proposal.id })
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.calls.length, 1)
  const state = f.review.snapshot()
  assert.match(state.applying.error, /Stabilize \(deshake render\) did not finish: ffmpeg is missing\. The remaining 1 step was not run\./)
  assert.equal(state.change.undoable, true); assert.equal(state.change.edits, 1)
})

test('a later proposal in the same request fills earlier steps from the project it would make', async () => {
  let request = { runId: 'r1' }
  const f = routeFixture({ call: () => request })
  f.project.assets['media/a.mp4'] = { duration: 8, hasVideo: true, hasAudio: false, width: 160, height: 90 }
  const step = { path: '/api/stabilize/render', body: { src: 'media/a.mp4', clip: 'c1', comp: null } }
  const first = await f.routes['POST /api/assistant/propose']({ ops: [{ op: 'append', src: 'media/a.mp4', track: 'V1', dur: 4, audio: false }], steps: [step], summary: 'Add and steady' })
  assert.match(first.steps[0].produces, /A steadied 4 s copy/)
  // The second call lengthens the clip; the step must now cover its 6 s source range.
  const second = await f.routes['POST /api/assistant/propose']({ ops: [{ op: 'trim', id: 'c1', edge: 'right', to: 6 }], summary: 'Longer' })
  assert.match(second.steps[0].produces, /A steadied 6 s copy/)
  const stored = f.review.proposal().steps[0]
  assert.deepEqual(stored.request, step.body, 'the agent\u2019s own request is kept')
  assert.deepEqual([stored.body.in, stored.body.dur], [0, 6])
  request = null
  await f.routes['POST /api/assistant/proposal/apply']({ id: f.review.snapshot().proposal.id })
  await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual([f.calls[0].body.in, f.calls[0].body.dur], [0, 6], 'Apply renders the clip\u2019s whole 6 s')
  // An explicit range that stops matching the clip is refused when proposed, not at Apply.
  request = { runId: 'r2' }
  await f.routes['POST /api/assistant/propose']({ ops: [{ op: 'append', src: 'media/a.mp4', track: 'V2', dur: 4, audio: false }], steps: [{ path: '/api/stabilize/render', body: { ...step.body, clip: 'c2', in: 0, dur: 4 } }], reset: true })
  await assert.rejects(f.routes['POST /api/assistant/propose']({ ops: [{ op: 'trim', id: 'c2', edge: 'right', to: 6 }] }), /Step 1 \(\/api\/stabilize\/render\): \/api\/stabilize\/render replaces clip c2 only with its complete source range/)
})

test('steps are checked against the previewed project before anything renders', async () => {
  const f = routeFixture()
  f.project.assets['media/a.mp4'] = { duration: 6, hasVideo: true, hasAudio: true }
  await assert.rejects(f.routes['POST /api/assistant/propose']({ steps: [{ path: '/api/stabilize/render', body: { src: 'media/a.mp4', clip: 'c9' } }] }), /Step 1 \(\/api\/stabilize\/render\): no clip c9/)
  await assert.rejects(f.routes['POST /api/assistant/propose']({ steps: [{ path: '/api/retime', body: { src: 'media/a.mp4', speed: 2 } }] }), /slow motion: speed 0\.05 to 0\.99/)
  await assert.rejects(f.routes['POST /api/assistant/propose']({ steps: [{ path: '/api/video/denoise', body: { clip: 'c1' } }] }), /needs comp/)
  await assert.rejects(f.routes['POST /api/assistant/propose']({ steps: [{ path: '/api/stabilize/render', body: { src: 'media/a.mp4', apply: false } }] }), /leave apply out/)
  assert.equal(f.review.snapshot().proposal, null)
})

const hasFFmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' }).trim() !== '' } catch { return false } })()
const synthetic = (root, initial) => {
  fs.mkdirSync(path.join(root, 'media'))
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(root, 'media', 'clip.mp4')])
  initial.assets['media/clip.mp4'] = { duration: 1, width: 160, height: 90, fps: 30, codec: 'h264', hasVideo: true, hasAudio: false }
  initial.tracks.find(track => track.id === 'V2').clips.push({ id: 'v1', kind: 'video', src: 'media/clip.mp4', start: 0, dur: 1, in: 0 })
  return initial
}

test('a background job that lands during a request makes its change undoable only step by step', { skip: !hasFFmpeg && 'ffmpeg is not installed' }, async t => {
  let marker
  const server = await runningServer(t, [
    { method: 'POST', path: '/api/ops', body: { ops: [{ op: 'add_title', track: 'V3', text: 'Agent title', dur: 1 }] } },
    { waitFor: '__MARKER__' },
    { method: 'POST', path: '/api/ops', body: { ops: [{ op: 'update', id: 'c1', set: { opacity: 0.5 } }] } },
  ].map(step => step.waitFor ? { waitFor: (marker = path.join(os.tmpdir(), `arya-review-marker-${process.pid}-${Date.now()}`)) } : step), { tools: true, setup: synthetic })
  t.after(() => fs.rmSync(marker, { force: true }))
  await server.api('POST', '/api/bridge/send', { text: 'Add a title and dim the color.', ids: [], comp: null, playhead: 0 })
  await waitFor(async () => (await server.api('GET', '/api/project')).body.project.tracks.find(track => track.id === 'V3').clips.length === 1)
  // The user starts a deshake render; its asset and placement commit outside any request.
  const job = await server.api('POST', '/api/stabilize/render', { src: 'media/clip.mp4', clip: 'v1', comp: null, wait: false })
  assert.equal(job.status, 200, JSON.stringify(job))
  const done = await waitFor(async () => { const value = (await server.api('GET', `/api/analysis/jobs/wait?id=${job.body.id}&timeout=2000`)).body; return ['done', 'failed', 'cancelled'].includes(value.state) ? value : false })
  assert.equal(done.state, 'done', JSON.stringify(done)); assert.equal(done.applied, true)
  fs.writeFileSync(marker, 'continue')
  await server.finish()
  const change = await waitFor(async () => (await server.api('GET', '/api/assistant/review')).body.change)
  assert.equal(change.undoable, false); assert.match(change.reason, /edited the project while the assistant change was being made/)
  const refused = await server.api('POST', '/api/assistant/change/undo', { id: change.id })
  assert.equal(refused.status, 409)
  const project = (await server.api('GET', '/api/project')).body.project
  assert.match(project.tracks.find(track => track.id === 'V2').clips[0].src, /^media\/stabilized\//, 'the user’s render stays')
})

test('the browser assistant proposes a stabilize step, the editor applies it, and one undo removes it', { skip: !hasFFmpeg && 'ffmpeg is not installed' }, async t => {
  const step = { path: '/api/stabilize/render', body: { src: 'media/clip.mp4', clip: 'v1', comp: null, zoom: 1.1 } }
  const server = await runningServer(t, [
    { method: 'POST', path: '/api/stabilize/render', body: step.body },
    { method: 'POST', path: '/api/assistant/propose', body: { steps: [{ path: '/api/files', body: {} }], summary: 'Not a step' } },
    { method: 'POST', path: '/api/assistant/propose', body: { steps: [{ path: '/api/stabilize/render', body: { src: '../outside.mp4', clip: 'v1', comp: null } }], summary: 'Outside' } },
    { method: 'POST', path: '/api/assistant/propose', body: { steps: [step], summary: 'Steady the clip' } },
  ], { tools: true, setup: synthetic })
  const before = (await server.api('GET', '/api/project')).body
  await server.api('POST', '/api/bridge/send', { text: 'Steady this clip.', ids: ['v1'], comp: null, playhead: 0, review: true })
  const agent = await server.finish()
  assert.match(agent.results[0].error, /Preview changes is on, so \/api\/stabilize\/render runs only when the user applies/)
  assert.match(agent.results[1].error, /Preview step paths are \/api\/stabilize\/render/)
  assert.match(agent.results[2].error, /Agent files must stay inside the project/, 'step bodies are still confined to the project')
  assert.equal(agent.results[3].error, undefined, JSON.stringify(agent.results[3]))
  assert.equal(agent.results[3].steps[0].title, 'Stabilize (deshake render)')
  assert.equal(fs.existsSync(path.join(server.root, 'media', 'stabilized')), false, 'nothing rendered before Apply')
  const { proposal } = (await server.api('GET', '/api/assistant/review')).body
  const applied = await server.api('POST', '/api/assistant/proposal/apply', { id: proposal.id })
  assert.equal(applied.status, 200, JSON.stringify(applied))
  const state = await waitFor(async () => { const value = (await server.api('GET', '/api/assistant/review')).body; return value.applying === null && value.change ? value : false }, 2400)
  assert.equal(state.change.undoable, true, JSON.stringify(state.change))
  const placed = (await server.api('GET', '/api/project')).body.project
  assert.match(placed.tracks.find(track => track.id === 'V2').clips[0].src, /^media\/stabilized\//)
  const undone = await server.api('POST', '/api/assistant/change/undo', { id: state.change.id })
  assert.equal(undone.status, 200, JSON.stringify(undone))
  assert.deepEqual((await server.api('GET', '/api/project')).body.project, before.project)
})

test('a user edit during a request makes its change undoable only step by step', async t => {
  let marker
  const server = await runningServer(t, [
    { method: 'POST', path: '/api/ops', body: { ops: [{ op: 'add_title', track: 'V3', text: 'Agent title', dur: 1 }] } },
    { waitFor: '__MARKER__' },
  ].map(step => step.waitFor ? { waitFor: (marker = path.join(os.tmpdir(), `arya-review-edit-${process.pid}-${Date.now()}`)) } : step))
  t.after(() => fs.rmSync(marker, { force: true }))
  await server.api('POST', '/api/bridge/send', { text: 'Add a title.', ids: [], comp: null, playhead: 0 })
  await waitFor(async () => (await server.api('GET', '/api/project')).body.project.tracks.find(track => track.id === 'V3').clips.length === 1)
  assert.equal((await server.api('POST', '/api/ops', { ops: [{ op: 'marker', t: 0.5, label: 'Mine' }] })).status, 200)
  fs.writeFileSync(marker, 'continue')
  await server.finish()
  const change = await waitFor(async () => (await server.api('GET', '/api/assistant/review')).body.change)
  assert.equal(change.undoable, false)
})

test('agents still see the project an interchange import preview would create', async t => {
  const server = await runningServer(t, [
    { method: 'POST', path: '/api/interchange/export', body: { format: 'otio', name: 'roundtrip' } },
    { method: 'POST', path: '/api/interchange/import', body: { path: 'renders/roundtrip.otio', apply: false } },
    { method: 'POST', path: '/api/ops', body: { ops: [{ op: 'marker', t: 1, label: 'Agent' }] } },
  ])
  await server.api('POST', '/api/bridge/send', { text: 'Preview the round trip.', ids: [], comp: null, playhead: 0 })
  const agent = await server.finish()
  assert.ok(agent.results.every(result => !result.error), JSON.stringify(agent.results))
  assert.equal(typeof agent.results[1].project, 'object', 'the parsed timeline stays in the preview result')
  assert.equal(Object.hasOwn(agent.results[2], 'project'), false)
})

test('Preview changes refuses saved transcript corrections, which have no preview or undo', async t => {
  const server = await runningServer(t, [
    { method: 'POST', path: '/api/transcript', body: { src: 'media/none.wav', locale: 'en-US', revision: 0, words: [] } },
  ])
  await server.api('POST', '/api/bridge/send', { text: 'Fix the transcript.', ids: [], comp: null, playhead: 0, review: true })
  const agent = await server.finish()
  assert.match(agent.results[0].error, /saved transcript corrections have no preview or undo/)
})

test('a new request keeps the pending preview, and a project change between one request’s proposals is refused', () => {
  const { state, review } = tracker()
  review.observe({ state: 'thinking', runId: 'r1' }, state.project)
  review.stage(review.propose({ runId: 'r1', ops: [{ op: 'add_color', color: '#000' }], summary: 'Black frame' }))
  state.version = 5
  assert.throws(() => review.propose({ runId: 'r1', ops: [{ op: 'add_color', color: '#fff' }] }), error => error.status === 409 && /earlier preview \(1 ops, 0 steps\)\. Send the complete edit again with reset:true/.test(error.message))
  assert.equal(review.propose({ runId: 'r1', ops: [{ op: 'add_color', color: '#fff' }], reset: true }).ops.length, 1)
  review.observe({ state: 'done', runId: 'r1' }, state.project)
  review.observe({ state: 'thinking', runId: 'r2' }, state.project)
  assert.equal(review.snapshot().proposal.summary, 'Black frame', 'the earlier preview survives a new request')
  review.stage(review.propose({ runId: 'r2', ops: [{ op: 'add_color', color: '#f00' }], summary: 'Red frame' }))
  assert.equal(review.snapshot().proposal.replaced, 'Black frame')
})

test('apply, discard and undo refuse a call made inside an assistant request, through the server’s own guard', async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const vm = await import('node:vm')
  const source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const guard = source.match(/^function assertAssistantPublication\(\) \{[^]*?^\}/m)
  assert.ok(guard, 'extract the actual assertAssistantPublication')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-guard-')), file = path.join(root, 'reel.project.json')
  try {
    fs.writeFileSync(file, 'text')
    const assistantCalls = new AsyncLocalStorage()
    const context = vm.createContext({ fs, FILE: file, lastText: 'text', version: 3, assistantCalls, processing: { current: () => undefined }, loadFromDisk() {} })
    vm.runInContext(`${guard[0]}\nthis.assertAssistantPublication = assertAssistantPublication`, context)
    let project = newProject('Guard'), version = 3
    const review = createAssistantReview({ getVersion: () => version, getEpoch: () => 1, getProject: () => project })
    const routes = assistantRoutes({ getProject: () => project, getVersion: () => version, getProjectGeneration: () => 1, getAssistantReview: () => review, assertCurrent: context.assertAssistantPublication,
      editOps: async ops => { project = applyOps(project, ops).project; version++; return { version } } }).routes
    await routes['POST /api/assistant/propose']({ ops: [{ op: 'add_color', color: '#000', start: 0, dur: 1 }] })
    const { id } = review.snapshot().proposal
    const call = { runId: 'agent-run', version: 3, assertCurrent() {}, acceptIdentity() {} }
    for (const [route, body] of [['POST /api/assistant/proposal/apply', { id }], ['POST /api/assistant/proposal/discard', { id }], ['POST /api/assistant/change/undo', { id: 'x' }]]) {
      await assert.rejects(assistantCalls.run(call, async () => routes[route](body)), error => error.status === 403 && /Only the editor/.test(error.message), route)
    }
    assert.equal(review.snapshot().proposal.id, id, 'the refused calls changed nothing')
    assert.equal((await routes['POST /api/assistant/proposal/apply']({ id })).applied, true, 'the same apply works from the editor')
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

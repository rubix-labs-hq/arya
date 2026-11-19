import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { newProject } from '../../core/project.js'
import { fixtureSharing } from './sharing-fixture.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const waitFor = async (predicate, limit = 400) => {
  for (let i = 0; i < limit; i++) { const value = await predicate(); if (value) return value; await sleep(25) }
  assert.fail('The server fixture did not reach the expected state.')
}

export const hasFFmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' }).trim() !== '' } catch { return false } })()

async function freePort() {
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}

/**
 * The real server, bridge and sharing gate on a temporary project, with a fake `claude` CLI on
 * PATH. The fake agent runs `steps` (a list of reel_api or reel_frame calls) on every request and
 * writes the prompt it received and each result to agent-log.json. `tools` adds the real ffmpeg.
 * `setup(root, project)` may add files and return the starting project. `env(root)` returns
 * variables the server process gets on top of this one's.
 */
export async function runningServer(t, steps = [], { tools = false, setup, env } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-server ')), bin = path.join(root, 'bin')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(bin)
  let initial = newProject('Server fixture')
  initial.tracks.find(track => track.id === 'V1').clips.push({ id: 'c1', kind: 'color', color: '#203040', start: 0, dur: 4 })
  if (setup) initial = setup(root, initial) ?? initial
  fs.writeFileSync(path.join(root, 'reel.project.json'), JSON.stringify(initial))
  const log = path.join(root, 'agent-log.json'), script = path.join(root, 'agent.mjs')
  fs.writeFileSync(script, `let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const base=process.env.REEL_AGENT_ENDPOINT,id=process.env.REEL_AGENT_RUN_ID;const headers={authorization:'Bearer '+process.env.REEL_AGENT_RUN_TOKEN,'content-type':'application/json'};
const call=async(body)=>{const{callID}=await(await fetch(new URL('/v1/runs/'+id+'/calls',base),{method:'POST',headers,body:JSON.stringify(body)})).json();for(let i=0;i<400;i++){const r=await(await fetch(new URL('/v1/runs/'+id+'/calls/'+callID,base),{headers})).json();if(!r.pending){if(r.error)return{error:r.error};return r.result??(r.image?{image:r.image.mediaType}:{});}await new Promise(r=>setTimeout(r,20));}return{error:'Fixture tool timed out'}};
const results=[];const steps=${JSON.stringify(steps)};
for(const step of steps){if(step.pause){await new Promise(r=>setTimeout(r,step.pause));results.push({paused:step.pause});continue}results.push(await call(step.frame?{frame:step.frame}:{method:step.method,path:step.path,...(step.body?{body:step.body}:{})}));}
const fs=await import('node:fs');fs.writeFileSync(${JSON.stringify(log)},JSON.stringify({prompt,results}));
console.log(JSON.stringify({type:'done',text:'Finished the fixture steps.'}));\n`)
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nif(process.argv[2]==='auth'&&process.argv[3]==='status')console.log(JSON.stringify({loggedIn:true,authMethod:'oauth',apiProvider:'anthropic'}));else import(${JSON.stringify(script)});\n`, { mode: 0o700 })
  const port = await freePort(), url = `http://127.0.0.1:${port}`
  const ffmpeg = tools ? path.dirname(execFileSync('/usr/bin/which', ['ffmpeg'], { encoding: 'utf8' }).trim()) : null
  const child = spawn(process.execPath, [path.join(here, '../../server.mjs'), '--root', root, '--port', String(port)], { env: { ...process.env, PATH: ffmpeg ? `${bin}:${ffmpeg}` : bin, ...(env ? env(root) : {}) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)) } })
  await waitFor(async () => { if (child.exitCode !== null) assert.fail(output); try { return (await fetch(url + '/api/state')).ok } catch { return false } })
  let sharing
  const api = async (method, route, body) => {
    if (route === '/api/bridge/send') body = { ...body, sharing }
    const response = await fetch(url + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  // Grants sharing for the fake agent, so a prompt can be sent. Tests that only call routes skip it.
  const approve = async () => {
    assert.equal((await api('POST', '/api/assistant/config', { provider: 'claude-code' })).status, 200)
    const review = (await api('GET', '/api/assistant/sharing')).body
    sharing = (await api('POST', '/api/assistant/sharing/grant', { reviewID: review.reviewID, sharing: fixtureSharing(review.scope.companion, review.scope.models) })).body.sharing
  }
  // Sends one prompt and returns {prompt, results} as the fake agent saw them, plus every phase published.
  const ask = async (text, body = {}) => {
    if (!sharing) await approve()
    fs.rmSync(log, { force: true })
    const phases = []
    let watching = true
    const watch = (async () => { while (watching) { try { const phase = (await api('GET', '/api/state')).body.assistant?.phase; if (phase && phases.at(-1) !== phase) phases.push(phase) } catch {} await sleep(15) } })()
    const sent = await api('POST', '/api/bridge/send', { text, ids: [], comp: null, playhead: 0, ...body })
    assert.equal(sent.status, 200, JSON.stringify(sent))
    await waitFor(async () => ['done', 'error'].includes((await api('GET', '/api/state')).body.assistant.state), 1200)
    watching = false; await watch
    const state = (await api('GET', '/api/state')).body.assistant
    assert.equal(state.state, 'done', `${state.text}\n${output}`)
    return { ...JSON.parse(fs.readFileSync(log, 'utf8')), phases, state }
  }
  return { root, url, api, ask, output: () => output }
}

/** The run context and outline the agent received in its prompt. */
export const promptContext = prompt => JSON.parse(prompt.match(/<immutable_reel_context>\n([\s\S]*?)\n<\/immutable_reel_context>/)[1])

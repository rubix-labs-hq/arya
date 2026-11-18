// Redo did nothing after "Undo this change". Seen on 2026-11-17: apply a preview, undo the change,
// then POST /api/redo twice left the project as it was, with nothing in the reply to say so. The
// undo was saved as a new forward edit, which empties the redo history.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createAssistantReview } from '../agent/assistant-review.mjs'
import { runningServer, waitFor } from './fixtures/running-server.mjs'

const titleOf = project => project.tracks.find(track => track.id === 'V3').clips[0]?.title?.text ?? null

async function appliedPreview(server, text = 'Previewed title') {
  const proposed = await server.api('POST', '/api/assistant/propose', { ops: [{ op: 'add_title', track: 'V3', text, dur: 2 }], summary: 'Add a title' })
  assert.equal(proposed.status, 200, JSON.stringify(proposed))
  const proposal = (await server.api('GET', '/api/assistant/review')).body.proposal
  const applied = await server.api('POST', '/api/assistant/proposal/apply', { id: proposal.id })
  assert.equal(applied.status, 200, JSON.stringify(applied))
  return applied.body.change
}

test('one Redo after "Undo this change" brings the whole change back, and a second Redo says nothing moved', async t => {
  const server = await runningServer(t)
  const first = (await server.api('GET', '/api/project')).body
  assert.deepEqual(first.history, { undo: 0, redo: 0 })
  await server.api('POST', '/api/ops', { ops: [{ op: 'marker', t: 1, label: 'Mine' }] })
  const before = (await server.api('GET', '/api/project')).body
  assert.deepEqual(before.history, { undo: 1, redo: 0 })
  const change = await appliedPreview(server)
  const applied = (await server.api('GET', '/api/project')).body
  assert.equal(titleOf(applied.project), 'Previewed title'); assert.deepEqual(applied.history, { undo: 2, redo: 0 })

  const undone = await server.api('POST', '/api/assistant/change/undo', { id: change.id })
  assert.equal(undone.status, 200, JSON.stringify(undone))
  const afterUndo = (await server.api('GET', '/api/project')).body
  assert.deepEqual(afterUndo.project, before.project)
  assert.deepEqual(afterUndo.history, { undo: 1, redo: 1 }, 'the change waits in the redo history and the user edit before it is still one Undo away')
  assert.deepEqual(undone.body.history, { undo: 1, redo: 1 })
  assert.equal((await server.api('GET', '/api/assistant/review')).body.change, null)

  const redo = (await server.api('POST', '/api/redo', {})).body
  assert.equal(redo.moved, true); assert.equal(redo.version, afterUndo.version + 1)
  assert.equal(titleOf(redo.project), 'Previewed title'); assert.deepEqual(redo.project, applied.project)
  assert.deepEqual(redo.history, { undo: 2, redo: 0 })
  // The change is the latest one again, with its own identifier, and can be undone in one step again.
  const back = (await server.api('GET', '/api/assistant/review')).body.change
  assert.equal(back.id, change.id); assert.equal(back.undoable, true)

  const again = (await server.api('POST', '/api/redo', {})).body
  assert.equal(again.moved, false); assert.equal(again.version, redo.version); assert.deepEqual(again.history, { undo: 2, redo: 0 })
  assert.deepEqual(again.project, redo.project)

  // Toolbar Undo after the Redo returns the project from before the change, then the user's own edit.
  const step = (await server.api('POST', '/api/undo', {})).body
  assert.equal(step.moved, true); assert.deepEqual(step.project, before.project); assert.deepEqual(step.history, { undo: 1, redo: 1 })
  const mine = (await server.api('POST', '/api/undo', {})).body
  assert.deepEqual(mine.project, first.project); assert.deepEqual(mine.history, { undo: 0, redo: 2 })
  const nothing = (await server.api('POST', '/api/undo', {})).body
  assert.equal(nothing.moved, false); assert.equal(nothing.version, mine.version)
})

test('the change can be undone again after Redo, and the preview outcome follows it', async t => {
  const server = await runningServer(t, [{ method: 'POST', path: '/api/assistant/propose', body: { ops: [{ op: 'add_title', track: 'V3', text: 'From a request', dur: 2 }], summary: 'Add a title' } }])
  const outcome = async () => (await server.api('GET', '/api/state')).body.assistant.outcome
  await server.ask('Add a title.', { review: true })
  const proposal = (await server.api('GET', '/api/assistant/review')).body.proposal
  const change = (await server.api('POST', '/api/assistant/proposal/apply', { id: proposal.id })).body.change
  assert.equal(await outcome(), 'You applied the preview. Use Undo this change to remove it.')
  await server.api('POST', '/api/assistant/change/undo', { id: change.id })
  assert.equal(await outcome(), 'You undid the applied preview.')
  assert.equal((await server.api('POST', '/api/redo', {})).body.moved, true)
  assert.equal(await outcome(), 'You applied the preview. Use Undo this change to remove it.', 'the request no longer says its preview was undone')
  const second = await server.api('POST', '/api/assistant/change/undo', { id: change.id })
  assert.equal(second.status, 200, JSON.stringify(second))
  assert.equal(titleOf((await server.api('GET', '/api/project')).body.project), null)
  assert.equal(await outcome(), 'You undid the applied preview.')
})

test('a new edit after "Undo this change" drops the redo, as after any undo', async t => {
  const server = await runningServer(t)
  const change = await appliedPreview(server)
  await server.api('POST', '/api/assistant/change/undo', { id: change.id })
  await server.api('POST', '/api/ops', { ops: [{ op: 'marker', t: 2, label: 'After' }] })
  const redo = (await server.api('POST', '/api/redo', {})).body
  assert.equal(redo.moved, false); assert.deepEqual(redo.history, { undo: 1, redo: 0 })
  assert.equal((await server.api('GET', '/api/assistant/review')).body.change, null)
})

test('when the project from before the change has left the undo history, the change is still undone', async t => {
  const server = await runningServer(t)
  const before = (await server.api('GET', '/api/project')).body
  const change = await appliedPreview(server)
  const edited = (await server.api('GET', '/api/project')).body.project
  const state = await waitFor(async () => (await server.api('GET', '/api/assistant/review')).body.change)
  assert.equal(state.undoable, true)
  // The history holds 200 projects. 200 more edits push out the oldest, the one from before the change.
  for (let i = 0; i < 200; i++) assert.equal((await server.api('POST', '/api/ops', { ops: [{ op: 'marker', t: 3, label: `m${i}` }] })).status, 200)
  for (let i = 0; i < 200; i++) assert.equal((await server.api('POST', '/api/undo', {})).body.moved, true)
  assert.deepEqual((await server.api('GET', '/api/project')).body.project, edited)
  const trimmed = (await server.api('GET', '/api/project')).body
  assert.deepEqual(trimmed.history, { undo: 0, redo: 200 }, 'the oldest entry, the project before the change, was dropped')
  const undone = await server.api('POST', '/api/assistant/change/undo', { id: change.id })
  assert.equal(undone.status, 200, JSON.stringify(undone))
  const after = (await server.api('GET', '/api/project')).body
  assert.deepEqual(after.project, before.project)
  assert.deepEqual(after.history, { undo: 1, redo: 0 }, 'it fell back to a forward edit: Undo brings the change back and there is nothing to redo')
  assert.equal(titleOf((await server.api('POST', '/api/undo', {})).body.project), 'Previewed title')
})

test('project events and the first event of a connection carry the history depths and the server session', async t => {
  const server = await runningServer(t)
  const project = (await server.api('GET', '/api/project')).body
  assert.match(project.session.id, /^[0-9a-f-]{36}$/); assert.ok(Math.abs(Date.now() - project.session.startedAt) < 120000)
  assert.deepEqual((await server.api('GET', '/api/project')).body.session, project.session, 'one session for the life of the server')
  const controller = new AbortController()
  t.after(() => controller.abort())
  const response = await fetch(`${server.url}/api/events?role=ui`, { signal: controller.signal })
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let text = ''
  const event = async name => {
    const pattern = new RegExp(`event: ${name}\\ndata: (.*)\\n\\n`)
    for (;;) {
      const match = text.match(pattern)
      if (match) { text = text.slice(match.index + match[0].length); return JSON.parse(match[1]) }
      const { value, done } = await reader.read()
      if (done) assert.fail(`no ${name} event`)
      text += decoder.decode(value, { stream: true })
    }
  }
  const hello = await event('hello')
  assert.deepEqual(hello.session, project.session); assert.deepEqual(hello.history, { undo: 0, redo: 0 }); assert.equal(hello.version, project.version)
  await server.api('POST', '/api/ops', { ops: [{ op: 'marker', t: 1, label: 'One' }] })
  assert.deepEqual((await event('project')).history, { undo: 1, redo: 0 })
  await server.api('POST', '/api/undo', {})
  assert.deepEqual((await event('project')).history, { undo: 0, redo: 1 })
  // A change on disk is a project event too.
  const file = path.join(server.root, 'reel.project.json'), disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  disk.name = 'Renamed on disk'; fs.writeFileSync(file, JSON.stringify(disk))
  const reloaded = await event('project')
  assert.equal(reloaded.who, 'disk'); assert.equal(typeof reloaded.history.undo, 'number'); assert.equal(typeof reloaded.history.redo, 'number')
})

test('the review store brings an undone change back only for the same project object and epoch', () => {
  const before = { name: 'before' }, after = { name: 'after' }
  let project = before, version = 1, epoch = 0
  const seen = [], restored = []
  const review = createAssistantReview({ getVersion: () => version, getEpoch: () => epoch, getProject: () => project, onChange: value => seen.push(value), onRestore: change => restored.push(change.kind) })
  const apply = () => { review.beginApply({ id: 'p1', summaries: ['x'], steps: [] }, project); project = after; version++; review.commitBy({ applyId: 'p1' }); return review.finishApply(project) }
  const change = apply()
  const undo = () => { project = before; version++; review.commitBy(undefined); review.undone(change.id) }
  undo()
  assert.equal(review.snapshot().change, null)
  // A commit that lands on some other project leaves it gone.
  project = { name: 'other' }; version++; review.commitBy(undefined)
  assert.equal(review.snapshot().change, null); assert.deepEqual(restored, [])
  // Redo puts the same object back.
  project = after; version++; review.commitBy(undefined)
  assert.equal(review.snapshot().change.id, change.id); assert.equal(review.snapshot().change.undoable, true); assert.deepEqual(restored, ['preview'])
  assert.equal(seen.at(-1).change.id, change.id, 'the page is told')
  // An equal copy is not the same project, and neither is the same object after the project was replaced.
  undo()
  project = structuredClone(after); version++; review.commitBy(undefined)
  assert.equal(review.snapshot().change, null)
  epoch++; project = after; version++; review.commitBy(undefined)
  assert.equal(review.snapshot().change, null)
  epoch--; project = after; version++; review.commitBy(undefined)
  assert.equal(review.snapshot().change, null, 'a replaced project forgets the undone change for good')
  // A newer change wins over an older undone one.
  const store = createAssistantReview({ getVersion: () => version, getEpoch: () => epoch, getProject: () => project })
  project = before
  store.beginApply({ id: 'p1', summaries: ['x'], steps: [] }, project); project = after; version++; store.commitBy({ applyId: 'p1' })
  const older = store.finishApply(project)
  project = before; version++; store.commitBy(undefined); store.undone(older.id)
  const next = { name: 'next' }
  store.beginApply({ id: 'p2', summaries: ['y'], steps: [] }, project); project = next; version++; store.commitBy({ applyId: 'p2' })
  const newer = store.finishApply(project)
  project = after; version++; store.commitBy(undefined)
  assert.equal(store.snapshot().change.id, newer.id)
})

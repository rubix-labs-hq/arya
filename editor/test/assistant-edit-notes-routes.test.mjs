import assert from 'node:assert/strict'
import test from 'node:test'
import { newProject } from '../core/project.js'
import { runningServer } from './fixtures/running-server.mjs'

// The notes of core/edit-notes.js as the real server returns them: beside the log of an edit and
// beside the outline of a preview, for the user's editor and for an agent's tool result alike.
const vertical = (root, initial) => {
  const project = newProject('Vertical', { width: 1080, height: 1920 })
  project.tracks.find(track => track.id === 'V1').clips.push({ id: 'c1', kind: 'color', color: '#203040', start: 0, dur: 6 })
  return project
}
const wide = { op: 'add_title', text: 'THE LONG ROAD TO THE NORTHERN LIGHTHOUSE', track: 'V3', start: 0, dur: 3, title: { size: 120 } }

test('POST /api/ops returns notes beside the log and writes none of them to the activity list', async t => {
  const server = await runningServer(t, [], { setup: vertical })
  const before = (await server.api('GET', '/api/project')).body
  const edit = await server.api('POST', '/api/ops', { ops: [wide, { op: 'add_title', text: 'Second', track: 'V3', start: 1, dur: 3 }], who: 'you', summary: 'Two titles' })
  assert.equal(edit.status, 200, JSON.stringify(edit.body))
  const notes = edit.body.notes
  assert.ok(Array.isArray(notes), JSON.stringify(Object.keys(edit.body)))
  assert.ok(notes.some(note => /^c2 title is about \d+ units wide .* the frame is 607 units wide\. It does not wrap\./.test(note)), notes.join('\n'))
  assert.ok(notes.some(note => /c3 is hidden under c2 on V3 from 1s to 3s/.test(note)), notes.join('\n'))
  assert.deepEqual(edit.body.log.filter(line => /units wide|hidden under/.test(line)), [], 'the log keeps its own lines')
  const after = (await server.api('GET', '/api/project')).body
  assert.equal(after.version, before.version + 1)
  assert.equal(after.activity.at(-1).text, 'Two titles', 'the activity line is the summary, as before')
  assert.ok(after.activity.every(entry => !/units wide|hidden under/.test(entry.text)))
  // An edit with nothing to note has no notes field at all.
  const plain = await server.api('POST', '/api/ops', { ops: [{ op: 'update', id: 'c1', set: { opacity: 0.5 } }] })
  assert.equal(plain.status, 200, JSON.stringify(plain.body))
  assert.equal(Object.hasOwn(plain.body, 'notes'), false)
  assert.deepEqual(Object.keys(plain.body).sort(), ['created', 'log', 'project', 'version'])
})

test('a preview reply carries notes for the whole preview and says what still shows the saved project', async t => {
  const server = await runningServer(t, [
    { method: 'POST', path: '/api/assistant/propose', body: { ops: [wide], summary: 'Add a title' } },
    { method: 'POST', path: '/api/assistant/propose', body: { ops: [{ op: 'captions', items: [{ t: 0, end: 2, text: 'Hello there' }], burnIn: true, style: { highlight: '#00ff00' } }], summary: 'Captions' } },
    { method: 'GET', path: '/api/outline' },
  ], { setup: vertical })
  const before = (await server.api('GET', '/api/project')).body
  const agent = await server.ask('Add a title and captions.', { review: true })
  const [first, second, outline] = agent.results
  assert.equal(first.previewed, true, JSON.stringify(first))
  assert.match(first.note, /^Not applied\. The user reviews this preview and applies or discards it\. Steps render only after the user applies\./)
  assert.match(first.note, /reel_frame now shows this preview: the project with every op of the preview applied, without saving it\. Check a frame of what you changed before you reply\./)
  assert.match(first.note, /GET \/api\/outline and GET \/api\/describe still show the saved project, not this preview/)
  assert.ok(first.notes.some(note => /^c2 title is about \d+ units wide/.test(note)), JSON.stringify(first.notes))
  // The second call adds to the same preview, and its notes cover both calls.
  assert.equal(second.ops, 2)
  assert.ok(second.notes.some(note => /^c2 title is about/.test(note)), JSON.stringify(second.notes))
  assert.ok(second.notes.some(note => /style\.highlight on C1 is not a caption style option and draws nothing\. Use highlightColor, not highlight\./.test(note)), JSON.stringify(second.notes))
  // What the note says is so: the outline the agent reads afterwards is the saved project.
  assert.doesNotMatch(outline.outline, /THE LONG ROAD/)
  assert.match(second.outline, /THE LONG ROAD/)
  const unchanged = (await server.api('GET', '/api/project')).body
  assert.equal(unchanged.version, before.version)
})

test('an agent edit returns its notes in the tool result', async t => {
  const server = await runningServer(t, [
    { method: 'POST', path: '/api/ops', body: { ops: [{ op: 'speed', id: 'c1', speed: 1.1 }], summary: 'Speed up' } },
  ], { setup: vertical })
  const agent = await server.ask('Make it shorter.')
  assert.deepEqual(agent.results[0].notes, ['c1 now plays at 1.1x (was 1x): 6s became 5.45s.'], JSON.stringify(agent.results[0]))
  assert.equal(Object.hasOwn(agent.results[0], 'project'), false)
})

test('the project event of an edit carries its notes, and an edit with none has no notes field', async t => {
  const server = await runningServer(t, [], { setup: vertical })
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
  await event('hello')
  const edit = await server.api('POST', '/api/ops', { ops: [wide], who: 'agent', summary: 'Wide title' })
  const noted = await event('project')
  assert.deepEqual(noted.notes, edit.body.notes)
  assert.ok(noted.notes.some(note => /^c2 title is about \d+ units wide/.test(note)), JSON.stringify(noted.notes))
  await server.api('POST', '/api/ops', { ops: [{ op: 'update', id: 'c1', set: { opacity: 0.5 } }] })
  assert.equal(Object.hasOwn(await event('project'), 'notes'), false)
})

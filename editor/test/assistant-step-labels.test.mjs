import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { READS, WRITES } from '../agent/protocol.mjs'
import { progressLabel, stepLabel, waitingAfter } from '../agent/step-labels.mjs'

// The phase the assistant panel prints when nothing has arrived for a while. Each tool step is
// named from the call, so a long wait says what the editor was last doing.
test('a tool step is named from its route, a count and a time', () => {
  const doing = event => stepLabel(event).doing
  assert.equal(doing({ method: 'POST', path: '/api/ops', body: { ops: [{}, {}, {}] } }), 'Applying 3 edits')
  assert.equal(doing({ method: 'POST', path: '/api/ops', body: { ops: [{}] } }), 'Applying 1 edit')
  assert.equal(doing({ method: 'POST', path: '/api/assistant/propose', body: { ops: Array(12).fill({}) } }), 'Preparing a preview of 12 edits')
  assert.equal(doing({ method: 'POST', path: '/api/assistant/propose', body: { ops: [{}], steps: [{}, {}] } }), 'Preparing a preview of 1 edit and 2 processing steps')
  assert.equal(doing({ method: 'POST', path: '/api/assistant/propose', body: { steps: [{}] } }), 'Preparing a preview of 1 processing step')
  assert.equal(doing({ frame: { at: 12.44, width: 640 } }), 'Rendering a frame at 12.4s')
  assert.equal(doing({ frame: { at: 0 } }), 'Rendering a frame at 0s')
  assert.equal(doing({ frame: { src: 'refs/private name.png' } }), 'Opening a reference image')
  assert.equal(doing({ method: 'GET', path: '/api/transcript?src=media%2Fclient%20interview.mp4&offset=0' }), 'Reading the transcript')
  assert.equal(doing({ method: 'GET', path: '/api/outline' }), 'Reading the project outline')
  assert.equal(doing({ method: 'GET', path: '/api/project' }), 'Reading the project')
  assert.equal(doing({ method: 'GET', path: '/api/jobs/wait?id=j1&timeout=20000' }), 'Waiting for a processing job')
  assert.equal(doing({ method: 'POST', path: '/api/analyze', body: { kind: 'loudness', src: 'media/a.wav' } }), 'Measuring loudness')
  assert.equal(doing({ method: 'POST', path: '/api/analyze', body: { kind: 'silence' } }), 'Finding silence')
  assert.equal(doing({ method: 'POST', path: '/api/analyze', body: { kind: 'constructor' } }), 'Running analyze')
  assert.equal(doing({ method: 'POST', path: '/api/export', body: { name: 'client-cut' } }), 'Starting an export')
  assert.deepEqual(stepLabel({ method: 'POST', path: '/api/audio/measure-mix', body: { from: 0, to: 12 } }), { doing: 'Measuring the mix', done: 'started measuring the mix' })
  assert.equal(doing({ method: 'POST', path: '/api/audio/loudnorm', body: { src: 'media/a.wav' } }), 'Running audio loudnorm')
  assert.equal(doing({ method: 'POST', path: '/api/captions/from-transcript' }), 'Running captions from transcript')
  assert.deepEqual(stepLabel({ method: 'POST', path: '/api/ops', body: { ops: [{}, {}] } }), { doing: 'Applying 2 edits', done: 'applied 2 edits' })
})

test('every route an agent may call has a step name with no request text in it', () => {
  const secret = 'PRIVATE-NAME'
  for (const [method, routes] of [['GET', READS], ['POST', WRITES]]) for (const route of routes) {
    const label = stepLabel({ method, path: `${route}?src=${secret}`, body: { src: secret, name: secret, text: secret, summary: secret, ops: [{ op: 'add_title', text: secret }], steps: [{ path: '/api/retime', body: { src: secret } }] } })
    for (const text of [label.doing, label.done, waitingAfter(label), waitingAfter(label, true)]) {
      assert.ok(text && text.length <= 130, `${route}: ${text}`)
      assert.doesNotMatch(text, /PRIVATE|\/|\?|\.$/, `${route}: ${text}`)
    }
    assert.match(label.doing, /^[A-Z]/); assert.match(label.done, /^[a-z]/)
  }
  // A call that is not a valid tool call still gets a name instead of an error.
  for (const event of [null, {}, { method: 'DELETE', path: '/api/ops' }, { path: 7 }, { frame: {} }, { method: 'GET', path: '/api/' }]) assert.ok(stepLabel(event).doing)
  assert.equal(stepLabel({ frame: { at: 'soon' } }).doing, 'Rendering a frame')
})

test('the wait after a step says which step it follows, and a progress label is one bounded line', () => {
  const edits = stepLabel({ method: 'POST', path: '/api/ops', body: { ops: [{}, {}] } })
  assert.equal(waitingAfter(edits), 'Waiting for the agent’s next step after it applied 2 edits')
  assert.equal(waitingAfter(edits, true), 'Waiting for the agent’s next step after a step that failed: applying 2 edits')
  assert.equal(progressLabel('  Thinking\n\tabout it\u0007  '), 'Thinking about it')
  assert.equal(progressLabel('x'.repeat(200)).length, 80)
  assert.equal(progressLabel(undefined), ''); assert.equal(progressLabel({ label: 'x' }), '')
})

test('the assistant publishes the step names, keeps the route out of the phase and accepts progress events', () => {
  const source = fs.readFileSync(new URL('../agent/browser-assistant.mjs', import.meta.url), 'utf8')
  assert.match(source, /const label = stepLabel\(event\)\n\s+publish\(\{ state: 'working', phase: label\.doing \}\)/)
  assert.match(source, /publish\(\{ state: 'thinking', phase: waitingAfter\(label, Boolean\(reply\.error\)\) \}\)/)
  assert.doesNotMatch(source, /Requested route:/)
  assert.match(source, /event\.type === 'progress'/)
  // The panel ends the sentence itself: "Last confirmed stage: <phase>."
  const panel = fs.readFileSync(new URL('../web/ui/assistant-activity.js', import.meta.url), 'utf8')
  assert.match(panel, /Last confirmed stage: \$\{/)
})

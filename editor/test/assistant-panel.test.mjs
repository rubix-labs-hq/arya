import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOps, newProject } from '../core/project.js'
import { assistantPanel } from '../web/ui/assistant-panel.js'
import { assistantSuggestions } from '../core/assistant-suggestions.js'

const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const nodes = value => value && typeof value === 'object' ? [value, ...flatten(value.props?.children).flatMap(nodes)] : []
const text = value => flatten(value?.props?.children).map(child => typeof child === 'object' ? text(child) : String(child)).join(' ').replace(/\s+/g, ' ').trim()
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label)

function interview({ seconds = 46, width = 1920, height = 1080 } = {}) {
  const p = newProject('Synthetic interview', { width, height })
  p.assets['media/a.mp4'] = { duration: seconds, width, height, hasVideo: true, hasAudio: true }
  p.assets['media/b.mp4'] = { duration: 12, width, height, hasVideo: true, hasAudio: false }
  return applyOps(p, [
    { op: 'append', src: 'media/a.mp4', track: 'V1', dur: Math.min(seconds, 20) },
    { op: 'append', src: 'media/b.mp4', track: 'V1', dur: 6 },
    { op: 'add_title', text: 'Opening', track: 'V3', start: 0, dur: 3 },
  ]).project
}

test('selection suggestions match what is selected', () => {
  const p = interview()
  const ids = suggestions => suggestions.map(item => item.id)
  assert.deepEqual(ids(assistantSuggestions(p, { selection: ['c1', 'c2'] })), ['match', 'silences-selection', 'clean-audio', 'explain-selection'])
  assert.deepEqual(ids(assistantSuggestions(p, { selection: ['c2'] })), ['grade-shot', 'explain-selection'], 'silent footage offers no sound fixes')
  assert.deepEqual(ids(assistantSuggestions(p, { selection: ['c3'] })), ['animate-title', 'explain-selection'], 'a title is not graded or mixed')
  assert.match(assistantSuggestions(p, { selection: ['c1', 'c2', 'tr:c2'] })[0].prompt, /Grade the 2 selected shots/)
})

test('timeline suggestions follow the footage, format and captions', () => {
  const short = assistantSuggestions(interview(), {}).map(item => item.label)
  assert.deepEqual(short, ['Cut the silences', 'Grade these to match', 'Make a 9:16 version', 'Add captions'])
  const long = assistantSuggestions(interview({ seconds: 600, width: 1080, height: 1920 }), {}).map(item => item.label)
  assert.deepEqual(long, ['Cut the silences', 'Make three 30-second shorts', 'Grade these to match', 'Add captions'])
  const empty = newProject('Empty'); empty.assets['media/a.mp4'] = { hasVideo: true, duration: 10 }
  assert.deepEqual(assistantSuggestions(empty, {}).map(item => item.id), ['rough-cut'])
  assert.deepEqual(assistantSuggestions(newProject('Nothing'), {}), [])
  assert.deepEqual(assistantSuggestions(null, {}), [])
  for (const item of [...assistantSuggestions(interview(), {}), ...assistantSuggestions(interview(), { selection: ['c1'] })]) {
    assert.ok(item.prompt.length > 20 && !item.prompt.includes('—'), item.prompt)
  }
})

test('focus names the timeline, playhead timecode and visible layers under it', () => {
  const p = interview()
  assert.deepEqual(assistantPanel.focus(p, { playhead: 1 }), { scope: 'Main timeline', time: '00:00:01:00', under: ['Opening', 'a.mp4'] })
  assert.deepEqual(assistantPanel.focus(p, { playhead: NaN }).time, 'unavailable')
  assert.deepEqual(assistantPanel.focus(null, {}), { scope: 'No project', time: '', under: [] })
})

test('a preview lists each changed layer with readable before and after values', () => {
  const p = interview()
  const proposal = { id: 'p1', baseVersion: 3, at: 1, summary: 'Warm the interview', stale: false, ops: [
    { op: 'update', id: 'c1', set: { grade: { exposure: 0.2, look: 'warm' } } },
    { op: 'add_title', text: 'Dana Ruiz', track: 'V3', start: 5, dur: 3 },
  ] }
  const changes = assistantPanel.previewChanges(p, proposal)
  assert.deepEqual(changes.layers.map(layer => [layer.name, layer.status]), [['a.mp4', 'changed'], ['Dana Ruiz', 'added']])
  assert.deepEqual(changes.layers[0].changes.map(change => [change.property, change.before, change.after]), [['grade.exposure', 'Absent', '0.2'], ['grade.look', 'Absent', '"warm"']])
  assert.deepEqual(changes.settings, [], 'track reordering from an added clip is not listed as a setting')
  const calls = []
  const tree = assistantPanel.PreviewCard({ proposal, project: p, version: 3, running: false, busy: '', onApply: () => calls.push('apply'), onDiscard: () => calls.push('discard') })
  assert.match(text(tree), /Apply changes 2 layers ?\. Nothing has changed yet ?\./)
  assert.equal(button(tree, 'Apply').props.disabled, false)
  button(tree, 'Apply').props.onClick(); button(tree, 'Discard').props.onClick()
  assert.deepEqual(calls, ['apply', 'discard'])
})

test('stale, failing, running and new-media previews are explained and cannot apply when unsafe', () => {
  const p = interview()
  const proposal = { id: 'p1', baseVersion: 3, at: 1, summary: '', stale: false, ops: [{ op: 'update', id: 'missing', set: { opacity: 0.5 } }] }
  const failing = assistantPanel.PreviewCard({ proposal, project: p, version: 3, running: false, busy: '' })
  assert.match(text(failing), /cannot be applied: no clip missing/); assert.equal(button(failing, 'Apply').props.disabled, true)
  const stale = assistantPanel.PreviewCard({ proposal: { ...proposal, ops: [{ op: 'update', id: 'c1', set: { opacity: 0.5 } }] }, project: p, version: 4, running: false, busy: '' })
  assert.match(text(stale), /project changed after this preview/); assert.equal(button(stale, 'Apply').props.disabled, true)
  const running = assistantPanel.PreviewCard({ proposal: { ...proposal, ops: [{ op: 'update', id: 'c1', set: { opacity: 0.5 } }] }, project: p, version: 3, running: true, busy: '' })
  assert.equal(button(running, 'Apply').props.disabled, true)
  const media = assistantPanel.previewChanges(p, { ...proposal, ops: [{ op: 'append', src: 'media/new.mp4', track: 'V2' }], assets: { 'media/new.mp4': { duration: 2, hasVideo: true } } })
  assert.equal(media.layers[0].status, 'added')
})

test('the change bar offers one-step undo only when the change can be undone whole', () => {
  let undone = 0
  assert.equal(assistantPanel.ChangeBar({ change: { undoable: false, edits: 2 }, onUndo: () => undone++ }), null)
  const bar = assistantPanel.ChangeBar({ change: { undoable: true, kind: 'request', edits: 3 }, busy: '', onUndo: () => undone++ })
  assert.match(text(bar), /The last request made 3 edits\./)
  button(bar, 'Undo this change').props.onClick()
  assert.equal(undone, 1)
  assert.match(text(assistantPanel.ChangeBar({ change: { undoable: true, kind: 'preview', edits: 1 } })), /Applied the assistant preview/)
})

test('a preview with processing steps lists what each renders and where it lands, and applying shows progress or the failure', () => {
  const p = interview()
  const proposal = { id: 'p2', baseVersion: 3, at: 1, summary: 'Steady the interview', stale: false, ops: [], steps: [
    { path: '/api/stabilize/render', body: { src: 'media/a.mp4', clip: 'c1' }, preview: { title: 'Stabilize (deshake render)', produces: 'A steadied 20 s copy of a.mp4 in media/stabilized.', lands: 'Replaces the picture of a.mp4 (c1) on V1 at 00:00:00:00. Timing stays the same.' } },
  ] }
  const tree = assistantPanel.PreviewCard({ proposal, project: p, version: 3, running: false, busy: '', onApply: () => {}, onDiscard: () => {} })
  assert.match(text(tree), /Apply runs 1 processing step ?\. Nothing has changed yet and nothing renders until you apply ?\./)
  const steps = nodes(tree).find(node => node.props?.class === 'assistant-preview-steps')
  assert.match(text(steps), /Stabilize \(deshake render\) Produces A steadied 20 s copy of a\.mp4 in media\/stabilized\. Lands Replaces the picture of a\.mp4 \(c1\)/)
  assert.equal(button(tree, 'Apply').props.disabled, false)
  const running = assistantPanel.ApplyingCard({ applying: { id: 'p2', summary: 'Steady the interview', total: 2, index: 1, title: 'Slow motion at 50% with optical flow', finished: false, error: '' } })
  assert.match(text(running), /Applying the preview Steady the interview Step 2 of 2: Slow motion at 50% with optical flow/)
  assert.match(text(running), /Wait for it to finish before editing: a change to the project now stops this step/)
  assert.doesNotMatch(text(running), /keep editing/, 'a user edit fails the running step’s version check')
  let dismissed = 0
  const failed = assistantPanel.ApplyingCard({ applying: { id: 'p2', summary: 'Steady the interview', total: 2, index: 0, title: 'Stabilize', finished: true, error: 'Stabilize did not finish: ffmpeg failed.' }, onDismiss: () => dismissed++ })
  assert.match(text(failed), /Preview stopped .*ffmpeg failed\. Edits made before the failure stay in the project/)
  button(failed, 'Dismiss').props.onClick(); assert.equal(dismissed, 1)
  assert.equal(assistantPanel.ApplyingCard({ applying: null }), null)
})

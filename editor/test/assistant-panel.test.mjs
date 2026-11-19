import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOps, newProject } from '../core/project.js'
import { assistantPanel } from '../web/ui/assistant-panel.js'
import { readableChange } from '../web/ui/change-values.js'
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
  // A pause cut names its target, so the agent neither trims a token amount nor leaves text fragments.
  const silences = assistantSuggestions(interview(), {}).find(item => item.id === 'silences').prompt
  assert.match(silences, /^Shorten silent pauses longer than 0\.4 seconds across the timeline to about 0\.15 seconds\..* remove any title or caption piece a cut leaves behind\.$/)
  assert.match(assistantSuggestions(interview(), { selection: ['c1', 'c2'] }).find(item => item.id === 'silences-selection').prompt, /^Shorten silent pauses longer than 0\.4 seconds inside the 1 selected clip to about 0\.15 seconds\./)
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

test('one take cut in two is not offered a match grade, and captions on the same picture count', () => {
  const p = newProject('Synthetic take', { width: 1920, height: 1080 })
  p.assets['media/take.mp4'] = { duration: 30, width: 1920, height: 1080, hasVideo: true, hasAudio: true }
  const cut = applyOps(p, [{ op: 'append', src: 'media/take.mp4', track: 'V1', dur: 20 }, { op: 'blade', at: 8 }]).project
  const pieces = cut.tracks.find(track => track.id === 'V1').clips.map(clip => clip.id)
  assert.equal(pieces.length, 2)
  const ids = list => list.map(item => item.id)
  assert.ok(!ids(assistantSuggestions(cut, {})).includes('match-all'))
  // Two pieces of one take get one grade, and the request names both.
  assert.deepEqual(assistantSuggestions(cut, { selection: pieces })[0], { id: 'grade-shot', label: 'Grade these shots',
    prompt: 'Give the 2 selected shots, all from one take, one clean, natural grade: balance exposure and white balance, then add gentle contrast. Leave other clips unchanged.' })
  assert.equal(assistantSuggestions(cut, { selection: pieces.slice(0, 1) })[0].label, 'Grade this shot')
  assert.ok(ids(assistantSuggestions(cut, {})).includes('captions'))
  const caption = id => ({ id: `C${id}`, kind: 'caption', clips: [{ id: `cap${id}`, kind: 'caption', start: 0, dur: 2, text: 'Sample words' }] })
  const short = (id, extra = []) => ({ name: `Short ${id}`, width: 1080, height: 1920, fps: 30, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: `${id}c`, kind: 'video', src: 'media/take.mp4', start: 0, dur: 5, in: 0 }] }, ...extra] })
  // Captions on unrelated shorts do not stop Main from offering its own.
  const shorts = structuredClone(cut)
  shorts.comps = { s1: short('s1', [caption(1)]), s2: short('s2', [caption(2)]) }
  assert.ok(ids(assistantSuggestions(shorts, {})).includes('captions'))
  assert.ok(!ids(assistantSuggestions(shorts, { comp: 's1' })).includes('captions'))
  // Captions in Main count inside a composition that Main shows, and the other way round.
  const captioned = structuredClone(cut)
  captioned.tracks.push(caption('M'))
  captioned.comps = { k1: short('k1'), k2: short('k2') }
  captioned.tracks.find(track => track.id === 'V1').clips.push({ id: 'k1clip', kind: 'comp', comp: 'k1', start: 20, dur: 5, in: 0 })
  assert.ok(!ids(assistantSuggestions(captioned, {})).includes('captions'))
  assert.ok(!ids(assistantSuggestions(captioned, { comp: 'k1' })).includes('captions'))
  assert.ok(ids(assistantSuggestions(captioned, { comp: 'k2' })).includes('captions'))
  const inner = structuredClone(cut)
  inner.comps = { k1: short('k1', [caption(1)]) }
  inner.tracks.find(track => track.id === 'V1').clips.push({ id: 'k1clip', kind: 'comp', comp: 'k1', start: 20, dur: 5, in: 0 })
  assert.ok(!ids(assistantSuggestions(inner, {})).includes('captions'))
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
  assert.match(text(tree), /Apply changes to 2 layers ?\. Nothing has changed yet ?\./)
  assert.equal(nodes(tree).find(node => node.type === 'p' && /Nothing has changed yet/.test(text(node))).props.role, 'status', 'the headline is announced when the preview arrives')
  assert.equal(button(tree, 'Apply').props.disabled, false)
  button(tree, 'Apply').props.onClick(); button(tree, 'Discard').props.onClick()
  assert.deepEqual(calls, ['apply', 'discard'])
})

test('a preview names the track and time, and marks linked audio, so a clip and its sound read apart', () => {
  const p = interview()
  const proposal = { id: 'p3', baseVersion: 3, at: 1, summary: 'Quieter and dimmer', stale: false, ops: [
    { op: 'update', id: 'c1', set: { opacity: 0.5 } },
    { op: 'update', id: 'c1a', set: { gain: -6 } },
  ] }
  const changes = assistantPanel.previewChanges(p, proposal)
  assert.deepEqual(changes.layers.map(layer => [layer.name, layer.track]), [['a.mp4', 'V1 at 0:00'], ['a.mp4 audio', 'A1 at 0:00']])
  const tree = assistantPanel.PreviewCard({ proposal, project: p, version: 3, running: false, busy: '' })
  const rows = nodes(tree).filter(node => node.type === 'small').map(text)
  assert.deepEqual(rows, ['V1 at 0:00', 'A1 at 0:00'])
  assert.doesNotMatch(text(tree), /\bc1a?\b/, 'no stored id shows')
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
  assert.match(text(bar), /Made 3 edits/)
  button(bar, 'Undo this change').props.onClick()
  assert.equal(undone, 1)
  assert.match(text(assistantPanel.ChangeBar({ change: { undoable: true, kind: 'preview', edits: 1 } })), /Applied the preview/)
})

test('a preview with processing steps lists what each renders and where it lands, and applying shows progress or the failure', () => {
  const p = interview()
  const proposal = { id: 'p2', baseVersion: 3, at: 1, summary: 'Steady the interview', stale: false, ops: [], steps: [
    { path: '/api/stabilize/render', body: { src: 'media/a.mp4', clip: 'c1' }, preview: { title: 'Stabilize (deshake render)', produces: 'A steadied 20 s copy of a.mp4 in media/stabilized.', lands: 'Replaces the picture of a.mp4 (c1) on V1 at 00:00:00:00. Timing stays the same.' } },
  ] }
  const tree = assistantPanel.PreviewCard({ proposal, project: p, version: 3, running: false, busy: '', onApply: () => {}, onDiscard: () => {} })
  assert.match(text(tree), /Apply to run 1 processing step ?\. Nothing has changed yet and nothing renders until you apply ?\./)
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


test('transition-only selections never suggest whole-timeline edits', () => {
  const p = interview()
  assert.deepEqual(assistantSuggestions(p, { selection: ['tr:c2'] }), [])
  assert.deepEqual(assistantSuggestions(p, { selection: ['tr:c1', 'tr:c2'] }), [])
  assert.ok(assistantSuggestions(p).some(item => item.id === 'silences'))
})


test('Show all changes includes every receipt layer, setting and property value', () => {
  const p = interview()
  const ops = [
    ...Array.from({ length: 8 }, (_, i) => ({ op: 'add_title', text: `Title ${i}`, start: i, dur: 1 })),
    { op: 'update', id: 'c1', set: { opacity: 0.7, gain: -3, mute: true, label: 'New label', speed: 1.2 } },
    { op: 'project', set: { width: 1080, height: 1920 } },
  ]
  const proposal = { ops, baseVersion: 1 }
  const receipt = assistantPanel.previewChanges(p, proposal).receipt
  const tree = assistantPanel.PreviewCard({ proposal, project: p, version: 1 })
  const details = nodes(tree).find(node => node.type === 'details' && text(node).startsWith('Show all changes'))
  assert.ok(details)
  // Every property is listed, with its value as words rather than the stored JSON.
  for (const item of [...receipt.scopes, ...receipt.clips]) for (const change of item.changes) {
    const row = readableChange(change, { fps: p.fps })
    assert.ok(text(details).includes(row.label))
    for (const value of [row.only, row.before, row.after].filter(Boolean)) assert.ok(text(details).includes(value), value)
  }
  assert.match(text(details), /1080.*1920/s)
  assert.doesNotMatch(text(details), /[{}[\]]|"/)
  assert.equal(nodes(details).some(node => ['button', 'input'].includes(node.type)), false)
})

test('a preview shows the same edit notes a committed edit would get, as quiet lines', () => {
  const p = interview()
  const proposal = { id: 'p9', baseVersion: 3, at: 1, summary: 'Speed up the opening', stale: false, ops: [{ op: 'speed', id: 'c1', speed: 1.25 }] }
  const { notes } = assistantPanel.previewChanges(p, proposal)
  assert.ok(notes.some(note => /^".+" now plays at 1\.25x, so it is [\d.]+s long instead of [\d.]+s\./.test(note)), JSON.stringify(notes))
  assert.ok(notes.every(note => !/\bc1\b|semitones/.test(note)), JSON.stringify(notes))
  const tree = assistantPanel.PreviewCard({ proposal, project: p, version: 3, running: false, busy: '', onApply: () => {}, onDiscard: () => {} })
  assert.deepEqual(nodes(tree).filter(node => node.props?.class === 'assistant-note').map(text), notes)
  const plain = { ...proposal, ops: [{ op: 'update', id: 'c1', set: { opacity: 0.5 } }] }
  assert.deepEqual(nodes(assistantPanel.PreviewCard({ proposal: plain, project: p, version: 3, running: false, busy: '' })).filter(node => node.props?.class === 'assistant-note'), [])
})

test('Show in viewer is offered for a preview with edits, and says when processing steps are not shown', () => {
  const p = interview()
  const proposal = { id: 'p4', baseVersion: 3, at: 1, summary: 'Add a lower third', stale: false, ops: [{ op: 'add_title', text: 'Sample name', track: 'V3', start: 5, dur: 3 }] }
  const toggles = []
  const off = assistantPanel.PreviewCard({ proposal, project: p, version: 3, running: false, busy: '', onShow: on => toggles.push(on) })
  assert.equal(button(off, 'Show in viewer').props['aria-pressed'], false, 'off until the person turns it on')
  button(off, 'Show in viewer').props.onClick()
  assert.deepEqual(toggles, [true])
  const on = assistantPanel.PreviewCard({ proposal, project: p, version: 3, running: false, busy: '', shown: true, onShow: value => toggles.push(value) })
  assert.equal(button(on, 'Back to project').props['aria-pressed'], true)
  assert.match(text(on), /The viewer shows this preview\./)
  assert.doesNotMatch(text(on), /Processing steps are not shown/)
  button(on, 'Back to project').props.onClick()
  assert.deepEqual(toggles, [true, false])
  const withSteps = { ...proposal, steps: [{ path: '/api/transcribe', body: {}, preview: { title: 'Transcribe', produces: 'Words', lands: 'Transcript' } }] }
  assert.match(text(assistantPanel.PreviewCard({ proposal: withSteps, project: p, version: 3, shown: true, onShow: () => {} })), /The viewer shows this preview\. Processing steps are not shown\./)
  // Nothing to draw: only steps, a stale preview, one that cannot apply, or a host without the viewer hook.
  assert.equal(button(assistantPanel.PreviewCard({ proposal: { ...withSteps, ops: [] }, project: p, version: 3, onShow: () => {} }), 'Show in viewer'), undefined)
  assert.equal(button(assistantPanel.PreviewCard({ proposal, project: p, version: 4, onShow: () => {} }), 'Show in viewer'), undefined)
  assert.equal(button(assistantPanel.PreviewCard({ proposal: { ...proposal, ops: [{ op: 'update', id: 'missing', set: { opacity: 0.5 } }] }, project: p, version: 3, onShow: () => {} }), 'Show in viewer'), undefined)
  assert.equal(button(assistantPanel.PreviewCard({ proposal, project: p, version: 3 }), 'Show in viewer'), undefined)
})

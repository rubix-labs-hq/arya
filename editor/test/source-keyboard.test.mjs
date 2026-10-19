import { mediaDisplayName } from '../web/ui/media-label.js'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
const editor = process.env.ARYA_TEST_EDITOR_ROOT ? pathToFileURL(process.env.ARYA_TEST_EDITOR_ROOT + '/') : new URL('../', import.meta.url)
const core = await import(new URL('core/project.js', editor))
const { applyOps, newProject, compView, hasAudio } = core
const { audioPlan } = await import(new URL('core/audio-plan.js', editor))
const { sourcePlacementPlan } = await import(new URL('web/ui/source-media.js', editor))
const text = fs.readFileSync(new URL('web/ui/keys.js', editor), 'utf8')
const moduleBody = text.replace(/^import .*\n/gm, '').replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ').replace(/^export \{.*\}\s*$/gm, '')
const keysFactory = new Function('clipEnd', 'compView', 'duration', 'snapToFrame', 'player', 'api', 'edit', 'set', 'store', 'time', 'toast', 'viewProject', 'copySelection', 'sourcePlacementPlan', 'window', 'Element', 'getComputedStyle', 'document', moduleBody + '\nreturn installKeys')
function fixture({ sound = false, nested = false } = {}) {
  let p = newProject('Keyboard source placement')
  p.assets['media/source.mp4'] = { hasVideo: true, hasAudio: sound, duration: 10 }
  p.assets['media/bed.wav'] = { hasAudio: true, duration: 12 }
  p = applyOps(p, [{ op: 'add_color', track: 'V1', start: 0, dur: 10 }, { op: 'add_clip', src: 'media/bed.wav', track: 'A1', start: 0, dur: 10 }]).project
  if (nested) p = applyOps(p, [{ op: 'add_comp', name: 'Nested' }]).project
  return p
}
function keyboard(p = fixture(), { nested = false, planner = sourcePlacementPlan, apply = true, editOverride } = {}) {
  const calls = [], notices = [], handlers = [], pages = []
  const state = { root: 'fixture', project: p, version: 7, openComp: nested ? Object.keys(p.comps)[0] : null, source: { src: 'media/source.mp4', in: 2, out: 5 }, viewerMode: 'timeline', selection: [], settingsOpen: false }
  const set = patch => { Object.assign(state, patch); if (patch.page) pages.push(patch.page) }
  const edit = editOverride ? (...args) => { calls.push({ op: args[0], summary: args[1], options: args[2] }); return editOverride(...args) } : (op, summary, options) => { calls.push({ op, summary, options }); if (apply) state.project = applyOps(state.project, [op]).project }
  const install = keysFactory(core.clipEnd, core.compView, core.duration, core.snapToFrame, {}, () => {}, edit, set, state, { t: 3 }, (text, kind) => notices.push({ text, kind }), () => state.openComp && state.project.comps?.[state.openComp] ? compView(state.project, state.openComp) : state.project, () => {}, (...args) => planner(...args), { addEventListener: (name, fn) => { assert.equal(name, 'keydown'); handlers.push(fn) } }, class Element {}, () => ({}), {})
  install(); assert.equal(handlers.length, 1)
  const dispatch = (key, options = {}) => {
    const e = { key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, target: { closest: () => null }, preventDefault() { this.defaultPrevented = true }, ...options }
    handlers[0](e); return e
  }
  return { state, calls, notices, dispatch, pages }
}
test('global Q after switching the source viewer to Timeline refuses missing upper video tracks', () => {
  const p = fixture(); p.tracks = p.tracks.filter(t => t.kind !== 'video' || t.id === 'V1')
  const c = keyboard(p); const original = structuredClone(p.tracks[0]); c.dispatch('q')
  assert.equal(c.calls.length, 0); assert.match(c.notices[0].text, /upper.*video/); assert.deepEqual(c.state.project.tracks[0], original)
})
test('global Q requires upper linked audio and leaves primary footage and audio untouched', () => {
  const p = fixture({ sound: true }); p.tracks = p.tracks.filter(t => t.kind !== 'audio' || t.id === 'A1')
  const c = keyboard(p); c.dispatch('q'); assert.equal(c.calls.length, 0); assert.match(c.notices[0].text, /upper.*audio/); assert.deepEqual(c.state.project, p)
})
test('global Q skips locked upper destinations and preserves the primary beds', () => {
  const p = fixture({ sound: true }); p.tracks.find(t => t.id === 'V2').locked = true; p.tracks.find(t => t.id === 'A2').locked = true
  const before = structuredClone(p), c = keyboard(p); c.dispatch('q')
  assert.deepEqual([c.calls[0].op.track, c.calls[0].op.audioTrack, c.calls[0].options.expectedVersion], ['V3', 'A3', 7])
  for (const id of ['V1', 'V2', 'A1', 'A2']) assert.deepEqual(c.state.project.tracks.find(t => t.id === id), before.tracks.find(t => t.id === id))
  const video = c.state.project.tracks.find(t => t.id === 'V3').clips[0], audio = c.state.project.tracks.find(t => t.id === 'A3').clips[0]
  assert.equal(video.link, audio.link); assert.deepEqual([video.start, video.in, video.dur], [3, 2, 3])
})
for (const [key, mode] of [['e', 'append'], ['w', 'insert'], ['d', 'overwrite'], ['q', 'overwrite']]) test(`global ${key.toUpperCase()} uses shared planner, captured version and explicit nested composition`, () => {
  const p = fixture({ nested: true }), comp = Object.values(p.comps)[0]; comp.tracks.find(t => t.id === 'V1').locked = true
  const root = structuredClone(p.tracks), c = keyboard(p, { nested: true }); c.dispatch(key)
  assert.equal(c.calls[0].op.op, mode); assert.equal(c.calls[0].op.comp, comp.id); assert.equal(c.calls[0].op.track, 'V2'); assert.equal(c.calls[0].options.expectedVersion, 7)
  assert.deepEqual(c.state.project.tracks, root)
})
test('global placements reject missing/locked destinations and invalid source/range handles', () => {
  for (const change of [p => { p.assets['media/source.mp4'].duration = Infinity }, p => { p.range = { in: 1, out: 8 } }, p => { delete p.assets['media/source.mp4'] }, p => { for (const t of p.tracks) t.locked = true }]) {
    const p = fixture(); change(p); const c = keyboard(p); c.state.source.in = 8; c.state.source.out = 10; c.dispatch('d'); assert.equal(c.calls.length, 0); assert.equal(c.notices[0].kind, 'error')
  }
})
test('global image marks and timeline ranges use the shared placement duration', () => {
  const p = fixture(); p.assets['media/still.png'] = { hasVideo: true, still: true }; p.range = { in: 1, out: 5 }
  const c = keyboard(p); c.state.source = { src: 'media/still.png', in: 1, out: 3 }; c.dispatch('w')
  assert.deepEqual([c.calls[0].op.start, c.calls[0].op.in, c.calls[0].op.dur], [1, 0, 4])
})
for (const drift of ['root', 'version', 'project', 'openComp', 'source', 'marks']) test(`global placement rejects ${drift} drift between planning and admission`, () => {
  let c; c = keyboard(fixture(), { planner: (...args) => {
    const op = sourcePlacementPlan(...args)
    if (drift === 'project') c.state.project = structuredClone(c.state.project)
    else if (drift === 'source') c.state.source = { ...c.state.source }
    else if (drift === 'marks') c.state.source.in++
    else c.state[drift] = drift === 'version' ? 8 : 'changed'
    return op
  } })
  c.dispatch('w'); assert.equal(c.calls.length, 0); assert.match(c.notices[0].text, /changed/)
})
test('global source placement rejects an invalid open composition without editing the root', () => {
  const c = keyboard(); c.state.openComp = 'missing'
  // The real store viewProject falls back to root for a missing comp. Model this seam.
  c.dispatch('q'); assert.equal(c.calls.length, 0); assert.match(c.notices[0].text, /no composition/)
})
test('global source placement ignores editing targets, dialogs, settings and consumed events', () => {
  for (const selector of ['input', 'textarea', 'select', '[contenteditable]', '[role="dialog"]', '[role="alertdialog"]', 'dialog']) {
    const c = keyboard(); c.dispatch('q', { target: { closest: actual => actual.includes(selector) ? {} : null } }); assert.equal(c.calls.length, 0, selector)
  }
  const settings = keyboard(); settings.state.settingsOpen = true; settings.dispatch('q'); assert.equal(settings.calls.length, 0)
  const consumed = keyboard(); consumed.dispatch('q', { defaultPrevented: true }); assert.equal(consumed.calls.length, 0)
})
test('Cmd/Ctrl+E reaches export instead of placing a source', () => {
  for (const modifier of ['metaKey', 'ctrlKey']) { const c = keyboard(); c.dispatch('e', { [modifier]: true }); assert.equal(c.calls.length, 0); assert.deepEqual(c.pages, ['deliver']) }
})
const viewer = fs.readFileSync(new URL('web/ui/viewer.js', editor), 'utf8')
const sourceKeyBody = viewer.match(/const onKey = e => \{([\s\S]*?)\n    \}\n    window.addEventListener\('keydown', onKey, true\)/)[1]
function sourceKey() {
  const placements = [], marks = [], toggles = [], state = { viewerMode: 'source', settingsOpen: false }
  const onKey = new Function('store', 'video', 'offset', 'dur', 'setSrc', 'toggle', 'place', `return e => {${sourceKeyBody}\n}`)(state, { current: { currentTime: 3 } }, 0, 10, patch => marks.push(patch), () => toggles.push(true), how => placements.push(how))
  const dispatch = options => { const e = { key: 'q', target: { closest: () => null }, preventDefault() { this.defaultPrevented = true }, stopImmediatePropagation() { this.stopped = true }, ...options }; onKey(e); return e }
  return { placements, marks, toggles, state, dispatch }
}
test('SourceViewer capture listener does not place from contenteditable, dialogs or modified/consumed keys', () => {
  for (const selector of ['[contenteditable]', '[role="dialog"]', '[role="alertdialog"]', 'dialog']) {
    const c = sourceKey(), e = c.dispatch({ target: { closest: actual => actual.includes(selector) ? {} : null } }); assert.equal(c.placements.length, 0, selector); assert.equal(e.stopped, undefined)
  }
  for (const options of [{ defaultPrevented: true }, { metaKey: true }, { ctrlKey: true }]) { const c = sourceKey(); c.dispatch(options); assert.equal(c.placements.length, 0) }
  const c = sourceKey(); c.state.settingsOpen = true; c.dispatch({}); assert.equal(c.placements.length, 0)
})
test('SourceViewer ordinary placement key stays local while Timeline mode delegates to global keyboard', () => {
  const c = sourceKey(), e = c.dispatch({}); assert.deepEqual(c.placements, ['connect']); assert.equal(e.defaultPrevented, true); assert.equal(e.stopped, true)
  const timeline = sourceKey(); timeline.state.viewerMode = 'timeline'; const passthrough = timeline.dispatch({}); assert.equal(timeline.placements.length, 0); assert.equal(passthrough.stopped, undefined)
})
test('global placement passes expectedVersion to the real store edit admission guard during pending edits', async () => {
  let c, finish; const requests = [], notices = [], pendingCalls = []
  const storeText = fs.readFileSync(new URL('web/ui/store.js', editor), 'utf8')
  const scoped = storeText.match(/function scoped\(ops\) \{[\s\S]*?\n\}/)[0]
  const edit = storeText.slice(storeText.indexOf('export async function edit('), storeText.indexOf('export function connect(')).replace('export ', '')
  const liveEdit = new Function('store', 'applyOps', 'set', 'api', 'toast', `let pending = 0; ${scoped}\n${edit}\nreturn edit`)
  c = keyboard(fixture(), { editOverride: (...args) => { const pending = actualEdit(...args); pendingCalls.push(pending); return pending } })
  const actualEdit = liveEdit(c.state, applyOps, patch => Object.assign(c.state, patch), (route, body) => { requests.push({ route, body }); return new Promise(resolve => { finish = resolve }) }, text => notices.push(text))
  const earlier = actualEdit({ op: 'add_color', track: 'V1', start: 12, dur: 1 }, 'Existing pending edit')
  c.dispatch('q'); await Promise.resolve()
  assert.equal(requests.length, 1); assert.match(notices[0], /pending edits/)
  finish({ project: c.state.project, version: 8 }); await earlier; await Promise.all(pendingCalls)
})

const sourcePlaceBody = viewer.match(/  const place = how => \{([\s\S]*?)\n  \}\n  const pct/)[1]
const sourceContextExpression = viewer.match(/  const sourceContext = (.*)\n/)?.[1] ?? 'null'
const sourcePlaceFactory = new Function('p', 'src', 'asset', 'dur', 'isImage', 'time', 's', 'store', 'sourcePlacementPlan', 'edit', 'toast', 'mediaDisplayName', `const sourceContext = ${sourceContextExpression}; return how => {${sourcePlaceBody}\n}`)
function audioController(entry, p, src, nested = false) {
  if (entry === 'Keyboard') {
    const c = keyboard(p, { nested }); c.state.source = src
    return { ...c, place: mode => c.dispatch({ append: 'e', insert: 'w', overwrite: 'd', connect: 'q' }[mode]) }
  }
  const state = { root: 'fixture', version: 7, project: p, openComp: nested ? Object.keys(p.comps)[0] : null, source: src }, calls = [], notices = []
  const storeText = fs.readFileSync(new URL('web/ui/store.js', editor), 'utf8')
  const scope = storeText.match(/function scoped\(ops\) \{[\s\S]*?\n\}/)[0]
  const scoped = new Function('store', scope + '\nreturn scoped')(state)
  const view = compView(p, state.openComp), asset = p.assets[src.src]
  const place = sourcePlaceFactory(view, src, asset, asset.duration ?? 5, Boolean(asset.still), { t: 3 }, state, state, sourcePlacementPlan,
    (op, summary, options) => { calls.push({ op, summary, options }); state.project = applyOps(state.project, scoped([op])).project }, (text, kind) => notices.push({ text, kind }), mediaDisplayName)
  return { state, calls, notices, place }
}
function audioFixture({ audioOnly = false, nested = false } = {}) {
  let p = fixture({ sound: true, nested })
  if (audioOnly) p.assets['media/source.mp4'].hasVideo = false
  if (nested) {
    const comp = Object.values(p.comps)[0]
    comp.tracks.push({ id: 'A2', kind: 'audio', clips: [] })
    p = applyOps(p, [{ op: 'add_clip', comp: comp.id, src: 'media/bed.wav', track: 'A1', start: 0, dur: 10 }]).project
  }
  return p
}
for (const entry of ['Keyboard', 'SourceViewer']) {
  for (const nested of [false, true]) test(`${entry} audio-only Connect preserves occupied primary audio in ${nested ? 'nested' : 'main'} composition`, () => {
    const p = audioFixture({ audioOnly: true, nested }), original = structuredClone(p), view = compView(p, nested ? Object.keys(p.comps)[0] : null)
    const c = audioController(entry, p, { src: 'media/source.mp4', in: 2, out: 5 }, nested); c.place('connect')
    assert.equal(c.calls[0].op.track, 'A2'); assert.equal(c.calls[0].options.expectedVersion, 7)
    const result = compView(c.state.project, c.state.openComp)
    assert.deepEqual(result.tracks.find(t => t.id === 'A1'), view.tracks.find(t => t.id === 'A1'))
    assert.deepEqual(result.tracks.find(t => t.id === 'A2').clips.map(c => [c.kind, c.start, c.in, c.dur]), [['audio', 3, 2, 3]])
    if (nested) assert.deepEqual(c.state.project.tracks, original.tracks)
  })
  for (const state of ['missing', 'locked']) test(`${entry} audio-only Connect refuses ${state} upper audio before editing`, () => {
    const p = audioFixture({ audioOnly: true })
    if (state === 'missing') p.tracks = p.tracks.filter(t => t.kind !== 'audio' || t.id === 'A1')
    else for (const t of p.tracks.filter(t => t.kind === 'audio' && t.id !== 'A1')) t.locked = true
    const original = structuredClone(p), c = audioController(entry, p, { src: 'media/source.mp4', in: 2, out: 5 }); c.place('connect')
    assert.equal(c.calls.length, 0); assert.match(c.notices[0].text, /upper.*audio/); assert.deepEqual(c.state.project, original)
  })
  for (const mode of ['append', 'insert', 'overwrite', 'connect']) {
    for (const nested of [false, true]) test(`${entry} linked ${mode} captures unlocked audio destination in ${nested ? 'nested' : 'main'} composition`, () => {
      const p = audioFixture({ nested }), view = compView(p, nested ? Object.keys(p.comps)[0] : null); view.tracks.find(t => t.id === 'A1').locked = true
      const before = structuredClone(p), c = audioController(entry, p, { src: 'media/source.mp4', in: 2, out: 5 }, nested); c.place(mode)
      assert.equal(c.calls[0].op.audioTrack, 'A2'); assert.equal(c.calls[0].options.expectedVersion, 7)
      const result = compView(c.state.project, c.state.openComp), video = result.tracks.flatMap(t => t.clips).find(c => c.kind === 'video' && c.src === 'media/source.mp4'), audio = result.tracks.find(t => t.id === 'A2').clips.find(c => c.src === 'media/source.mp4')
      assert.ok(video && audio); assert.ok(video.link); assert.equal(video.link, audio.link); assert.deepEqual([video.start, video.in, video.dur], [audio.start, audio.in, audio.dur])
      assert.deepEqual(result.tracks.find(t => t.id === 'A1'), view.tracks.find(t => t.id === 'A1'))
      if (nested) assert.deepEqual(c.state.project.tracks, before.tracks)
    })
    for (const state of ['missing', 'locked']) test(`${entry} linked ${mode} refuses ${state} audio destinations without omitting editable linked audio`, () => {
      const p = audioFixture()
      if (state === 'missing') p.tracks = p.tracks.filter(t => t.kind !== 'audio')
      else for (const t of p.tracks.filter(t => t.kind === 'audio')) t.locked = true
      const before = structuredClone(p), c = audioController(entry, p, { src: 'media/source.mp4', in: 2, out: 5 }); c.place(mode)
      assert.equal(c.calls.length, 0); assert.match(c.notices[0].text, /unlocked.*audio/); assert.deepEqual(c.state.project, before)
    })
  }
  test(`${entry} video-only, still and explicit silent intent remain usable without audio tracks`, () => {
    for (const kind of ['video-only', 'still', 'explicit silent']) for (const mode of ['append', 'insert', 'overwrite', 'connect']) {
      const p = audioFixture(); p.tracks = p.tracks.filter(t => t.kind !== 'audio')
      if (kind !== 'explicit silent') p.assets['media/source.mp4'].hasAudio = false
      if (kind === 'still') { p.assets['media/source.mp4'].still = true; delete p.assets['media/source.mp4'].duration }
      const src = { src: 'media/source.mp4', in: 2, out: 5, ...(kind === 'explicit silent' ? { audio: false } : {}) }, c = audioController(entry, p, src)
      c.place(mode); assert.equal(c.calls.length, 1, `${kind} ${mode}`)
      assert.equal(c.calls[0].op.audioTrack, undefined)
      if (kind === 'explicit silent') assert.equal(c.calls[0].op.audio, false)
      assert.equal(c.state.project.tracks.flatMap(t => t.clips).some(c => c.kind === 'audio' && c.src === 'media/source.mp4'), false)
    }
  })
}

test('global placement rejects explicit silent-intent drift before admission', () => {
  let c; c = keyboard(fixture({ sound: true }), { planner: (...args) => {
    const op = sourcePlacementPlan(...args); c.state.source.audio = false; return op
  } })
  c.dispatch('w'); assert.equal(c.calls.length, 0); assert.match(c.notices[0].text, /changed/)
})


const planLeaves = plan => (plan.buses ?? []).flatMap(bus => bus.items.flatMap(item => item.kind === 'comp' ? planLeaves({ buses: item.buses }) : [item]))
for (const entry of ['Keyboard', 'SourceViewer']) for (const nested of [false, true]) {
  for (const mode of ['append', 'insert', 'overwrite', 'connect']) test(`${entry} explicit video silence suppresses embedded source in hasAudio/audioPlan for ${mode} in ${nested ? 'nested' : 'main'} composition`, () => {
    const p = audioFixture({ nested }), before = compView(p, nested ? Object.keys(p.comps)[0] : null)
    const bed = structuredClone(before.tracks.find(t => t.id === 'A1'))
    const c = audioController(entry, p, { src: 'media/source.mp4', in: 2, out: 5, audio: false }, nested); c.place(mode)
    assert.equal(c.calls.length, 1); assert.equal(c.calls[0].op.audio, false)
    const view = compView(c.state.project, c.state.openComp), video = view.tracks.flatMap(t => t.clips).find(c => c.kind === 'video' && c.src === 'media/source.mp4')
    assert.ok(video)
    const leaves = planLeaves(audioPlan(view)); assert.equal(leaves.some(item => item.src === 'media/source.mp4'), false, 'explicit silence must exclude the placed source from the real mix graph')
    assert.equal(video.mute, true); assert.equal(hasAudio(view, video), false)
    assert.ok(leaves.some(item => item.src === 'media/bed.wav'), 'the existing audio bed must retain its plan contribution')
    if (mode !== 'insert') assert.deepEqual(view.tracks.find(t => t.id === 'A1'), bed)
    assert.equal(view.tracks.flatMap(t => t.clips).some(c => c.kind === 'audio' && c.src === 'media/source.mp4'), false)
    assert.equal(c.calls[0].options.expectedVersion, 7)
    if (nested) assert.deepEqual(c.state.project.tracks, p.tracks)
  })
  test(`${entry} naturally video-only controls remain unmuted and absent from audioPlan in ${nested ? 'nested' : 'main'} composition`, () => {
    for (const mode of ['append', 'insert', 'overwrite', 'connect']) {
      const p = audioFixture({ nested }); p.assets['media/source.mp4'].hasAudio = false
      const c = audioController(entry, p, { src: 'media/source.mp4', in: 2, out: 5 }, nested); c.place(mode)
      const view = compView(c.state.project, c.state.openComp), video = view.tracks.flatMap(t => t.clips).find(c => c.kind === 'video' && c.src === 'media/source.mp4')
      assert.ok(video); assert.equal(video.mute, undefined); assert.equal(hasAudio(view, video), false)
      const leaves = planLeaves(audioPlan(view)); assert.equal(leaves.some(item => item.src === 'media/source.mp4'), false); assert.ok(leaves.some(item => item.src === 'media/bed.wav'))
    }
  })
  test(`${entry} linked-video controls still contribute editable audio in ${nested ? 'nested' : 'main'} composition`, () => {
    for (const mode of ['append', 'insert', 'overwrite', 'connect']) {
      const p = audioFixture({ nested }), c = audioController(entry, p, { src: 'media/source.mp4', in: 2, out: 5 }, nested); c.place(mode)
      const view = compView(c.state.project, c.state.openComp), video = view.tracks.flatMap(t => t.clips).find(c => c.kind === 'video' && c.src === 'media/source.mp4'), audio = view.tracks.flatMap(t => t.clips).find(c => c.kind === 'audio' && c.src === 'media/source.mp4')
      assert.ok(video && audio); assert.equal(video.mute, undefined); assert.equal(video.audioDetached, true); assert.equal(hasAudio(view, video), false); assert.equal(hasAudio(view, audio), true)
      const contributions = planLeaves(audioPlan(view)).filter(item => item.src === 'media/source.mp4'); assert.equal(contributions.length, 1); assert.equal(contributions[0].id, audio.id)
    }
  })
}

for (const selector of ['summary', 'button', 'a[href]', '[role="button"]', '[role="tab"]']) test(`SourceViewer capture preserves keyboard defaults for focused ${selector} children`, () => {
  const c = sourceKey(), control = {}
  const target = { closest: selectors => selectors.split(',').some(s => s.trim() === selector) ? control : null }
  for (const key of [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'i', 'o', 'e', 'w', 'd', 'q']) {
    const e = c.dispatch({ key, target })
    assert.equal(e.defaultPrevented, undefined, key)
    assert.equal(e.stopped, undefined, key)
  }
  assert.deepEqual(c.toggles, [])
  assert.deepEqual(c.marks, [])
  assert.deepEqual(c.placements, [])
})

test('SourceViewer capture still toggles playback on ordinary Space', () => {
  const c = sourceKey(), e = c.dispatch({ key: ' ' })
  assert.deepEqual(c.toggles, [true])
  assert.equal(e.defaultPrevented, true)
  assert.equal(e.stopped, true)
})

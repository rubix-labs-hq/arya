import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const editor = process.env.ARYA_TEST_EDITOR_ROOT ? pathToFileURL(process.env.ARYA_TEST_EDITOR_ROOT + '/') : new URL('../', import.meta.url)
const core = await import(new URL('core/project.js', editor))
const { sourcePlacementPlan } = await import(new URL('web/ui/source-media.js', editor))
const source = fs.readFileSync(new URL('web/ui/keys.js', editor), 'utf8')
const moduleBody = source.replace(/^import .*\n/gm, '').replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ').replace(/^export \{.*\}\s*$/gm, '')
const keysFactory = new Function('deps', `const { clipEnd, compView, duration, snapToFrame, sourceTime, player, api, edit, set, store, time, toast, viewProject, copySelection, sourcePlacementPlan, window, Element, getComputedStyle, document } = deps; ${moduleBody}\nreturn { installKeys, runEditorCommand }`)
const storeSource = fs.readFileSync(new URL('web/ui/store.js', editor), 'utf8')
const scopeFactory = new Function('store', storeSource.match(/function scoped\(ops\) \{[\s\S]*?\n\}/)[0] + '\nreturn scoped')

function fixture(nested = false) {
  const p = core.newProject('Browser edit keys')
  p.assets['media/source.mp4'] = { hasVideo: true, hasAudio: true, duration: 30, fps: 30 }
  const video = [0, 4, 8].map((start, i) => ({ id: `c${i + 1}`, kind: 'video', src: 'media/source.mp4', start, dur: 4, in: start, link: `L${i + 1}` }))
  const audio = video.map(c => ({ ...c, id: c.id + 'a', kind: 'audio' }))
  const tracks = [{ id: 'V1', kind: 'video', clips: video }, { id: 'A1', kind: 'audio', clips: audio }]
  if (nested) {
    p.comps = { k1: { id: 'k1', name: 'Nested', width: 640, height: 360, fps: 30, tracks } }
    p.tracks = [{ id: 'V1', kind: 'video', clips: [{ id: 'root', kind: 'color', start: 0, dur: 40 }] }]
  } else p.tracks = tracks
  return p
}

function keyboard({ nested = false, project = fixture(nested), selection = [], at = 1 } = {}) {
  const calls = [], notices = [], apiCalls = [], handlers = [], playerCalls = []
  const state = { project, root: 'synthetic', version: 7, openComp: nested ? 'k1' : null, selection, linked: true, settingsOpen: false, zoom: 500, scroll: 3, source: null }
  const scoped = scopeFactory(state)
  const viewProject = () => core.compView(state.project, state.openComp)
  const set = patch => Object.assign(state, patch)
  const time = { t: at }
  const edit = op => {
    calls.push(structuredClone(op))
    state.project = core.applyOps(state.project, scoped(Array.isArray(op) ? op : [op])).project
  }
  const document = { activeElement: null, querySelector: selector => selector === '.tl-canvas' ? { clientWidth: 900 } : null }
  const keys = keysFactory({ ...core, player: { toggle: () => playerCalls.push(['toggle']), step: n => playerCalls.push(['step', n]) }, api: (route, body) => { apiCalls.push({ route, body }); return Promise.resolve({ project: state.project, version: state.version }) }, edit, set, store: state, time, toast: text => notices.push(text), viewProject, copySelection: (_p, ids = state.selection) => { state.copied = ids }, sourcePlacementPlan,
    window: { addEventListener: (name, fn) => { assert.equal(name, 'keydown'); handlers.push(fn) } }, Element: class {}, getComputedStyle: () => ({}), document })
  keys.installKeys()
  assert.equal(handlers.length, 1)
  const dispatch = (key, options = {}) => {
    const event = { key, code: '', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, target: { closest: () => null }, preventDefault() { this.defaultPrevented = true }, ...options }
    handlers[0](event)
    return event
  }
  return { state, calls, notices, apiCalls, playerCalls, dispatch, time, viewProject, keys, set, document }
}

for (const nested of [false, true]) {
  test(`Shift-Z fits the active ${nested ? 'nested' : 'main'} timeline`, () => {
    const c = keyboard({ nested })
    const e = c.dispatch('Z', { shiftKey: true })
    assert.equal(c.state.zoom, 900 / (12 * 1.05))
    assert.equal(c.state.scroll, 0)
    assert.equal(e.defaultPrevented, true)
    assert.equal(c.calls.length, 0)
  })

  test(`Fit button uses the active ${nested ? 'nested' : 'main'} timeline`, () => {
    const c = keyboard({ nested })
    const toolbar = fs.readFileSync(new URL('web/ui/timeline-toolbar.js', editor), 'utf8')
    const callback = toolbar.match(/aria-label="Fit timeline"[\s\S]*?onClick=\$\{(\(\) => set\(\{[^\n]*?\}\))\}/)?.[1]
    assert.ok(callback, 'Extract the actual Fit button callback')
    new Function('set', 's', 'duration', 'viewProject', 'document', `return ${callback}`)(c.set, c.state, core.duration, c.viewProject, c.document)()
    assert.equal(c.state.zoom, 900 / (12 * 1.05))
    assert.equal(c.state.scroll, 0)
  })

  test(`Cmd-B with a selection outside the playhead leaves the ${nested ? 'nested' : 'main'} project unchanged`, () => {
    const c = keyboard({ nested, selection: ['c2', 'c2a'], at: 2 })
    const before = structuredClone(c.state.project)
    c.dispatch('b', { metaKey: true })
    assert.equal(c.calls.length, 0)
    assert.deepEqual(c.state.project, before)
  })

  test(`Cmd-B cuts selected clips without cutting an unrelated ${nested ? 'nested' : 'main'} layer`, () => {
    const p = fixture(nested), view = core.compView(p, nested ? 'k1' : null)
    view.tracks.push({ id: 'V2', kind: 'video', clips: [{ id: 'title', kind: 'title', start: 0, dur: 12, title: { text: 'Untouched' } }] })
    const c = keyboard({ nested, project: p, selection: ['c2', 'c2a'], at: 6 })
    c.dispatch('b', { metaKey: true })
    assert.equal(c.viewProject().tracks.find(t => t.id === 'V2').clips.length, 1)
    assert.deepEqual(c.viewProject().tracks.find(t => t.id === 'V1').clips.map(c => c.dur), [4, 2, 2, 4])
    assert.deepEqual(c.viewProject().tracks.find(t => t.id === 'A1').clips.map(c => c.dur), [4, 2, 2, 4])
  })

  test(`Option-left-trim removes one second once from a selected linked ${nested ? 'nested' : 'main'} pair`, () => {
    const c = keyboard({ nested, selection: ['c1', 'c1a'], at: 1 })
    const root = structuredClone(c.state.project.tracks)
    c.dispatch('[', { altKey: true })
    for (const id of ['V1', 'A1']) {
      const clips = c.viewProject().tracks.find(t => t.id === id).clips
      assert.deepEqual(clips.map(c => [c.start, c.dur, c.in]), [[0, 3, 1], [3, 4, 4], [7, 4, 8]])
    }
    assert.equal(c.calls.length, 1)
    assert.equal(c.calls[0].length, 1)
    if (nested) assert.deepEqual(c.state.project.tracks, root)
  })
}

test('no selection still allows Cmd-B to cut all unlocked tracks at the playhead', () => {
  const c = keyboard({ at: 2 })
  c.dispatch('b', { metaKey: true })
  assert.deepEqual(c.calls, [[{ op: 'blade', at: 2 }]])
  assert.deepEqual(c.viewProject().tracks.map(t => t.clips.map(c => c.dur)), [[2, 2, 4, 4], [2, 2, 4, 4]])
})

test('a selected linked primary alone trims both partners once', () => {
  const c = keyboard({ selection: ['c1'], at: 1 })
  c.dispatch('[', { altKey: true })
  assert.deepEqual(c.viewProject().tracks.map(t => t.clips[0].dur), [3, 3])
})

test('with Linked selection off, Option-left-trim of the selected audio leaves its picture alone', () => {
  const c = keyboard({ selection: ['c1a'], at: 1 })
  c.state.linked = false
  c.dispatch('[', { altKey: true })
  assert.deepEqual(c.calls, [[{ op: 'trim', id: 'c1a', edge: 'left', to: 1, ripple: true, unlinked: true }]])
  assert.deepEqual(c.viewProject().tracks.map(t => t.clips[0].dur), [4, 3])
})

test('independent selected clips each receive their left ripple trim', () => {
  const p = fixture()
  for (const track of p.tracks) for (const clip of track.clips) delete clip.link
  const c = keyboard({ project: p, selection: ['c1', 'c1a'], at: 1 })
  c.dispatch('[', { altKey: true })
  assert.equal(c.calls[0].length, 2)
  assert.deepEqual(c.viewProject().tracks.map(t => t.clips[0].dur), [3, 3])
})

test('ordinary Z is unhandled while Cmd-Z still invokes Undo', async () => {
  const c = keyboard()
  assert.equal(c.dispatch('z').defaultPrevented, false)
  assert.equal(c.state.zoom, 500)
  c.dispatch('z', { metaKey: true })
  await Promise.resolve()
  assert.deepEqual(c.apiCalls, [{ route: '/api/undo', body: {} }])
})

test('Shift-Z leaves settings and text drafts alone', () => {
  const c = keyboard()
  c.state.settingsOpen = true
  c.dispatch('Z', { shiftKey: true })
  c.state.settingsOpen = false
  c.dispatch('Z', { shiftKey: true, target: { closest: () => ({}) } })
  assert.equal(c.state.zoom, 500)
  assert.equal(c.state.scroll, 3)
})

for (const [name, fields, expected] of [
  ['forward speed', { in: 3, speed: 2 }, 5],
  ['reverse', { in: 3, reverse: true }, 6],
  ['freeze', { in: 3, reverse: true, freeze: 17.25 }, 17.25],
  ['source tail', { in: 29, speed: 2 }, 29.999],
]) test(`Match Frame follows rendered ${name} source timing`, () => {
  const p = fixture(), clip = p.tracks[0].clips[0]
  Object.assign(clip, fields)
  const before = structuredClone(p), c = keyboard({ project: p, selection: ['c1'], at: 1 })
  c.keys.runEditorCommand('matchFrame')
  assert.equal(c.state.source.t, expected)
  assert.equal(c.state.source.t, core.sourceTime(p, clip, 1))
  assert.equal(c.state.viewerMode, 'source')
  assert.deepEqual(c.state.project, before)
})

function controlTarget(selector, descendant = false) {
  const control = { closest: selectors => selectors.split(',').some(s => s.trim() === selector) ? control : null }
  return descendant ? { closest: selectors => control.closest(selectors) } : control
}

for (const selector of ['summary', 'button', 'a[href]', '[role="button"]', '[role="tab"]']) {
  for (const descendant of [false, true]) test(`focused ${selector}${descendant ? ' child' : ''} keeps Space and navigation with its control`, () => {
    const c = keyboard(), target = controlTarget(selector, descendant), before = structuredClone(c.state)
    c.document.activeElement = target
    for (const key of [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']) {
      assert.equal(c.dispatch(key, { target }).defaultPrevented, false, key)
    }
    assert.deepEqual(c.playerCalls, [])
    assert.deepEqual(c.calls, [])
    assert.deepEqual(c.state, before)
  })
  test(`native editor commands still run with focus on ${selector}`, () => {
    const c = keyboard()
    c.document.activeElement = controlTarget(selector)
    assert.equal(c.keys.runEditorCommand('playPause'), 'handled')
    assert.equal(c.keys.runEditorCommand('nextFrame'), 'handled')
    assert.deepEqual(c.playerCalls, [['toggle'], ['step', 1]])
  })
}

test('timeline Space and frame arrows retain editor keyboard commands', () => {
  const c = keyboard()
  for (const key of [' ', 'ArrowLeft', 'ArrowRight']) assert.equal(c.dispatch(key).defaultPrevented, true)
  assert.deepEqual(c.playerCalls, [['toggle'], ['step', -1], ['step', 1]])
})

test('native editor commands continue to ignore a focused text draft', () => {
  const c = keyboard()
  c.document.activeElement = controlTarget('textarea')
  assert.equal(c.keys.runEditorCommand('playPause'), 'input')
  assert.deepEqual(c.playerCalls, [])
})

test('ScrollTabs arrow and endpoint keys keep its own selection and focus behavior', () => {
  const c = keyboard(), selected = [], focused = []
  const tabs = [['media', 'Media'], ['edit', 'Edit'], ['motion', 'Motion']]
  const source = fs.readFileSync(new URL('web/ui/scroll-tabs.js', editor), 'utf8')
  const body = source.match(/  const keyboard = \(event, index\) => \{([\s\S]*?)\n  \}/)[1]
  const strip = { current: { querySelectorAll: () => tabs.map(([id]) => ({ focus: () => focused.push(id) })) } }
  const onKey = new Function('tabs', 'onChange', 'strip', `return (event, index) => {${body}\n}`)(tabs, id => selected.push(id), strip)
  for (const [key, expected] of [['ArrowRight', 'motion'], ['ArrowLeft', 'media'], ['Home', 'media'], ['End', 'motion']]) {
    const event = { key, target: controlTarget('button'), defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true } }
    onKey(event, 1)
    c.dispatch(key, event)
    assert.equal(selected.at(-1), expected)
    assert.equal(focused.at(-1), expected)
    assert.equal(event.stopped, true)
  }
  assert.deepEqual(c.playerCalls, [])
})

test('Delete with Linked selection off removes only the selected clip', () => {
  const c = keyboard({ selection: ['c2'] })
  c.state.linked = false
  c.keys.runEditorCommand('delete')
  const ids = c.state.project.tracks.flatMap(t => t.clips.map(clip => clip.id))
  assert.equal(c.calls[0].unlinked, true)
  assert.equal(ids.includes('c2'), false)
  assert.equal(ids.includes('c2a'), true, 'the linked audio stays when linking is off')
})

test('Deleting or blading a clip never changes its linked partner on a locked track', () => {
  const p = fixture()
  p.tracks[1].locked = true
  for (const op of ['lift', 'ripple_delete', 'delete']) {
    const after = core.applyOps(p, [{ op, ids: ['c2'] }]).project
    assert.deepEqual(after.tracks[1].clips, p.tracks[1].clips, `${op} keeps locked audio`)
    assert.equal(after.tracks[0].clips.some(c => c.id === 'c2'), false)
  }
  const bladed = core.applyOps(p, [{ op: 'blade', id: 'c2', at: 6 }]).project
  assert.deepEqual(bladed.tracks[1].clips, p.tracks[1].clips, 'blade keeps locked audio whole')
  assert.equal(bladed.tracks[0].clips.length, 4)
})

test('a locked linked partner in the selection does not cancel Delete, Cut or Cmd-B', () => {
  for (const command of ['delete', 'rippleDelete', 'cut', 'split']) {
    const p = fixture()
    p.tracks[1].locked = true
    const c = keyboard({ project: p, selection: ['c2', 'c2a'], at: 6 })
    c.keys.runEditorCommand(command)
    const video = c.state.project.tracks[0].clips, audio = c.state.project.tracks[1].clips
    assert.deepEqual(audio, p.tracks[1].clips, `${command} leaves the locked audio alone`)
    if (command === 'split') assert.equal(video.length, 4, 'the unlocked video is cut')
    else assert.equal(video.some(clip => clip.id === 'c2'), false, `${command} removes the unlocked video`)
  }
  const p = fixture()
  p.tracks[0].locked = true
  p.tracks[1].locked = true
  const c = keyboard({ project: p, selection: ['c2', 'c2a'] })
  c.keys.runEditorCommand('delete')
  assert.equal(c.calls.length, 0)
  assert.match(c.notices.at(-1), /locked/)
})

test('with Linked selection off, Cmd-B cuts only the selected audio', () => {
  const c = keyboard({ selection: ['c2a'], at: 6 })
  c.state.linked = false
  c.keys.runEditorCommand('split')
  assert.equal(c.calls[0][0].unlinked, true)
  assert.equal(c.state.project.tracks[1].clips.length, 4)
  assert.equal(c.state.project.tracks[0].clips.length, 3, 'the linked picture stays whole')
})

test('moving, nudging or disabling a clip leaves its linked partner on a locked track alone', () => {
  const p = fixture()
  p.tracks[1].locked = true
  const moved = core.applyOps(p, [{ op: 'move', id: 'c2', start: 6 }]).project
  assert.equal(moved.tracks[0].clips.find(c => c.id === 'c2').start, 6)
  assert.deepEqual(moved.tracks[1].clips, p.tracks[1].clips, 'move keeps locked audio in place')
  const c = keyboard({ project: p, selection: ['c2', 'c2a'] })
  c.dispatch('.')
  assert.ok(Math.abs(c.state.project.tracks[0].clips.find(clip => clip.id === 'c2').start - (4 + 1 / 30)) < 1e-3, 'period nudges the video a frame')
  c.dispatch('v')
  assert.equal(c.state.project.tracks[0].clips.find(clip => clip.id === 'c2').enabled, false)
  assert.deepEqual(c.state.project.tracks[1].clips, p.tracks[1].clips)
})

test('Duplicate and freeze skip locked clips and respect Linked selection', () => {
  const off = keyboard({ selection: ['c2'] })
  off.state.linked = false
  off.keys.runEditorCommand('duplicate')
  assert.equal(off.calls[0][0].unlinked, true)
  assert.equal(off.state.project.tracks[1].clips.length, 3, 'the linked audio is not duplicated')

  const p = fixture()
  p.tracks[0].locked = true
  const dup = keyboard({ project: p, selection: ['c2'] })
  dup.keys.runEditorCommand('duplicate')
  assert.equal(dup.calls.length, 0)
  assert.match(dup.notices.at(-1), /locked/)

  const frozen = keyboard({ project: p, selection: ['c2', 'c2a'], at: 5 })
  frozen.dispatch('f', { altKey: true })
  assert.equal(frozen.calls.length, 0, 'no freeze on a locked video clip')
  assert.match(frozen.notices.at(-1), /unlocked track/)
})

test('Cut copies only the clips it removes, and Cmd-T never falls back past a locked selection', () => {
  const p = fixture()
  p.tracks[1].locked = true
  const cut = keyboard({ project: p, selection: ['c2', 'c2a'] })
  cut.keys.runEditorCommand('cut')
  assert.deepEqual(cut.state.copied, ['c2'], 'the locked audio is not put on the clipboard')

  const t = keyboard({ project: p, selection: ['c2a'], at: 8.2 })
  t.dispatch('t', { metaKey: true })
  assert.equal(t.calls.length, 0, 'no transition on a nearby clip when the selection is locked')
  assert.match(t.notices.at(-1), /locked/)
})

test('nudge and trim to playhead explain when every selected clip is locked', () => {
  for (const [key, options] of [['.', {}], [',', {}], ['[', { altKey: true }]]) {
    const p = fixture()
    p.tracks[0].locked = true
    p.tracks[1].locked = true
    const c = keyboard({ project: p, selection: ['c2', 'c2a'], at: 5 })
    c.dispatch(key, options)
    assert.equal(c.calls.length, 0, key)
    assert.match(c.notices.at(-1) ?? '', /locked/, key)
  }
})

test('nudging left near zero moves every selected clip by the same amount', () => {
  const c = keyboard({ selection: ['c1', 'c2'] })
  c.state.linked = false
  c.dispatch(',')
  const starts = ['c1', 'c2'].map(id => c.state.project.tracks[0].clips.find(clip => clip.id === id).start)
  assert.deepEqual(starts, [0, 4], 'the clip at zero stops the whole group')
})

test('the browser Assistant sends a prompt on Return, and anything on Command-Return, never on Shift-Return', () => {
  // composer-refinement.test.mjs drives the keys; this pins the rule to the Mac Assistant's.
  const chat = fs.readFileSync(new URL('web/ui/chat.js', editor), 'utf8')
  assert.match(chat, /e\.key === 'Enter' && !e\.shiftKey && !e\.altKey && !e\.ctrlKey && \(e\.metaKey \|\| draft\.inputKind === 'prompt'\)\)/)
})

test('nudge follows the Linked toggle', () => {
  const on = keyboard({ selection: ['c2'] })
  on.dispatch('.')
  assert.deepEqual(on.calls[0].map(op => [op.id, op.unlinked]), [['c2', undefined]])
  assert.ok(Math.abs(on.state.project.tracks[1].clips.find(c => c.id === 'c2a').start - (4 + 1 / 30)) < 1e-3, 'the linked audio moves too')
  const pair = keyboard({ selection: ['c2', 'c2a'] })
  pair.dispatch('.')
  assert.equal(pair.calls[0].length, 1, 'one move per linked group')
  const off = keyboard({ selection: ['c2'] })
  off.state.linked = false
  off.dispatch('.')
  assert.deepEqual(off.calls[0].map(op => [op.id, op.unlinked]), [['c2', true]])
  assert.equal(off.state.project.tracks[1].clips.find(c => c.id === 'c2a').start, 4, 'the audio stays when linking is off')
})

test('nudging a clip already at zero to the left does nothing and says nothing', () => {
  const c = keyboard({ selection: ['c1', 'c1a'] })
  c.dispatch(',')
  assert.equal(c.calls.length, 0)
  assert.deepEqual(c.notices, [])
})

test('Cut clears the selection, as Delete does, so later keys do not name removed clips', () => {
  const c = keyboard({ selection: ['c2', 'c2a'] })
  c.keys.runEditorCommand('cut')
  assert.deepEqual(c.state.selection, [])
  c.dispatch('v')
  assert.deepEqual(c.notices, [])
})

test('the Inspector hides the Audio tab on a video whose audio was detached', () => {
  const source = fs.readFileSync(new URL('../web/ui/inspector.js', import.meta.url), 'utf8')
  assert.match(source, /clip\.kind === 'video' && !clip\.link && !clip\.audioDetached && p\.assets\[clip\.src\]\?\.hasAudio\) \? \['audio', 'Audio'\]/)
})

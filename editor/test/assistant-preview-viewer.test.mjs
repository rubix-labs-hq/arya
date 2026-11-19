import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import vm from 'node:vm'

// "Show in viewer" on an assistant preview card. The viewer and playback draw the project with
// the proposal applied in memory; nothing is saved, edits are refused and the preview ends on
// Apply, Discard, a version change or a new proposal.
globalThis.innerWidth = 1000
globalThis.apiCalls = []
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'preact/hooks') return { url: 'arya-preview-fixture:hooks', shortCircuit: true }
    if (specifier.startsWith('/core/')) return next(new URL(`../core/${specifier.slice(6)}`, import.meta.url).href, context)
    const url = new URL(specifier, context.parentURL ?? import.meta.url).href
    if (url.endsWith('/web/host.js')) return { url: 'arya-preview-fixture:host', shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === 'arya-preview-fixture:hooks') return { format: 'module', shortCircuit: true, source: 'export const useEffect = () => {}; export const useReducer = () => [0, () => {}]; export const useState = value => [value, () => {}]' }
    if (url === 'arya-preview-fixture:host') return { format: 'module', shortCircuit: true, source: 'export const api = async (route, body) => { globalThis.apiCalls.push([route, body?.id]); return { project: null, version: 0 } }; export const host = {}' }
    return next(url, context)
  },
})
const { applyOps, newProject } = await import('../core/project.js')
const { drawnProject, edit, previewProject, previewing, refusePreviewEdit, set, store, time, toast, viewProject } = await import('../web/ui/store.js')
const { proposalOps } = await import('../core/proposal-ops.js')
const { PreviewBanner } = await import('../web/ui/preview-banner.js')
const showPreview = id => set(id == null ? { previewShown: null } : { previewShown: { id }, viewerMode: 'timeline' })

function project() {
  const p = newProject('Sample', { fps: 30 })
  p.assets['media/a.mp4'] = { duration: 10, width: 1920, height: 1080, hasVideo: true, hasAudio: false }
  return applyOps(p, [{ op: 'append', src: 'media/a.mp4', track: 'V1', dur: 6 }, { op: 'add_comp', name: 'Scene', duration: 4 }]).project
}
const titles = p => p.tracks.flatMap(track => track.clips).filter(clip => clip.kind === 'title').map(clip => clip.title.text)
const proposal = (id, extra = {}) => ({ id, baseVersion: 5, stale: false, summary: 'Add a title', ops: [{ op: 'add_title', text: 'Sample title', track: 'V3', start: 1, dur: 2 }], steps: [], assets: {}, ...extra })

function reset(p = project()) {
  set({ project: p, version: 5, root: '/tmp/sample', openComp: null, previewShown: null, assistantReview: { proposal: proposal('a') }, toasts: [] })
  globalThis.apiCalls.length = 0
  return p
}

test('the viewer draws the proposal applied in memory while the saved project stays as it was', () => {
  const p = reset()
  assert.equal(previewProject(), null)
  assert.equal(drawnProject(), p, 'without a shown preview the viewer draws the timeline being edited')
  showPreview('a')
  assert.ok(previewing())
  assert.deepEqual(titles(drawnProject()), ['Sample title'])
  assert.equal(store.project, p, 'the project is not changed')
  assert.equal(viewProject(), p, 'edits and exports still read the saved project')
  assert.deepEqual(titles(store.project), [])
  assert.equal(store.viewerMode, 'timeline')
  assert.deepEqual(globalThis.apiCalls, [], 'nothing is sent to the server')
  const drawn = drawnProject()
  set({ playing: true, rate: 1, assistantReview: { proposal: { ...store.assistantReview.proposal } } })
  assert.equal(drawnProject(), drawn, 'an unrelated update or a resent review keeps one drawn project, so playback does not restart')
  set({ openComp: 'k1' })
  assert.equal(drawnProject().compId, 'k1', 'an open composition is drawn from the previewed project')
  set({ openComp: null })
  showPreview(null)
  assert.equal(store.previewShown, null)
  assert.equal(drawnProject(), p)
})

test('the preview ends on Apply, Discard, a version change, a new proposal or a stale one', () => {
  for (const [name, patch] of [
    ['applied (the version moves)', { version: 6 }],
    ['discarded', { assistantReview: { proposal: null } }],
    ['replaced by a new proposal', { assistantReview: { proposal: proposal('b') } }],
    ['stale', { assistantReview: { proposal: proposal('a', { stale: true }) } }],
    ['another project', { root: '/tmp/other' }],
  ]) {
    reset()
    showPreview('a')
    assert.ok(previewing(), name)
    set(patch)
    assert.equal(previewProject(), null, name)
    assert.equal(store.previewShown, null, `${name}: forgotten for good`)
    set({ version: 5, root: '/tmp/sample', assistantReview: { proposal: proposal('a') } })
    assert.equal(previewing(), false, `${name}: does not come back`)
  }
  reset()
  set({ assistantReview: { proposal: proposal('c', { ops: [{ op: 'update', id: 'missing', set: { opacity: 0.5 } }] }) } })
  showPreview('c')
  assert.equal(previewing(), false, 'a preview that cannot apply draws nothing')
  assert.equal(store.previewShown, null)
})

test('an edit while the preview is shown is refused, sends nothing and puts back a control’s local copy', async () => {
  const p = reset()
  showPreview('a')
  const dragged = applyOps(p, [{ op: 'update', id: 'c1', set: { opacity: 0.4 } }]).project
  set({ project: dragged })
  assert.deepEqual(titles(drawnProject()), ['Sample title'], 'a control drawing its own copy does not change the preview')
  assert.equal(await edit({ op: 'update', id: 'c1', set: { opacity: 0.4 } }), null)
  assert.deepEqual(globalThis.apiCalls, [])
  assert.equal(store.project, p, 'the saved project is back')
  assert.ok(store.toasts.some(item => /Editing is off while the viewer shows the assistant preview/.test(item.text)))
  assert.ok(previewing(), 'the preview stays shown')
  showPreview(null)
  assert.equal(refusePreviewEdit(), false, 'editing works again once the preview is not shown')
})

test('the card and the viewer apply the same ops, with the media a proposal brings imported first', () => {
  const p = project()
  assert.deepEqual(proposalOps(p, { ops: [{ op: 'add_title' }] }), [{ op: 'add_title' }])
  const assets = { 'media/a.mp4': { duration: 10 }, 'media/b.mp4': { duration: 3 } }
  assert.deepEqual(proposalOps(p, { ops: [{ op: 'append', src: 'media/b.mp4' }], assets }), [{ op: 'import', assets: { 'media/b.mp4': { duration: 3 } } }, { op: 'append', src: 'media/b.mp4' }])
})

test('showing records the saved project, and waits while an edit is still saving', async () => {
  const p = reset()
  set({ previewShown: { id: 'a' } })
  assert.deepEqual({ ...store.previewShown }, { id: 'a', base: p, version: 5, root: '/tmp/sample' })
  set({ previewShown: null })
  const saving = edit({ op: 'update', id: 'c1', set: { opacity: 0.5 } })
  set({ previewShown: { id: 'a' } })
  assert.equal(store.previewShown, null, 'the optimistic copy of an unsaved edit is not a base to preview over')
  await saving
})

const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const nodes = value => value && typeof value === 'object' ? [value, ...flatten(value.props?.children).flatMap(nodes)] : []
const text = value => flatten(value?.props?.children).map(child => typeof child === 'object' ? text(child) : String(child)).join(' ').replace(/\s+/g, ' ').trim()
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && text(node) === label)

test('the banner over the viewer says it shows the preview and offers Apply, Discard and Back to project', async () => {
  reset()
  showPreview('a')
  const tree = PreviewBanner()
  assert.match(text(tree), /^Preview Add a title \. Nothing is saved until you apply, and editing is off\./)
  // On a phone the banner is one row (label, Apply, Discard) over a frame that takes the viewer's width.
  const css = readFileSync(new URL('../web/ui/assistant.css', import.meta.url), 'utf8')
  const phone = css.slice(css.indexOf('/* On a phone the preview takes the viewer'))
  assert.match(phone, /\.viewer-preview-banner :is\(\.viewer-preview-copy, \.viewer-preview-steps\) \{ position: absolute; width: 1px;/)
  assert.match(phone, /\.viewer-preview-banner \.viewer-preview-back \{ display: none; \}/)
  assert.match(phone, /\.page\.phone-edit \.viewer\.showing-preview :is\(\.viewer-bar, \.viewer-info, \.transport \.buttons\.right\) \{ display: none; \}/)
  assert.doesNotMatch(text(tree), /processing step/)
  button(tree, 'Apply').props.onClick()
  button(tree, 'Discard').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(globalThis.apiCalls, [['/api/assistant/proposal/apply', 'a'], ['/api/assistant/proposal/discard', 'a']])
  button(tree, 'Back to project').props.onClick()
  assert.equal(store.previewShown, null)
  set({ assistantReview: { proposal: proposal('s', { steps: [{ path: '/api/video/denoise', body: {}, preview: { title: 'Denoise' } }, { path: '/api/retime', body: {}, preview: { title: 'Retime' } }] }) } })
  assert.match(text(PreviewBanner()), /The viewer shows the edits only\. 2 processing steps run after you apply and are not shown\./)
  set({ claude: { state: 'working', startedAt: Date.now() } })
  assert.equal(button(PreviewBanner(), 'Apply').props.disabled, true, 'Apply waits for the assistant, as on the card')
  set({ claude: { state: 'idle' }, assistantReview: { proposal: null } })
  assert.equal(PreviewBanner(), null)
})

// The real functions from keys.js and color/panels.js, run against this store.
const extract = (file, name) => fs.readFileSync(new URL(`../web/ui/${file}`, import.meta.url), 'utf8').match(new RegExp(`export function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))[0].replace('export ', '')

test('Undo, Redo and grabbing a still are refused while the preview is shown', async () => {
  reset()
  const sent = [], grabbed = []
  const moveHistory = new Function('store', 'api', 'set', 'toast', `${extract('keys.js', 'moveHistory')}\nreturn moveHistory`)(store, async route => { sent.push(route); return { project: store.project, version: store.version } }, set, toast)
  const canvas = { toDataURL: () => { grabbed.push(true); return 'data:image/jpeg;base64,' } }
  const grabStill = new Function('store', 'canvas', 'time', 'timecode', 'set', 'toast', `${extract('color/panels.js', 'grabStill')}\nreturn grabStill`)(store, canvas, time, () => '00:00:00:00', set, toast)
  showPreview('a')
  assert.equal(await moveHistory('undo'), null)
  assert.equal(await moveHistory('redo'), null)
  assert.equal(grabStill({ id: 'c1' }), null)
  assert.deepEqual([sent, grabbed], [[], []])
  assert.ok(store.toasts.some(item => /Undo and Redo are off while the viewer shows the assistant preview/.test(item.text)))
  assert.ok(store.toasts.some(item => /Go back to the project to grab a still/.test(item.text)))
  set({ previewShown: null })
  await moveHistory('undo')
  assert.ok(grabStill({ id: 'c1' }))
  assert.deepEqual([sent, grabbed.length], [['/api/undo'], 1], 'both work again once the preview is not shown')
})

// Runs engine-host.js itself against the real store, with the engine classes stubbed, so the
// player, its identity, its looks and the audio preload are checked by what they return.
function engineHost() {
  const log = { luts: [], preload: [], refresh: 0 }
  let listener = null
  const context = vm.createContext({
    document: { createElement: () => ({}) },
    Compositor: class { resize() {} clearLuts() {} },
    Media: class { reset() {} },
    AudioEngine: class { constructor() { this.buffers = new Map() } stop() {} preload(p) { log.preload.push(p) } },
    Player: class { constructor(options) { Object.assign(this, options) } refresh() { log.refresh++ } requestExact() {} seek() {} pause() {} },
    loadLuts: (comp, p) => { log.luts.push(p) },
    api() {}, drawnProject, previewProject, set, setTime() {}, store, subscribe: fn => { listener = fn }, setInterval() {}, host: { kind: 'server' },
  })
  const source = fs.readFileSync(new URL('../web/ui/engine-host.js', import.meta.url), 'utf8')
  vm.runInContext(source.replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\nglobalThis.engine = player', context)
  return { player: context.engine, log, notify: () => listener() }
}

test('the engine draws and identifies the shown preview, and loads its looks', () => {
  const p = reset()
  const { player, log, notify } = engineHost()
  const frame = { fps: 30, compId: null }
  assert.equal(player.getProject(), p, 'without a preview the engine draws the saved project')
  showPreview('a')
  notify()
  const drawn = player.getProject()
  assert.deepEqual(titles(drawn), ['Sample title'], 'the player draws the proposal applied')
  assert.equal(player.getProjectIdentity(), previewProject())
  assert.notEqual(player.getProjectIdentity(), p)
  player.prepareFrame(frame, 0)
  assert.deepEqual(titles(log.luts.at(-1)), ['Sample title'], 'looks load from the previewed project')
  assert.deepEqual(titles(log.preload.at(-1)), ['Sample title'], 'audio is prepared for the previewed project')
  const refreshes = log.refresh
  set({ openComp: 'k1' })
  notify()
  assert.equal(player.getProject().compId, 'k1', 'an open composition is drawn from the preview')
  assert.ok(log.refresh > refreshes)
  set({ openComp: null })
  showPreview(null)
  notify()
  assert.equal(player.getProject(), p, 'Back to project draws the saved project again')
  assert.equal(player.getProjectIdentity(), p)
  player.prepareFrame(frame, 0)
  assert.equal(log.luts.at(-1), p)
  assert.equal(log.preload.at(-1), p)
})

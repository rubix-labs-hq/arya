import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

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
    if (url === 'arya-preview-fixture:hooks') return { format: 'module', shortCircuit: true, source: 'export const useEffect = () => {}; export const useReducer = () => [0, () => {}]' }
    if (url === 'arya-preview-fixture:host') return { format: 'module', shortCircuit: true, source: 'export const api = async (route, body) => { globalThis.apiCalls.push(route); return { project: null, version: 0 } }; export const host = {}' }
    return next(url, context)
  },
})
const { applyOps, newProject } = await import('../core/project.js')
const { drawnProject, edit, previewProject, previewing, refusePreviewEdit, set, showPreview, store, viewProject } = await import('../web/ui/store.js')
const { proposalOps } = await import('../web/ui/assistant-preview.js')

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

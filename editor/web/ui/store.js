// Editor state: one observable store, synced with the server over SSE.
// Edits apply locally at once (optimistic) and the server's answer replaces them.

import { useEffect, useReducer } from 'preact/hooks'
import { applyOps, compView } from '/core/project.js'
import { api, host } from '../host.js'
import { changeReceipt } from './change-receipt.js'

const listeners = new Set()

export const store = {
  project: null,
  version: 0,
  root: '',
  page: 'edit',
  tool: 'select', // select | blade | trim | slip | slide | hand | range
  snapping: true,
  linked: true,
  skimming: false,
  selection: [], // clip ids
  selMarker: null,
  selTrack: null,
  zoom: 80, // px per second
  scroll: 0, // seconds at the left edge
  trackHeight: {},
  refs: [],
  chat: [],
  chatHistory: null,
  claude: { state: 'idle', text: '' },
  activity: [],
  receipts: [],
  jobs: [],
  toasts: [],
  playing: false,
  rate: 0,
  loop: false,
  connected: false,
  inspectorTab: 'video',
  browserTab: 'media',
  chatOpen: innerWidth >= 1200,
  viewerScale: 'fit',
  previewQuality: 'half',
  overlays: { safe: false, grid: false },
  source: null, // { src, in, out, t }
  viewerMode: 'timeline',
  caps: {},
  settingsOpen: false,
  assistantStatus: null,
  assistantStatusError: '',
  assistantReview: null, // { proposal, change } from the server: the pending preview and the latest assistant change
  assistantPreview: (() => { try { return globalThis.localStorage?.getItem('arya.assistant.preview') !== 'off' } catch { return true } })(), // preview assistant edits before they apply
  clipboard: null,
  highlight: new Map(), // clip id → time it was last touched by Claude
  scopes: { kind: 'waveform' },
  colorClip: null,
  openComp: null, // composition shown in the viewer and timeline (null = main timeline)
}

/** The timeline being edited: the main one, or the open composition as a project-shaped view. */
export function viewProject() {
  const p = store.project
  if (!p || !store.openComp || !p.comps?.[store.openComp]) return p

  return compView(p, store.openComp)
}

/** Ops from the UI act inside the open composition unless they name a clip (which scopes itself). */
function scoped(ops) {
  if (!store.openComp) return ops

  const markerOps = ['marker', 'markers', 'update_marker', 'delete_marker']
  return ops.map(op => (Object.hasOwn(op, 'comp') || !markerOps.includes(op.op) && ((op.id && !['update_track', 'delete_track'].includes(op.op)) || op.ids || op.a || op.target || ['import', 'project', 'add_comp', 'replace'].includes(op.op)) ? op : { ...op, comp: store.openComp }))
}

// History metadata is display-only. It cannot restore a run, route or sharing grant.
export function chatHistoryStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return { restored: Number.isSafeInteger(value.restored) && value.restored >= 0 && value.restored <= 200 ? value.restored : null,
    warning: typeof value.warning === 'string' && value.warning.trim() ? value.warning.slice(0, 500) : null,
    savingAvailable: typeof value.savingAvailable === 'boolean' ? value.savingAvailable : null }
}

export function set(patch) {
  const next = typeof patch === 'function' ? patch(store) : patch
  const changedComp = Object.hasOwn(next, 'openComp') && next.openComp !== store.openComp
  Object.assign(store, next, changedComp ? { selMarker: null } : {})
  for (const l of listeners) l()
}

export function subscribe(fn) {
  listeners.add(fn)

  return () => listeners.delete(fn)
}

/** Re-renders the component on any store change. */
export function useStore() {
  const [, force] = useReducer(x => x + 1, 0)
  useEffect(() => subscribe(force), [])

  return store
}

// A separate, high-frequency channel for the playhead.
const timeListeners = new Set()
export const time = { t: 0 }
export function setTime(t) {
  time.t = t
  for (const l of timeListeners) l(t)
}
export function useTime() {
  const [, force] = useReducer(x => x + 1, 0)
  useEffect(() => {
    let raf = 0
    const fn = () => {
      if (!raf) raf = requestAnimationFrame(() => ((raf = 0), force()))
    }
    timeListeners.add(fn)

    return () => timeListeners.delete(fn)
  }, [])

  return time.t
}
export function onTime(fn) {
  timeListeners.add(fn)

  return () => timeListeners.delete(fn)
}

export function toast(text, kind = 'info') {
  const id = Math.random().toString(36).slice(2)
  set(s => ({ toasts: [...s.toasts, { id, text, kind }] }))
  setTimeout(() => set(s => ({ toasts: s.toasts.filter(x => x.id !== id) })), kind === 'error' ? 6000 : 3000)
}

export { api }

let pending = 0
let editRecovery = null
const currentEditRecovery = () => editRecovery?.root === store.root ? editRecovery : null

export function hasPendingEdits() { return pending > 0 || Boolean(currentEditRecovery()) }

export function editRecoveryStatus() {
  const recovery = currentEditRecovery()
  return recovery ? { reason: recovery.reason, retrying: recovery.retrying, canRetry: pending === 0 && !recovery.retrying } : null
}

export async function retryEditRecovery() {
  const recovery = currentEditRecovery()
  if (!recovery || recovery.retrying || pending > 0) return false
  const source = { root: store.root, version: store.version, project: store.project }
  recovery.retrying = true
  set({})
  try {
    const res = await api('/api/project')
    if (currentEditRecovery() !== recovery || store.root !== source.root || store.version !== source.version || store.project !== source.project) throw new Error('The project changed during sync. Retry for the current project.')
    if (!Number.isSafeInteger(res?.version) || res.version < source.version || !Array.isArray(res?.project?.tracks)) throw new Error('The project sync response could not be verified. Retry before saving a component.')
    editRecovery = null
    set({ project: res.project, version: res.version })
    return true
  } catch (error) {
    if (currentEditRecovery() === recovery) recovery.reason = `Project sync failed. ${String(error.message ?? error).slice(0, 500)}`
    return false
  } finally {
    recovery.retrying = false
    set({})
  }
}

/** Applies ops now and on the server. Returns the server's log and created ids. */
export async function edit(ops, summary, options = {}) {
  if (!store.project) return null
  const expectedVersion = options?.expectedVersion
  if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || expectedVersion !== store.version || pending > 0)) {
    toast('This form is out of date. Wait for pending edits, then reopen it before applying changes.', 'error')
    return null
  }
  if (!Array.isArray(ops)) ops = [ops]
  ops = scoped(ops)
  try {
    const local = applyOps(store.project, ops)
    set({ project: local.project })
  } catch (error) {
    toast(error.message, 'error')

    return null
  }
  pending++
  const editRoot = store.root
  try {
    const res = await api('/api/ops', { ops, summary, who: 'you', returnProject: true, ...(expectedVersion === undefined ? {} : { expectedVersion }) })
    if (res.version >= store.version) set({ project: res.project, version: res.version })

    return res
  } catch (error) {
    toast(error.message, 'error')
    try {
      const res = await api('/api/project')
      set({ project: res.project, version: res.version })
    } catch (recoveryError) {
      editRecovery = { root: editRoot, retrying: false, reason: `Project sync failed. ${String(recoveryError.message ?? recoveryError).slice(0, 500)}` }
      throw recoveryError
    }

    return null
  } finally {
    pending--
    set({})
  }
}

export function connect(onProject) {
  return host.events({
    hello: () => set({ connected: true }),
    error: () => set({ connected: false }),
    project: d => {
      if (d.version < store.version) return
      if (d.who === 'you' && pending > 0) {
        set({ version: d.version })

        return
      }
      const highlight = new Map(store.highlight)
      const receipt = changeReceipt(store.project, d.project, { version: d.version, who: d.who, at: d.at })
      let receipts = store.receipts
      if (receipt) {
        receipts = [...receipts, { ...receipt, displayBytes: JSON.stringify(receipt).length }].slice(-30)
        let bytes = receipts.reduce((sum, item) => sum + (item.displayBytes ?? 0), 0)
        while (receipts.length > 1 && bytes > 4 * 1024 * 1024) bytes -= receipts.shift().displayBytes ?? 0
      }
      if (d.who !== 'you' && store.project && d.project) {
        // Include changed layers in nested compositions.
        if (receipt) for (const clip of receipt.clips) if (clip.status !== 'deleted') highlight.set(clip.id, performance.now())
      }
      set({ ...(host.kind === 'browser-local' && d.root && d.root !== store.root ? { root: d.root, source: null, selection: [], selMarker: null, selTrack: null, openComp: null, viewerMode: 'timeline', jobs: d.jobs ?? [] } : {}), project: d.project, version: d.version, highlight, receipts })
      onProject?.(d)
    },
    activity: a => set(s => ({ activity: [...s.activity, a].slice(-60) })),
    chat: c => set({ chat: c }),
    chatHistory: value => set({ chatHistory: chatHistoryStatus(value) }),
    claude: c => set({ claude: c }),
    assistantReview: value => set({ assistantReview: value }),
    // The assistant shows the user a moment or layers; engine-host seeks on seekRequest.
    uiShow: value => set({
      ...(value.comp !== undefined ? { openComp: value.comp } : {}),
      ...(Array.isArray(value.ids) ? { selection: value.ids } : {}),
      ...(value.page ? { page: value.page } : {}),
      ...(Number.isFinite(value.at) ? { seekRequest: { at: value.at, id: value.id } } : {}),
    }),
    job: job => set(s => ({ jobs: [...s.jobs.filter(j => j.id !== job.id), job].slice(-30) })),
    media: () => set(s => ({ project: { ...s.project } })),
  })
}

export function selectedClips() {
  const p = store.project
  if (!p) return []
  const ids = new Set(store.selection)

  return p.tracks.flatMap(t => t.clips.filter(c => ids.has(c.id)).map(c => ({ track: t, clip: c })))
}

export function addRef(ref) {
  const captured = ref.kind === 'marker' ? { ...ref, comp: Object.hasOwn(ref, 'comp') ? ref.comp : store.openComp ?? null, context: ref.context ?? { projectRoot: store.root, projectVersion: store.version } } : ref
  set(s => ({ refs: [...s.refs.filter(r => !(r.kind === captured.kind && r.id === captured.id && (r.kind !== 'marker' || r.comp === captured.comp))), captured].slice(-16), chatOpen: true }))
  toast(`${ref.label} added to the Assistant context`)
}

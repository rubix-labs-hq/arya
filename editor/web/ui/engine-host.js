// One compositor, player and audio engine for the whole editor. The viewer canvas is
// created once and moved into whichever page's viewer is mounted.

import { AudioEngine } from '../engine/audio.js'
import { Compositor } from '../engine/compositor.js'
import { Media } from '../engine/media.js'
import { Player } from '../engine/player.js'
import { loadLuts } from '../engine/worker.js'
import { api, set, setTime, store, subscribe, viewProject } from './store.js'
import { host } from '../host.js'

export const canvas = document.createElement('canvas')
canvas.className = 'viewer-canvas'
export const comp = new Compositor(canvas)
export const media = new Media()
export const audio = new AudioEngine()
export const player = new Player({
  comp,
  media,
  audio,
  getProject: () => viewProject(),
  getProjectIdentity: () => store.project,
  prepareFrame: (p, at, { playback = false, to } = {}) => loadLuts(comp, store.project, playback ? { from: at, frames: Math.max(1, Math.ceil((to - at) * p.fps)), fps: p.fps, comp: p.compId } : { at, comp: p.compId }),
  onTime: t => setTime(t),
  onState: s => set({ playing: s.playing, rate: s.rate }),
})

const SCALE = { full: 1, half: 0.5, quarter: 0.25 }

export function applyQuality() {
  const p = viewProject()
  if (!p) return
  const s = SCALE[store.previewQuality] ?? 0.5
  comp.resize(Math.max(2, Math.round((p.width * s) / 2) * 2), Math.max(2, Math.round((p.height * s) / 2) * 2))
}

let lastRoot = null
let lastProject = null
let lastQuality = null
let lastUi = 0
let lastView = null
let lastSeek = null
subscribe(() => {
  if (host.kind === 'browser-local' && store.root !== lastRoot) {
    lastRoot = store.root; player.pause(); media.reset(); audio.stop(); audio.buffers.clear(); comp.clearLuts(); lastProject = null; lastView = null
  }
  const p = viewProject()
  if (p !== lastView && p && lastView && p.compId !== lastView.compId) {
    lastProject = null
  }
  lastView = p
  if (!p) return
  if (store.previewQuality !== lastQuality || !lastProject || lastProject.width !== p.width || lastProject.height !== p.height) {
    lastQuality = store.previewQuality
    applyQuality()
    player.requestExact()
  }
  if (p !== lastProject) {
    lastProject = p
    player.refresh()
    audio.preload(p)
  }
  player.loop = store.loop
  if (store.seekRequest && store.seekRequest !== lastSeek) {
    lastSeek = store.seekRequest
    player.seek(store.seekRequest.at)
  }
})

// Tell the server where the playhead and selection are, so Claude sees them.
setInterval(() => {
  const now = Date.now()
  if (now - lastUi < 900) return
  lastUi = now
  api('/api/ui-state', { playhead: Math.round(player.t * 1000) / 1000, selection: store.selection, marker: store.selMarker, track: store.selTrack, page: store.page, openComp: store.openComp ?? null }).catch(() => {})
}, 1000)

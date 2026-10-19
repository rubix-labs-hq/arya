// Media page: the bin at full size, a source monitor, media details, analysis tools,
// and transcript-based editing (select words, put them on the timeline).

import { h } from 'preact'
import htm from 'htm'
import { timecode } from '/core/project.js'
import { analyzeMenu, Browser } from './browser.js'
import { useStore } from './store.js'
import { Transcript } from './transcript.js'
import { Viewer } from './viewer.js'

const html = htm.bind(h)

function Details() {
  const s = useStore()
  const src = s.source?.src
  const a = src ? s.project.assets[src] : null
  if (!a) return html`<div class="empty-hint">Click a clip in the media list to see its format, codec and audio.</div>`
  const rows = [
    ['File', src],
    ['Duration', a.duration ? timecode(a.duration, Math.round(a.fps || 30)) : 'still'],
    ['Frame size', a.width ? `${a.width} × ${a.height}` : '—'],
    ['Frame rate', a.fps ?? '—'],
    ['Codec', `${a.codec ?? '—'} ${a.pixFmt ? `(${a.pixFmt})` : ''}`],
    ['Audio', a.hasAudio ? `${a.channels ?? 2} ch` : 'none'],
    ['Size', a.size ? `${(a.size / 1e6).toFixed(1)} MB` : '—'],
    ['Playback', a.proxy ? `proxy ${a.proxy.split('/').pop()}` : 'original'],
  ]

  return html`
    <div class="details">
      ${rows.map(([k, v]) => html`<div class="kv"><span>${k}</span><b title=${String(v)}>${String(v)}</b></div>`)}
      <h4>Analyze</h4>
      ${s.caps.host === 'native' ? html`<div class="hint">Apple Speech is available here. Open the browser editor for scene, silence, beat and source loudness analysis.</div>` : null}
      <div class="analyze-list">${analyzeMenu(s.project, src).filter(i => !i.sep).map(i => html`<button class=${`ghost ${i.danger ? 'danger' : ''}`} disabled=${i.disabled} onClick=${i.run}>${i.label}</button>`)}</div>
    </div>
  `
}

export function MediaPage() {
  return html`
    <div class="page media">
      <div class="media-left"><${Browser} /></div>
      <div class="media-center"><${Viewer} /><div class="panel transcript-panel"><${Transcript} /></div></div>
      <div class="panel media-right"><h3>Details</h3><${Details} /></div>
    </div>
  `
}

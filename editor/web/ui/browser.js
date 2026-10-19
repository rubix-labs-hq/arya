// Left panel: media bin, titles, transitions, effects and generators.

import { h } from 'preact'
import { ScrollTabs } from './scroll-tabs.js'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { EFFECTS, timecode, TRANSITIONS } from '/core/project.js'
import { openMenu } from './menu.js'
import { addRef, api, edit, set, store, subscribe, time, toast, useStore, viewProject } from './store.js'
import { host } from '../host.js'
import { registry } from './registry.js'
import { runTranscriptJob } from './transcript-jobs.js'
import { importMediaPaths, uploadMediaFiles } from './media-import.js'
import { mediaDisplayModel, mediaDisplayName, mediaMatchesQuery } from './media-label.js'
import { titlePresetOp } from './title-presets.js'

const html = htm.bind(h)

function BrowserSections({ tab }) {
  return registry.browserSections.filter(section => section.tab === tab).map(section => h(section.component, { key: section.id, project: store.project }))
}

export const TITLE_PRESETS = [
  { name: 'Basic Title', text: 'Your Title', title: { font: 'Avenir Next', weight: 800, size: 140, color: '#ffffff', anim: 'rise', shadow: { color: '#00000099', blur: 18, x: 0, y: 6 } } },
  { name: 'Lower Third', text: 'Jane Doe\nDirector', set: { x: 520, y: 900 }, title: { font: 'Avenir Next', weight: 700, size: 54, color: '#ffffff', align: 'left', plate: '#000000b0', padding: 26, radius: 8, anim: 'slideRight', lineHeight: 1.25 } },
  { name: 'Big Bold', text: 'BIG IDEA', title: { font: 'Futura', weight: 900, size: 220, color: '#f5b942', anim: 'pop', stroke: { color: '#000000', width: 4 } } },
  { name: 'Subtitle', text: 'Subtitle text goes here', set: { y: 960 }, title: { font: 'Helvetica Neue', weight: 600, size: 52, color: '#ffffff', plate: '#00000088', padding: 14, radius: 6, anim: 'fade' } },
  { name: 'Typewriter', text: 'Once upon a time…', title: { font: 'Menlo', weight: 500, size: 72, color: '#e8e8e8', anim: 'typewriter' } },
  { name: 'Cinematic', text: 'T H E   E N D', title: { font: 'Didot', weight: 400, size: 110, color: '#ffffff', anim: 'tracking', tracking: 8 } },
  { name: 'Chapter Card', text: 'Chapter One', title: { font: 'Avenir Next', weight: 300, size: 120, color: '#ffffff', anim: 'blurIn' } },
  { name: 'Gradient', text: 'Glow Up', title: { font: 'Avenir Next', weight: 900, size: 180, gradient: ['#ff7ae0', '#7aa8ff'], anim: 'drop', shadow: { color: '#7a5cff88', blur: 40, x: 0, y: 0 } } },
]

// Placeholder drawings while a thumbnail loads, drawn by CSS (.media-kind-*) in the interface icon style.
const MEDIA_ICON = { video: 'video', audio: 'audio', image: 'image' }

function uploadFiles(files) {
  if (host.kind !== 'browser-local') return uploadMediaFiles(files, { upload: file => host.upload(file), request: api, notify: toast })
  return (async () => {
  try {
    if (!store.project) await api('/api/new', { name: 'Untitled' })
    const captured = host.browser.context()
    return await uploadMediaFiles(files, { upload: file => { host.browser.assert(captured); return host.upload(file) }, request: (path, body) => { host.browser.assert(captured); return api(path, body) }, notify: toast })
  } catch (error) { toast(error.message, 'error'); return null }
  })()
}

function importFolder(paths, expectedCount) {
  return importMediaPaths(paths, { request: api, notify: toast, expectedCount })
}

export function installDropImport() {
  window.addEventListener('dragover', e => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
  })
  window.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    return uploadFiles([...e.dataTransfer.files])
  })
}

async function showMusicDetails(src = null) {
  const root = store.root, comp = store.openComp ?? null, asset = src === null ? null : JSON.stringify(store.project?.assets?.[src])
  try {
    const { openGeneratedMusicDetails } = await import('./generated-music.js')
    if (!store.project || store.root !== root || (store.openComp ?? null) !== comp || (src !== null && JSON.stringify(store.project.assets?.[src]) !== asset)) throw new Error('The project or source changed. Open its current music details again.')
    openGeneratedMusicDetails(src)
  } catch (error) { toast(error.message, 'error') }
}

export function analyzeMenu(p, src) {
  const asset = p.assets[src] ?? {}

  return [
    { label: 'Reference to Assistant', run: () => addRef({ kind: 'media', id: src, label: mediaDisplayName(src, asset) }) },
    { label: 'Open in source viewer', run: () => openSource(src) },
    asset.generated?.kind === 'original-music' && asset.generated?.renderer === 'arya-score-synth/1' ? { label: 'Music details & reuse…', run: () => showMusicDetails(src) } : null,
    { label: 'Append to timeline', hint: 'E', run: () => edit({ op: 'append', src }) },
    { sep: true },
    asset.hasVideo && asset.duration ? { label: 'Detect scene cuts → markers', disabled: store.caps.analysis?.scenes === false, run: () => analyze(src, 'scenes') } : null,
    asset.hasVideo && asset.duration ? { label: 'Detect scene cuts → split into clips', disabled: store.caps.analysis?.scenes === false, run: () => analyze(src, 'scenes', true) } : null,
    asset.hasAudio ? { label: 'Find silences → remove from timeline', disabled: store.caps.analysis?.silence === false, run: () => analyze(src, 'silence', true) } : null,
    asset.hasAudio ? { label: 'Detect beats → markers', disabled: store.caps.analysis?.beats === false, run: () => analyze(src, 'beats') } : null,
    asset.hasAudio ? { label: 'Measure loudness (LUFS)', disabled: store.caps.analysis?.loudness === false, run: () => analyze(src, 'loudness') } : null,
    asset.hasAudio ? { label: store.caps.transcriber === 'speech' ? 'Transcribe with Apple Speech' : 'Transcribe (whisper)', disabled: store.caps.analysis?.transcript === false, run: () => analyze(src, 'transcript') } : null,
    { sep: true },
    { label: 'Remove from project', danger: true, run: () => api('/api/forget', { paths: [src] }) },
  ].filter(Boolean)
}

export function openSource(src) {
  set({ source: { src, in: undefined, out: undefined }, viewerMode: 'source', page: store.page === 'media' ? 'media' : 'edit' })
}

async function analyze(src, kind, apply = false) {
  if (store.caps.analysis?.[kind] === false) return toast(`Open the browser editor to run ${kind} analysis`, 'error')
  const timelineAnalysis = ['scenes', 'beats', 'silence'].includes(kind)
  const p = timelineAnalysis ? viewProject() : store.project
  const projectIdentity = store.project
  const root = store.root, composition = store.openComp ?? null, version = store.version
  const assetSnapshot = JSON.stringify(p?.assets?.[src])
  toast(`Analyzing ${src.split('/').pop()}…`)
  try {
    const r = kind === 'transcript' ? await runTranscriptJob(api, '/api/analyze', { src, kind, locale: 'en-US' }) : await api('/api/analyze', { src, kind })
    if (timelineAnalysis && (store.project !== projectIdentity || store.root !== root || (store.openComp ?? null) !== composition || store.version !== version || JSON.stringify(store.project?.assets?.[src]) !== assetSnapshot)) throw new Error('The timeline or source changed during analysis. Run it again in the intended composition.')
    // Timeline positions where this source plays, to map source times to the timeline.
    const uses = p.tracks.flatMap(t => t.clips.filter(c => c.src === src && t.kind === (kind === 'scenes' ? 'video' : t.kind)))
    const toTimeline = s => {
      for (const c of uses) {
        const local = (s - (c.in ?? 0)) / (c.speed ?? 1)
        if (local >= 0 && local <= c.dur) return c.start + local
      }

      return uses.length ? null : s
    }
    if (kind === 'scenes') {
      const ts = r.times.map(toTimeline).filter(x => x !== null)
      if (!ts.length) return toast('No scene cuts found')
      if (apply && uses.length) await edit(ts.map(at => ({ op: 'blade', comp: composition, at })), `split at ${ts.length} scene cuts`, { expectedVersion: version })
      else await edit({ op: 'markers', comp: composition, color: '#58a6ff', markers: ts.map((t, i) => ({ t, label: `Cut ${i + 1}` })) }, `${ts.length} scene markers`, { expectedVersion: version })
      toast(`${ts.length} scene cuts`)
    } else if (kind === 'beats') {
      const ts = r.times.map(toTimeline).filter(x => x !== null)
      await edit({ op: 'markers', comp: composition, color: '#bc8cff', markers: ts.map(t => ({ t, label: '' })) }, `${ts.length} beat markers${r.bpm ? ` (${r.bpm} BPM)` : ''}`, { expectedVersion: version })
      toast(`${ts.length} beats${r.bpm ? `, about ${r.bpm} BPM` : ''}`)
    } else if (kind === 'silence') {
      const ranges = silenceTimelineRanges(p, src, r.ranges)
      if (!ranges.length) return toast('No silences long enough to cut')
      if (!apply || !uses.length) return toast(`${ranges.length} silences found; put the clip on the timeline to remove them`)
      const result = await edit(ranges.map(([from, to]) => ({ op: 'delete_range', comp: composition, from, to })), `removed ${ranges.length} silences`, { expectedVersion: version })
      if (!result) return
      toast(`Removed ${ranges.length} silences (${ranges.reduce((s2, [a, b]) => s2 + b - a, 0).toFixed(1)}s)`)
    } else if (kind === 'loudness') {
      toast(`${src.split('/').pop()}: ${r.lufs} LUFS integrated, LRA ${r.lra} LU`)
    } else if (kind === 'transcript') {
      set({ transcript: { ...r, src }, page: 'media' })
      toast(`Transcribed ${r.words.length} segments`)
    }
  } catch (error) {
    toast(error.message, 'error')
  }
}

// Map each source interval within each forward clip, then merge linked and overlapping uses.
// Delete later ranges first so ripple edits cannot move earlier cuts.
function silenceTimelineRanges(project, src, silences) {
  const uses = project.tracks.filter(track => !track.locked).flatMap(track => track.clips.filter(clip => clip.src === src))
  if (uses.some(clip => clip.reverse || clip.freeze !== undefined || clip.timeMap || !Number.isFinite(clip.speed ?? 1) || (clip.speed ?? 1) <= 0)) throw new Error('Silence removal requires forward clips with a positive scalar speed. Remove reverse, freeze or speed ramps before analyzing this source.')
  const ranges = []
  for (const [from, to] of silences) {
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) throw new Error('The silence analysis returned an invalid source range. Run it again.')
    for (const clip of uses) {
      const speed = clip.speed ?? 1, input = clip.in ?? 0
      const a = Math.max(input, from + 0.08), b = Math.min(input + clip.dur * speed, to - 0.08)
      if ((b - a) / speed > 0.15) ranges.push([clip.start + (a - input) / speed, clip.start + (b - input) / speed])
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const range of ranges) {
    const last = merged.at(-1)
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([...range])
  }
  return merged.reverse()
}

function MediaCard({ p, src, asset }) {
  const [strip, setStrip] = useState(null)
  useEffect(() => {
    let active = true
    setStrip(null)
    if (asset.hasVideo) api(`/api/strip?quality=high&src=${encodeURIComponent(src)}`).then(d => active && !d.error && setStrip(d)).catch(() => {})
    return () => { active = false }
  }, [src, asset.proxy, store.root])
  const kind = !asset.hasVideo ? 'audio' : asset.duration ? 'video' : 'image'
  const [hoverX, setHoverX] = useState(null)
  const idx = strip && hoverX !== null ? Math.min(strip.count - 1, Math.floor(hoverX * strip.count)) : Math.floor((strip?.count ?? 1) / 3)
  const sel = store.source?.src === src
  const display = mediaDisplayModel(src, asset)

  return html`
    <div class=${`media-card ${sel ? 'sel' : ''}`} draggable="true" title=${display.tooltip}
      onDragStart=${e => e.dataTransfer.setData('application/x-reel', JSON.stringify({ type: 'media', src }))}
      onDblClick=${() => openSource(src)}
      onClick=${e => (e.altKey ? addRef({ kind: 'media', id: src, label: display.name }) : set({ source: { src }, viewerMode: store.viewerMode }))}
      onContextMenu=${e => (e.preventDefault(), openMenu(e.clientX, e.clientY, analyzeMenu(p, src)))}>
      <div class=${`thumb ${kind}`} onMouseMove=${e => { const r = e.currentTarget.getBoundingClientRect(); setHoverX((e.clientX - r.left) / r.width) }} onMouseLeave=${() => setHoverX(null)}>
        ${strip ? html`<svg class="thumb-picture" viewBox=${`0 0 ${strip.w} ${strip.h}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true"><svg width=${strip.w} height=${strip.h} overflow="hidden"><image href=${strip.url} width=${strip.w * strip.count} height=${strip.h} x=${-idx * strip.w} /></svg></svg>` : null}
        ${!strip ? html`<span class=${`icon media-kind media-kind-${MEDIA_ICON[kind] ?? 'video'}`} aria-hidden="true"></span>` : null}
        ${asset.duration ? html`<span class="dur">${timecode(asset.duration, 30, false).replace(/^00:/, '')}</span>` : null}
        ${asset.proxy ? html`<span class="badge">proxy</span>` : null}
      </div>
      <div class="name">${display.name}</div>
      ${asset.generated?.kind === 'original-music' && asset.generated?.renderer?.startsWith('arya-score-synth/') ? html`<small class="media-provenance">Locally synthesized</small>` : null}
      ${asset.generated?.kind === 'original-music' && asset.generated?.renderer === 'arya-score-synth/1' ? html`<button type="button" class="ghost" draggable="false" style=${{ margin: '4px', minHeight: '44px' }} onClick=${e => { e.stopPropagation(); return showMusicDetails(src) }} onDblClick=${e => e.stopPropagation()} onDragStart=${e => { e.preventDefault(); e.stopPropagation() }}>Music details</button>` : null}
    </div>
  `
}

function FolderPicker({ onClose }) {
  const [dir, setDir] = useState('.')
  const [list, setList] = useState(null)
  const [error, setError] = useState('')
  const dialog = useRef(null)
  const requestOwner = useRef({ generation: 0, open: true })
  const generation = requestOwner.current.generation
  useLayoutEffect(() => {
    const previous = document.activeElement
    const element = dialog.current
    ;(element.querySelector('button:not(:disabled)') ?? element).focus()
    return () => {
      requestOwner.current.open = false
      requestOwner.current.generation++
      if (previous?.isConnected) previous.focus?.()
    }
  }, [])
  useEffect(() => {
    const owner = requestOwner.current
    if (!owner.open || owner.generation !== generation) return
    let active = true
    const current = () => active && owner.open && owner.generation === generation
    api(`/api/files?dir=${encodeURIComponent(dir)}`).then(data => { if (current()) setList(data) }).catch(e => {
      if (current()) { setError(e.message); toast(e.message, 'error') }
    })
    return () => { active = false }
  }, [dir])
  const close = () => {
    const owner = requestOwner.current
    if (!owner.open) return
    owner.open = false; owner.generation++
    onClose()
  }
  const navigate = next => {
    if (next === dir || !requestOwner.current.open) return
    requestOwner.current.generation++
    dialog.current.focus()
    setList(null); setError(''); setDir(next)
  }
  const trap = event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const element = dialog.current
    const controls = [...element.querySelectorAll('button:not(:disabled)')].filter(control => control.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    const outside = document.activeElement === element || !element.contains(document.activeElement)
    if (!first) { event.preventDefault(); element.focus() }
    else if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first.focus() }
  }
  const currentDir = list?.dir ?? (dir === '.' ? '' : dir)
  const files = (list?.entries ?? []).filter(e => !e.dir)

  return html`
    <div class="modal-back" onClick=${close}>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title" tabIndex="-1" ref=${dialog} onKeyDown=${trap} onClick=${e => e.stopPropagation()}>
        <h3 id="folder-picker-title">Import from project folder</h3>
        <div class="crumbs"><button class="ghost" aria-label="Project folder" onClick=${() => navigate('.')}>⌂</button> ${currentDir || '.'} ${currentDir ? html`<button class="ghost" onClick=${() => navigate(currentDir.split('/').slice(0, -1).join('/') || '.')}>↑ up</button>` : null}</div>
        <div class="file-list" aria-busy=${!list && !error}>
          ${error ? html`<div class="empty-hint" role="alert">Could not read this folder. ${error}</div>` : !list ? html`<div class="empty-hint" role="status">Loading folder…</div>` : !list.entries.length ? html`<div class="empty-hint">No media or folders here.</div>` : list.entries.map(e => html`<button type="button" class="file-row" key=${e.path} aria-label=${`${e.dir ? 'Open folder' : 'Import'} ${e.name}`} onClick=${() => (e.dir ? navigate(e.path) : importFolder([e.path], 1))}><span class=${`file-kind ${e.dir ? 'dir' : 'media-kind-video'}`} aria-hidden="true"></span>${e.name}</button>`)}
        </div>
        <div class="modal-actions">
          <button disabled=${!files.length} onClick=${async () => { const receipt = await importFolder([list.dir || '.'], files.length); if (receipt?.count > 0) close() }}>Import all media here (${files.length})</button>
          <button class="ghost" onClick=${close}>Close</button>
        </div>
      </div>
    </div>
  `
}

function MediaTab({ p }) {
  const [q, setQ] = useState('')
  const [picker, setPicker] = useState(false)
  const [kind, setKind] = useState('all')
  const fileInput = useRef(null)
  const folderInput = useRef(null)
  const entries = Object.entries(p.assets).filter(([src, a]) => mediaMatchesQuery(src, a, q) && (kind === 'all' || (kind === 'audio' ? !a.hasVideo : kind === 'image' ? a.hasVideo && !a.duration : a.hasVideo && a.duration)))

  return html`
    <div class="tab-body">
      <div class="row gap" style=${{ flexWrap: 'wrap' }}>
        <button type="button" class="primary" aria-label="Import media files" onClick=${() => fileInput.current?.click()}>Import…</button>
        <input ref=${fileInput} type="file" multiple accept="video/*,audio/*,image/*" hidden onChange=${e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; return uploadFiles(files) }} />
        <button class="ghost" onClick=${() => host.kind === 'browser-local' ? folderInput.current?.click() : setPicker(true)}>From folder…</button>
        ${host.kind === 'browser-local' ? html`<input ref=${folderInput} type="file" multiple webkitdirectory=${true} hidden onChange=${e => { const files = [...(e.target.files ?? [])]; e.target.value = ''; return uploadFiles(files) }} />` : null}
        <button type="button" class="ghost" style=${{ minHeight: '44px' }} disabled=${!store.connected || host.kind === 'browser-local'} title=${host.kind === 'browser-local' ? 'Music generation requires the native app or a local Arya connection.' : undefined} onClick=${() => showMusicDetails()}>Create music…</button>
      </div>
      <div class="row gap">
        <input class="search" placeholder="Search media" value=${q} onInput=${e => setQ(e.target.value)} />
        <select value=${kind} onChange=${e => setKind(e.target.value)}><option value="all">All</option><option value="video">Video</option><option value="audio">Audio</option><option value="image">Stills</option></select>
      </div>
      ${entries.length === 0 ? html`<div class="empty-hint">${host.kind === 'browser-local' ? 'Drop your video, audio or images here, or choose Import or From folder. Music generation needs a supported native or local connection.' : 'Drop video, audio or images anywhere in this window, use Import, or create music.'}</div>` : null}
      <div class="media-grid">
        ${entries.map(([src, asset]) => html`<${MediaCard} key=${src} p=${p} src=${src} asset=${asset} />`)}
      </div>
      ${picker ? html`<${FolderPicker} onClose=${() => setPicker(false)} />` : null}
    </div>
  `
}

async function addTitlePreset(preset) {
  const p = viewProject()
  if (!p) return null
  const captured = { root: store.root, comp: store.openComp ?? null, version: store.version,
    selection: store.selection, marker: store.selMarker, track: store.selTrack,
    page: store.page, viewerMode: store.viewerMode, source: store.source }
  const previousIDs = new Set(p.tracks.flatMap(track => track.clips.map(clip => clip.id)))
  let changed = false
  const unsubscribe = subscribe(() => {
    changed ||= store.root !== captured.root || (store.openComp ?? null) !== captured.comp ||
      store.selection !== captured.selection || store.selMarker !== captured.marker || store.selTrack !== captured.track ||
      store.page !== captured.page || store.viewerMode !== captured.viewerMode || store.source !== captured.source
  })
  try {
    const result = await edit(titlePresetOp(p, preset, { start: time.t }), `added "${preset.name}" title`)
    const id = Array.isArray(result?.created) && result.created.length === 1 ? result.created[0] : null
    if (!changed && typeof id === 'string' && !previousIDs.has(id) &&
        Number.isSafeInteger(result.version) && result.version > captured.version &&
        store.project === result.project && store.version === result.version &&
        viewProject()?.tracks.some(track => track.clips.some(clip => clip.id === id && clip.kind === 'title'))) {
      set({ selection: [id], selMarker: null, selTrack: null })
    }
    return result
  } catch (error) {
    toast(error.message, 'error')
    return null
  } finally { unsubscribe() }
}

function TitlesTab() {
  return html`
    <div class="tab-body">
      <div class="hint">Drag onto the timeline, or click to add at the playhead.</div>
      <${BrowserSections} tab="titles" />
      <div class="preset-grid">
        ${TITLE_PRESETS.map(t => html`
          <div class="preset title-preset" draggable="true" role="button" tabIndex="0" aria-label=${`Add ${t.name} at the playhead`}
            onDragStart=${e => e.dataTransfer.setData('application/x-reel', JSON.stringify({ type: 'title', preset: true, text: t.text, title: t.title, set: t.set }))}
            onClick=${() => addTitlePreset(t)}
            onKeyDown=${e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault(); e.stopPropagation()
                if (!e.repeat) return addTitlePreset(t)
              }
            }}>
            <div class="preset-art" style=${{ fontFamily: t.title.font, fontWeight: t.title.weight, color: t.title.gradient ? t.title.gradient[0] : t.title.color, background: t.title.plate ? '#222' : undefined }}>${t.text.split('\n')[0].slice(0, 14)}</div>
            <div class="preset-name">${t.name} <span class="muted">${t.title.anim}</span></div>
          </div>`)}
      </div>
    </div>
  `
}

function TransitionsTab() {
  const sel = store.selection.filter(id => !id.startsWith('tr:'))

  return html`
    <div class="tab-body">
      <div class="hint">Drag onto a clip's start, or select clips and click. ${sel.length ? `${sel.length} selected.` : ''}</div>
      <${BrowserSections} tab="transitions" />
      <div class="preset-grid">
        ${TRANSITIONS.filter(t => t !== 'blurDissolve').map(name => html`
          <button type="button" class="preset" draggable="true" aria-label=${`Apply ${name.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())} transition to selected clips`} onDragStart=${e => e.dataTransfer.setData('application/x-reel', JSON.stringify({ type: 'transition', name }))}
            onClick=${() => (sel.length ? edit(sel.map(id => ({ op: 'transition', id, type: name, dur: 1 }))) : toast('Select a clip first'))}>
            <span class=${`preset-art tr-art tr-${name}`} aria-hidden="true"><span class="a"></span><span class="b"></span></span>
            <span class="preset-name">${name.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}</span>
          </button>`)}
      </div>
    </div>
  `
}

function EffectsTab() {
  const sel = store.selection.filter(id => !id.startsWith('tr:'))

  return html`
    <div class="tab-body">
      <div class="hint">Drag onto a clip, or select clips and click.</div>
      <${BrowserSections} tab="effects" />
      <div class="fx-list">
        ${Object.keys(EFFECTS).map(name => html`
          <button type="button" class="fx-item" draggable="true" aria-label=${`Apply ${name.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())} effect to selected clips`} onDragStart=${e => e.dataTransfer.setData('application/x-reel', JSON.stringify({ type: 'effect', name }))}
            onClick=${() => (sel.length ? edit(sel.map(id => ({ op: 'effect', id, type: name }))) : toast('Select a clip first'))}>
            <span class="fx-dot" aria-hidden="true"></span>${name.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase())}
          </button>`)}
      </div>
      <h4>Generators</h4>
      <div class="fx-list">
        <button type="button" class="fx-item" draggable="true" aria-label="Add adjustment layer at the playhead" onDragStart=${e => e.dataTransfer.setData('application/x-reel', JSON.stringify({ type: 'generator', name: 'adjustment' }))} onClick=${() => edit({ op: 'adjustment', start: time.t, dur: 5 })}><span class="fx-dot adj" aria-hidden="true"></span>Adjustment layer</button>
        ${['#000000', '#ffffff', '#1c2a4a', '#f5b942'].map(color => html`<button type="button" class="fx-item" draggable="true" aria-label=${`Add solid ${color} at the playhead`} onDragStart=${e => e.dataTransfer.setData('application/x-reel', JSON.stringify({ type: 'generator', name: 'color', color }))} onClick=${() => edit({ op: 'add_color', start: time.t, dur: 3, color })}><span class="swatch" aria-hidden="true" style=${{ background: color }}></span>Solid ${color}</button>`)}
      </div>
    </div>
  `
}

export function Browser() {
  const s = useStore()
  const p = s.project
  if (!p) return null
  const tabs = [['media', 'Media'], ['titles', 'Titles'], ['transitions', 'Transitions'], ['effects', 'Effects'], ...registry.browserTabs.map(t => [t.id, t.label])]
  const extra = registry.browserTabs.find(t => t.id === s.browserTab)

  return html`
    <div class="panel browser">
      <${ScrollTabs} tabs=${tabs} value=${s.browserTab} onChange=${browserTab => set({ browserTab })} label="Media tabs" overflow="menu" />
      ${extra ? h(extra.component, { project: p }) : s.browserTab === 'media' ? html`<${MediaTab} p=${p} key=${s.mediaReveal ? `${s.mediaReveal.requestID}:${s.mediaReveal.seekToken}` : 'media'} />` : s.browserTab === 'titles' ? html`<${TitlesTab} />` : s.browserTab === 'transitions' ? html`<${TransitionsTab} />` : html`<${EffectsTab} />`}
    </div>
  `
}

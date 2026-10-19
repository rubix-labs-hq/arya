// Captions and interchange.
// - A Captions tab in the browser: edit caption text and timing inline, add a caption at the
//   playhead, delete, generate captions from a transcript, import SRT or WebVTT from the
//   project folder, and style the caption track (font, size, color, plate, position, burn-in).
// - Deliver actions: export FCPXML, OpenTimelineIO, SRT and WebVTT; import FCPXML or OTIO
//   after a confirmation that shows what the file holds.
// - A Caption section in the inspector for caption clips.
// Burned-in captions are drawn by the renderer from the track's style; this plugin edits data.

import { h, render } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { CAPTION_STYLES } from '/core/shorts.js'
import { player } from '../engine-host.js'
import { Num } from '../inspector.js'
import { registerBrowserTab, registerDeliver, registerInspector } from '../registry.js'
import { api, edit, set, store, time, toast, useStore, useTime, viewProject } from '../store.js'
import { runTranscriptJob } from '../transcript-jobs.js'
import { captionPlate, captionWordUpdate } from '../caption-word-edit.js'

const html = htm.bind(h)

const FONTS = ['Helvetica Neue', 'SF Pro Display', 'Avenir Next', 'Arial', 'Futura', 'Gill Sans', 'Georgia', 'Verdana', 'Menlo', 'Arial Black']
const STYLE = { font: 'Helvetica Neue', size: 52, color: '#ffffff', plate: '#000000aa', y: 0.88 }

const CSS = `
.cap-tab select { min-width: 0; }
.cap-style { border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.cap-style summary { cursor: pointer; color: var(--muted); font-size: 12px; user-select: none; }
.cap-style .field { flex-wrap: wrap; min-width: 0; }
.cap-style .field select { min-width: 0; }
.cap-style .field .seg { flex-wrap: wrap; }
.cap-style .field > .muted { flex: 1 1 100%; }
.cap-list { display: flex; flex-direction: column; gap: 4px; }
.cap-row { display: grid; grid-template-columns: auto 1fr auto; gap: 6px; align-items: start; padding: 5px 6px; border: 1px solid var(--line); border-radius: 7px; cursor: pointer; }
.cap-row.active { border-color: #f5b94266; }
.cap-row.sel { background: #f5b94214; border-color: var(--accent); }
.cap-times { display: flex; flex-direction: column; gap: 3px; }
.cap-times input { width: 86px; font: 500 11.5px ui-monospace, Menlo, monospace; padding: 2px 5px; }
.cap-text { width: 100%; resize: vertical; min-height: 38px; font-size: 12.5px; line-height: 1.35; }
.cap-n { color: var(--muted); font-size: 11px; }
.cap-warn { color: #e3b341; font-size: 11.5px; }
.cap-preview { max-height: 30vh; overflow: auto; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; font-size: 12px; }
.cap-preview div { padding: 2px 0; border-bottom: 1px solid var(--line); white-space: pre-wrap; }
.cap-preview div:last-child { border-bottom: none; }
.cap-dialog .field > label { width: 110px; }
`
if (typeof document !== 'undefined' && !document.getElementById('reel-captions-css')) {
  const style = document.createElement('style')
  style.id = 'reel-captions-css'
  style.textContent = CSS
  document.head.appendChild(style)
}

// ---------------------------------------------------------------- time fields

/** Non-drop timecode MM:SS:FF (HH: when needed) on the project's frame grid. */
function tc(t, fps) {
  const base = Math.round(fps)
  const total = Math.max(0, Math.round(t * fps))
  const ff = total % base
  const s = Math.floor(total / base)
  const pad = n => String(n).padStart(2, '0')
  const hh = Math.floor(s / 3600)

  return `${hh ? `${pad(hh)}:` : ''}${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(ff)}`
}

/** Reads seconds ("12.5"), MM:SS(.s), MM:SS:FF or HH:MM:SS:FF; null when it is not a time. */
function parseTc(text, fps) {
  const s = String(text).trim()
  if (/^\d+(\.\d+)?s?$/.test(s)) return Number(s.replace(/s$/, ''))
  const parts = s.split(':')
  if (parts.length < 2 || parts.length > 4 || parts.some(x => !/^\d+(\.\d+)?$/.test(x))) return null
  const n = parts.map(Number)
  if (parts.length === 2) return n[0] * 60 + n[1]
  const [hh, mm, ss, ff] = parts.length === 4 ? n : [0, ...n]

  return (((hh * 60 + mm) * 60 + ss) * Math.round(fps) + ff) / fps
}

function TimeInput({ value, fps, onCommit, title }) {
  const [text, setText] = useState(null)
  const cancelled = useRef(false)
  const shown = tc(value, fps)
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false
      setText(null)
      return
    }
    if (text === null) return
    const v = parseTc(text, fps)
    setText(null)
    if (v === null) toast(`"${text}" is not a time: type seconds, MM:SS or MM:SS:FF`, 'error')
    else if (Math.abs(v - value) > 1e-6) onCommit(Math.max(0, v))
  }

  return html`<input title=${title} value=${text ?? shown} onClick=${e => e.stopPropagation()} onFocus=${e => (setText(shown), e.target.select())}
    onInput=${e => setText(e.target.value)} onBlur=${commit}
    onKeyDown=${e => {
      if (e.key === 'Enter') e.target.blur()
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancelled.current = true
        setText(null)
        e.target.blur()
      }
    }} />`
}

/** A caption's text: edits locally, commits on blur or Enter (Shift+Enter makes a new line). */
function TextBox({ clip, autoFocus, className = 'cap-text', rows = 2 }) {
  const [text, setText] = useState(null)
  const cancelled = useRef(false)
  const ref = useRef(null)
  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus()
      ref.current.select()
    }
  }, [autoFocus])
  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false
      setText(null)
      return
    }
    if (text !== null && text !== (clip.text ?? '')) edit({ op: 'update', id: clip.id, set: { text } }, 'edited a caption')
    setText(null)
  }

  return html`<textarea ref=${ref} class=${className} rows=${rows} value=${text ?? clip.text ?? ''} placeholder="Caption text" onClick=${e => e.stopPropagation()}
    onInput=${e => setText(e.target.value)} onBlur=${commit}
    onKeyDown=${e => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        e.target.blur()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        cancelled.current = true
        setText(null)
        e.target.blur()
      }
    }}></textarea>`
}

const setStart = (clip, v) => edit({ op: 'trim', id: clip.id, edge: 'left', to: v }, 'moved a caption start')
const setEnd = (clip, v) => edit({ op: 'trim', id: clip.id, edge: 'right', to: v }, 'moved a caption end')
const selectCaption = clip => {
  set({ selection: [clip.id], selMarker: null, inspectorTab: 'caption' })
  player.seek(clip.start)
}

// ---------------------------------------------------------------- modals outside the page tree

/** Mounts a modal on the body (for Deliver actions, which run outside any component). */
function openModal(Component, props = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const close = () => {
    render(null, host)
    host.remove()
  }
  render(h(Component, { ...props, onClose: close }), host)

  return close
}

/** Picks an interchange file inside the project folder. */
function FilePicker({ kind, title, onPick, onClose }) {
  const [dir, setDir] = useState('.')
  const [list, setList] = useState(null)
  useEffect(() => {
    api(`/api/interchange/files?dir=${encodeURIComponent(dir)}&kind=${kind}`).then(setList).catch(e => toast(e.message, 'error'))
  }, [dir])
  const up = list?.dir ? list.dir.split('/').slice(0, -1).join('/') || '.' : null
  const what = kind === 'captions' ? '.srt or .vtt' : '.fcpxml, .fcpxmld or .otio'

  return html`
    <div class="modal-back" onClick=${onClose}>
      <div class="modal" onClick=${e => e.stopPropagation()}>
        <h3>${title}</h3>
        <div class="crumbs"><button class="ghost" onClick=${() => setDir('.')}>⌂</button> ${list?.dir || 'project folder'} ${up ? html`<button class="ghost" onClick=${() => setDir(up)}>↑ up</button>` : null}</div>
        <div class="file-list">
          ${list && !list.entries.length ? html`<div class="empty-hint">No ${what} files here.</div>` : null}
          ${(list?.entries ?? []).map(e => html`<div class="file-row" onClick=${() => (e.dir ? setDir(e.path) : onPick(e.path))}><span class=${`file-kind ${e.dir ? 'dir' : 'file'}`} aria-hidden="true"></span>${e.name}</div>`)}
        </div>
        <div class="hint">Files must be inside the project folder. Exports land in renders/.</div>
        <div class="modal-actions"><button class="ghost" onClick=${onClose}>Cancel</button></div>
      </div>
    </div>
  `
}

/** Shows caption items and offers to add them to a track or replace it. */
function CaptionsConfirm({ title, items, tracks, initialTrack, note, onClose, onApply, expectedVersion }) {
  const s = useStore()
  const usedTracks = new Set(viewProject().tracks.map(t => t.id))
  let nextTrack = 1
  while (usedTracks.has(`C${nextTrack}`)) nextTrack++
  const newTrack = `C${nextTrack}`
  const [track, setTrack] = useState(initialTrack ?? tracks[0]?.id ?? newTrack)
  const [busy, setBusy] = useState(false)
  const exists = tracks.some(t => t.id === track)
  const apply = async replace => {
    setBusy(true)
    let res
    try { res = onApply ? await onApply(track, replace) : await edit({ op: 'captions', items, track, replace }, `${items.length} captions${replace ? ` replaced ${track}` : ` on ${track}`}`) }
    catch (err) { toast(err.message, 'error') }
    setBusy(false)
    if (res) {
      toast(`${items.length} caption${items.length === 1 ? '' : 's'} ${replace ? 'replaced' : 'added to'} ${track}`)
      set({ browserTab: 'captions' })
      onClose()
    }
  }
  const fps = store.project.fps

  return html`
    <div class="modal-back" onClick=${onClose}>
      <div class="modal cap-dialog" onClick=${e => e.stopPropagation()}>
        <h3>${title}</h3>
        ${note ? html`<div class="hint">${note}</div>` : null}
        <div class="cap-preview">${items.slice(0, 200).map(c => html`<div><span class="cap-n">${tc(c.t, fps)} → ${tc(c.end, fps)}</span><br />${c.text}</div>`)}</div>
        ${items.length > 200 ? html`<div class="hint">…and ${items.length - 200} more.</div>` : null}
        <div class="field"><label>Caption track</label><select value=${track} onChange=${e => setTrack(e.target.value)}>
          ${tracks.map(t => html`<option value=${t.id}>${t.id} ${t.name ?? ''} (${t.clips.length})</option>`)}
          <option value=${newTrack}>${newTrack} (new track)</option>
        </select></div>
        <div class="modal-actions">
          <button class="ghost" onClick=${onClose}>Cancel</button>
          ${exists && tracks.find(t => t.id === track).clips.length ? html`<button class="ghost danger" disabled=${busy || (expectedVersion !== undefined && expectedVersion !== s.version)} onClick=${() => apply(true)}>Replace ${track}</button>` : null}
          <button disabled=${busy || !items.length || (expectedVersion !== undefined && expectedVersion !== s.version)} onClick=${() => apply(false)}>${busy ? 'Applying...' : `Add ${items.length} caption${items.length === 1 ? '' : 's'}`}</button>
        </div>
        ${expectedVersion !== undefined && expectedVersion !== s.version ? html`<div class="cap-warn">The project changed. Close this preview and generate it again before applying.</div>` : null}
      </div>
    </div>
  `
}

// ---------------------------------------------------------------- captions from a transcript

function TranscriptDialog({ onClose }) {
  const s = useStore()
  const p = viewProject()
  const sources = [...new Set(p.tracks.filter(t => t.kind === 'video' || t.kind === 'audio').flatMap(t => t.clips).filter(c => c.src && p.assets[c.src]?.hasAudio).map(c => c.src))]
  const selected = p.tracks.flatMap(t => t.clips).find(c => c.id === s.selection[0] && c.src && sources.includes(c.src))
  const [src, setSrc] = useState(selected?.src ?? (s.transcript?.ownerRoot === s.root && sources.includes(s.transcript.src) ? s.transcript.src : sources[0]))
  const [maxChars, setMaxChars] = useState(42)
  const [maxLines, setMaxLines] = useState(2)
  const [style, setStyle] = useState('boxed')
  const [onlySelected, setOnlySelected] = useState(Boolean(selected))
  const [busy, setBusy] = useState(false)
  const [job, setJob] = useState(null)
  const [result, setResult] = useState(null)
  const [requestBody, setRequestBody] = useState(null)
  const request = useRef(null), active = useRef(true), renderIdentity = useRef(null)
  const local = s.transcript?.src === src && s.transcript.ownerRoot === s.root ? s.transcript : null
  const identity = useMemo(() => ({ root: s.root, project: s.project, comp: s.openComp ?? null, version: s.version, src, local, maxChars, maxLines, style, onlySelected, selected: selected?.id }), [s.root, s.project, s.openComp, s.version, src, local, maxChars, maxLines, style, onlySelected, selected?.id])
  renderIdentity.current = identity
  const owns = owned => {
    const basis = owned.identity
    const liveLocal = store.transcript?.src === basis.src && store.transcript.ownerRoot === basis.root ? store.transcript : null
    return active.current && request.current === owned && !owned.ctrl.signal.aborted && renderIdentity.current === basis &&
      store.root === basis.root && store.project === basis.project && (store.openComp ?? null) === basis.comp && store.version === basis.version && liveLocal === basis.local
  }
  useEffect(() => {
    request.current?.ctrl.abort(); request.current = null
    setBusy(false); setJob(null); setResult(null); setRequestBody(null)
  }, [identity])
  useEffect(() => () => { active.current = false; request.current?.ctrl.abort() }, [])
  const run = async () => {
    if (request.current || !src || renderIdentity.current !== identity || store.root !== identity.root || store.project !== identity.project || store.version !== identity.version || (store.openComp ?? null) !== identity.comp) return
    const owned = { identity, ctrl: new AbortController(), applying: false }
    request.current = owned; setBusy(true)
    try {
      const locale = local?.locale ?? 'en-US'
      const readSaved = () => api(`/api/transcript?src=${encodeURIComponent(src)}&locale=${encodeURIComponent(locale)}`)
      let saved = await readSaved()
      if (!owns(owned)) return
      const textAndTiming = words => (words ?? []).map(({ t, end, text }) => ({ t, end, text }))
      if (local && (local.revision !== saved.revision || local.fingerprint !== saved.fingerprint || JSON.stringify(textAndTiming(local.words)) !== JSON.stringify(textAndTiming(saved.words)))) throw new Error('Save transcript corrections before previewing captions. Recheck the saved transcript if its source or revision changed.')
      if (!saved.words?.length) {
        await runTranscriptJob(api, '/api/analyze', { src, locale, kind: 'transcript' }, { signal: owned.ctrl.signal, onJob: value => { if (owns(owned)) setJob(value) } })
        if (!owns(owned)) return
        saved = await readSaved()
        if (!owns(owned)) return
      }
      if (!['complete', 'ready', 'partial'].includes(saved.status) || !Number.isSafeInteger(saved.revision) || saved.revision <= 0 || typeof saved.fingerprint !== 'string' || !saved.words?.length) throw new Error('Load a saved transcript for this source before previewing captions.')
      const body = { src, locale, words: saved.words, maxChars, maxLines, style, comp: identity.comp, id: onlySelected && selected?.src === src ? selected.id : undefined, expectedVersion: identity.version, expectedSourceFingerprint: saved.fingerprint, expectedTranscriptRevision: saved.revision }
      const preview = await api('/api/captions/from-transcript', body)
      if (!owns(owned)) return
      if (preview.sourceFingerprint !== saved.fingerprint || preview.transcriptRevision !== saved.revision || preview.version !== identity.version) throw new Error('The source, transcript or project changed during caption preview. Preview it again.')
      setRequestBody(body); setResult(preview)
    } catch (error) {
      if (owns(owned)) { toast(error.name === 'AbortError' ? 'Transcription cancelled' : error.message, 'error'); request.current = null; setBusy(false); setJob(null) }
    } finally { if (owns(owned)) { setBusy(false); setJob(null) } }
  }
  if (result) {
    const owned = request.current
    return html`<${CaptionsConfirm} title="Captions from the transcript" items=${result.items} tracks=${p.tracks.filter(t => t.kind === 'caption')}
      note=${`${result.items.length} captions on ${result.clips.join(', ')}. The ${style === 'karaoke' ? 'word highlight' : style === 'word' ? 'one word at a time' : style} style and all word timings remain editable. ${result.warnings?.join(' ') ?? ''}`}
      expectedVersion=${result.version}
      onApply=${async (track, replace) => {
        if (!owned || !owns(owned) || owned.applying) throw new Error('This caption preview changed. Close it and preview the saved transcript again.')
        owned.applying = true
        try {
          const applied = await api('/api/captions/from-transcript', { ...requestBody, track, replace, apply: true, expectedVersion: result.version })
          if (!owns(owned)) return null
          if (applied.project) set({ project: applied.project, version: applied.version })
          return applied
        } finally { owned.applying = false }
      }}
      onClose=${() => { request.current?.ctrl.abort(); onClose() }} />`
  }

  return html`
    <div class="modal-back" onClick=${() => { request.current?.ctrl.abort(); onClose() }}>
      <div class="modal cap-dialog" onClick=${e => e.stopPropagation()}>
        <h3>Captions from a transcript</h3>
        ${sources.length ? html`
          <div class="field"><label>Media</label><select disabled=${busy} value=${src} onChange=${e => (setSrc(e.target.value), setResult(null))}>${sources.map(x => html`<option value=${x}>${x.split('/').pop()}</option>`)}</select></div>
          <div class="field"><label>Style</label><select disabled=${busy} value=${style} onChange=${e => setStyle(e.target.value)}><option value="plain">Plain</option><option value="boxed">Boxed</option><option value="karaoke">Word highlight</option><option value="word">One word at a time</option></select></div>
          ${selected?.src === src ? html`<label class="row gap"><input type="checkbox" disabled=${busy} checked=${onlySelected} onChange=${e => setOnlySelected(e.target.checked)} />Only selected clip ${selected.id}</label>` : null}
          <${Num} label="Characters/line" value=${maxChars} step=${1} min=${16} max=${80} onCommit=${setMaxChars} />
          <${Num} label="Lines" value=${maxLines} step=${1} min=${1} max=${3} onCommit=${setMaxLines} />
          <div class="hint">Uses the saved transcript revision and maps its words to the clip's timeline positions. Save word corrections in Transcript before previewing captions.</div>
          ${!local && !(s.caps.analysis?.transcript ?? s.caps.whisper) ? html`<div class="cap-warn">${s.caps.host === 'native' ? 'Apple Speech is unavailable on this device. You can import a timed transcript.' : 'Install whisper.cpp and a model to transcribe, or import a timed transcript.'}</div>` : null}`
        : html`<div class="empty-hint">Put a clip with sound on the timeline first.</div>`}
        <div class="modal-actions">
          <button class="ghost" onClick=${() => { request.current?.ctrl.abort(); onClose() }}>Cancel</button>
          <button disabled=${busy || !src} onClick=${run}>${busy ? job?.message ?? 'Preparing preview...' : 'Preview captions'}</button>
        </div>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------- the Captions tab

function StyleBox({ track }) {
  const root = store.root, project = store.project, comp = store.openComp, version = store.version
  const st = { ...STYLE, ...(track.style ?? {}) }
  const plate = captionPlate(st.plate), plateAlpha = plate.alpha
  const setTrack = (patch, summary) => {
    if (store.root !== root || store.project !== project || store.openComp !== comp || store.version !== version) {
      toast('This caption track changed. Reopen its style controls before editing.', 'error')
      return
    }
    return edit({ op: 'update_track', id: track.id, comp, set: patch }, summary, { expectedVersion: version })
  }
  const setStyle = (patch, what) => setTrack({ style: patch }, `caption ${what}`)
  const hex2 = a => Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0')

  return html`
    <details class="cap-style" open=${!track.clips.length}>
      <summary>Style · ${st.font} ${st.size}px${track.burnIn ? ' · burned in' : ''}</summary>
      <div class="field"><label>Preset</label><select value=${st.preset ?? 'boxed'} onChange=${e => setStyle(CAPTION_STYLES[e.target.value], 'preset')}><option value="plain">Plain</option><option value="boxed">Boxed</option><option value="karaoke">Word highlight</option><option value="word">One word at a time</option></select></div>
      <div class="field"><label>Burn in</label><input type="checkbox" checked=${Boolean(track.burnIn)} onChange=${e => setTrack({ burnIn: e.target.checked }, e.target.checked ? 'captions burned in' : 'captions not burned in')} /><span class="muted small">draw on the picture and in renders</span></div>
      <div class="field"><label>Font</label><select value=${st.font} onChange=${e => setStyle({ font: e.target.value }, 'font')}>${[...new Set([st.font, ...FONTS])].map(f => html`<option value=${f}>${f}</option>`)}</select></div>
      <${Num} label="Size" value=${st.size} step=${1} min=${8} max=${300} unit="px" onCommit=${v => setStyle({ size: v }, 'size')} />
      <${Num} label="Weight" value=${st.weight ?? 700} step=${100} min=${100} max=${900} onCommit=${v => setStyle({ weight: v }, 'weight')} />
      <div class="field"><label>Color</label><input type="color" value=${String(st.color).slice(0, 7)} onChange=${e => setStyle({ color: e.target.value }, 'color')} /></div>
      ${st.preset === 'karaoke' ? html`<div class="field"><label>Highlight</label><input type="color" value=${String(st.highlightColor ?? '#ffe600').slice(0, 7)} onChange=${e => setStyle({ highlightColor: e.target.value }, 'highlight color')} /></div>` : null}
      <div class="field"><label>Plate</label><input type="color" value=${plate.color} onChange=${e => setStyle({ plate: `${e.target.value}${hex2(plateAlpha)}` }, 'plate')} />
        <input type="range" min="0" max="1" step="0.05" value=${plateAlpha} title="Plate opacity (0 hides it)" onChange=${e => setStyle({ plate: `${plate.color}${hex2(Number(e.target.value))}` }, 'plate opacity')} /></div>
      <div class="field"><label>Position</label><input type="range" min="0.05" max="0.95" step="0.01" value=${st.y} title="Vertical position of the text" onChange=${e => setStyle({ y: Number(e.target.value) }, 'position')} />
        <span class="seg"><button class=${st.y < 0.3 ? 'on' : ''} onClick=${() => setStyle({ y: 0.1 }, 'position')}>Top</button><button class=${st.y > 0.7 ? 'on' : ''} onClick=${() => setStyle({ y: 0.88 }, 'position')}>Bottom</button></span></div>
    </details>
  `
}

function CaptionRow({ clip, fps, active, selected, focus }) {
  return html`
    <div class=${`cap-row ${active ? 'active' : ''} ${selected ? 'sel' : ''}`} onClick=${() => selectCaption(clip)}>
      <div class="cap-times">
        <${TimeInput} value=${clip.start} fps=${fps} title="Start (seconds, MM:SS or MM:SS:FF)" onCommit=${v => setStart(clip, v)} />
        <${TimeInput} value=${clip.start + clip.dur} fps=${fps} title="End" onCommit=${v => setEnd(clip, v)} />
      </div>
      <${TextBox} clip=${clip} autoFocus=${focus} />
      <button class="ghost tiny danger" title="Delete caption" onClick=${e => (e.stopPropagation(), edit({ op: 'delete', id: clip.id }, 'deleted a caption'))}>✕</button>
    </div>
  `
}

function CaptionList({ track }) {
  const s = useStore()
  const t = useTime()
  const fps = s.project.fps
  const clips = [...track.clips].sort((a, b) => a.start - b.start)

  return html`
    <div class="cap-list">
      ${clips.map(c => html`<${CaptionRow} key=${c.id} clip=${c} fps=${fps} active=${t >= c.start && t < c.start + c.dur} selected=${s.selection.includes(c.id)} focus=${s.captionFocus === c.id} />`)}
    </div>
  `
}

function CaptionsTab() {
  const s = useStore()
  const p = viewProject()
  const tracks = p.tracks.filter(t => t.kind === 'caption')
  const [trackId, setTrackId] = useState(null)
  const track = tracks.find(t => t.id === trackId) ?? tracks[0]
  const [modal, setModal] = useState(null)
  useEffect(() => {
    if (s.captionFromTranscript) { setModal({ kind: 'transcript' }); set({ captionFromTranscript: false }) }
  }, [s.captionFromTranscript])
  const add = async () => {
    const at = time.t
    const res = await edit({ op: 'add_caption', text: '', start: at, dur: 2, track: track?.id }, 'added a caption')
    const id = res?.created?.[0]
    if (id) set({ selection: [id], inspectorTab: 'caption', captionFocus: id })
  }
  const importFile = async rel => {
    try {
      const r = await api('/api/interchange/import', { path: rel })
      setModal({ kind: 'confirm', items: r.captions, title: `Import ${rel.split('/').pop()}` })
    } catch (error) {
      toast(error.message, 'error')
    }
  }
  const exportAs = async format => {
    try {
      const r = await api('/api/interchange/export', { format, track: track?.id, ...(store.openComp ? { comp: store.openComp } : {}) })
      toast(`Saved ${r.path}`)
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  return html`
    <div class="tab-body cap-tab">
      <div class="row gap">
        ${tracks.length > 1 ? html`<select value=${track.id} onChange=${e => setTrackId(e.target.value)}>${tracks.map(t => html`<option value=${t.id}>${t.id} ${t.name ?? ''}</option>`)}</select>` : null}
        <button onClick=${add} title="Add a 2-second caption at the playhead">+ Caption at playhead</button>
      </div>
      <div class="row gap wrap">
        <button class="ghost" onClick=${() => setModal({ kind: 'transcript' })}>From transcript…</button>
        <button class="ghost" onClick=${() => setModal({ kind: 'pick' })}>Import SRT/VTT…</button>
        <button class="ghost" disabled=${!track?.clips.length} onClick=${() => exportAs('srt')}>Export SRT</button>
        <button class="ghost" disabled=${!track?.clips.length} onClick=${() => exportAs('vtt')}>Export VTT</button>
      </div>
      ${track ? html`<${StyleBox} track=${track} />` : null}
      ${track?.clips.length
        ? html`<div class="hint">${track.clips.length} caption${track.clips.length === 1 ? '' : 's'} on ${track.id}. Click one to jump to it; Enter saves text, Shift+Enter starts a new line.</div><${CaptionList} track=${track} />`
        : html`<div class="empty-hint">No captions yet. Add one at the playhead, make them from a transcript, or import an SRT or WebVTT file from the project folder.</div>`}
      ${modal?.kind === 'pick' ? html`<${FilePicker} kind="captions" title="Import captions" onPick=${rel => (setModal(null), importFile(rel))} onClose=${() => setModal(null)} />` : null}
      ${modal?.kind === 'confirm' ? html`<${CaptionsConfirm} title=${modal.title} items=${modal.items} tracks=${tracks} initialTrack=${track?.id} onClose=${() => setModal(null)} />` : null}
      ${modal?.kind === 'transcript' ? html`<${TranscriptDialog} onClose=${() => setModal(null)} />` : null}
    </div>
  `
}

registerBrowserTab({ id: 'captions', label: 'Captions', order: 50, component: CaptionsTab })

// ---------------------------------------------------------------- inspector section

function CaptionWords({ clip, fps }) {
  const root = store.root, project = store.project, comp = store.openComp, version = store.version
  const [page, setPage] = useState(0)
  const currentPage = Math.min(page, Math.max(0, Math.ceil((clip.words?.length ?? 0) / 50) - 1))
  const commit = (index, patch) => {
    if (store.root !== root || store.project !== project || store.openComp !== comp || store.version !== version) {
      toast('This caption changed. Select it again before editing its words.', 'error')
      return
    }
    try { return edit(captionWordUpdate(clip, index, patch, comp, fps), 'edited caption word timing', { expectedVersion: version }) }
    catch (error) { toast(error.message, 'error') }
  }
  if (!clip.words?.length) return null
  return html`<details class="cap-style"><summary>Word timing</summary>
    <div class="hint">Seconds are relative to this cue. These edits change the caption highlight. Source transcript timing stays saved separately.</div>
    ${clip.words.slice(currentPage * 50, (currentPage + 1) * 50).map((word, offset) => { const index = currentPage * 50 + offset; return html`<div class="cap-style" key=${index}>
      <div class="field"><label>Word ${index + 1}</label><input value=${word.text} aria-label=${`Caption word ${index + 1}`} onChange=${e => commit(index, { text: e.target.value })} /></div>
      <${Num} label="Word start" value=${word.t} step=${1 / fps} min=${0} max=${clip.dur} unit="s" onCommit=${v => commit(index, { t: v })} />
      <${Num} label="Word end" value=${word.end} step=${1 / fps} min=${0} max=${clip.dur} unit="s" onCommit=${v => commit(index, { end: v })} />
      <button class="ghost" onClick=${() => { if (store.root === root && store.project === project && store.openComp === comp && store.version === version) player.seek(clip.start + Math.max(0, word.t)) }}>Preview word ${index + 1}</button>
    </div>` })}
    ${clip.words.length > 50 ? html`<div class="row gap"><button class="ghost" disabled=${currentPage === 0} onClick=${() => setPage(currentPage - 1)}>Previous words</button><span>${currentPage + 1} / ${Math.ceil(clip.words.length / 50)}</span><button class="ghost" disabled=${(currentPage + 1) * 50 >= clip.words.length} onClick=${() => setPage(currentPage + 1)}>Next words</button></div>` : null}
  </details>`
}

function CaptionInspector({ clip, track }) {
  const fps = store.project.fps

  return html`
    <div class="section-body">
      <${TextBox} key=${clip.id} clip=${clip} rows=${3} />
      <${Num} label="Start" value=${clip.start} step=${1 / fps} min=${0} unit="s" onCommit=${v => setStart(clip, v)} />
      <${Num} label="End" value=${clip.start + clip.dur} step=${1 / fps} min=${clip.start + 1 / fps} unit="s" onCommit=${v => setEnd(clip, v)} />
      <${Num} label="Duration" value=${clip.dur} step=${1 / fps} min=${1 / fps} unit="s" onCommit=${v => setEnd(clip, clip.start + v)} />
      <${CaptionWords} key=${clip.id} clip=${clip} fps=${fps} />
      <div class="kv"><span>Track</span><b>${track.id} ${track.name ?? ''}${track.burnIn ? ' · burned in' : ''}</b></div>
      <div class="row gap">
        <button class="ghost" onClick=${() => player.seek(clip.start)}>Go to</button>
        <button class="ghost" onClick=${() => set({ browserTab: 'captions', page: store.page === 'media' ? 'edit' : store.page })}>Captions tab</button>
        <button class="ghost danger" onClick=${() => (edit({ op: 'delete', id: clip.id }, 'deleted a caption'), set({ selection: [] }))}>Delete</button>
      </div>
    </div>
  `
}

registerInspector({ id: 'caption', label: 'Caption', order: 10, when: clip => clip.kind === 'caption', component: CaptionInspector })

// ---------------------------------------------------------------- Deliver: export and import

async function exportFormat(format, label) {
  try {
    const r = await api('/api/interchange/export', { format, ...(store.openComp ? { comp: store.openComp } : {}) })
    toast(`${label} saved to ${r.path}`)
    for (const w of r.warnings ?? []) toast(w, 'error')
  } catch (error) {
    toast(error.message, 'error')
  }
}

function ImportConfirm({ rel, preview, onClose }) {
  const [busy, setBusy] = useState(false)
  const p = preview.project
  const clips = p.tracks.flatMap(t => t.clips)
  const end = clips.reduce((e, c) => Math.max(e, c.start + c.dur), 0)
  const tracks = p.tracks.filter(t => t.clips.length).map(t => `${t.id} ${t.clips.length}`).join(' · ')
  const apply = async () => {
    setBusy(true)
    try {
      const r = await api('/api/interchange/import', { path: rel, apply: true, expectedVersion: preview.version, expectedInputHash: preview.sourceHash })
      set({ project: r.project, version: r.version, selection: [], selMarker: null })
      toast(`Imported ${rel.split('/').pop()}: ${clips.length} clips`)
      for (const w of r.warnings ?? []) toast(w, 'error')
      onClose()
    } catch (error) {
      toast(error.message, 'error')
      setBusy(false)
    }
  }

  return html`
    <div class="modal-back" onClick=${onClose}>
      <div class="modal" onClick=${e => e.stopPropagation()}>
        <h3>Replace the project with ${rel.split('/').pop()}?</h3>
        <div class="kv"><span>Name</span><b>${p.name}</b></div>
        <div class="kv"><span>Format</span><b>${p.width}×${p.height} · ${p.fps} fps · ${tc(end, p.fps)}</b></div>
        <div class="kv"><span>Clips</span><b>${clips.length} (${tracks || 'none'})</b></div>
        <div class="kv"><span>Markers</span><b>${p.markers.length}</b></div>
        <div class="kv"><span>Media</span><b>${Object.keys(p.assets).length} file${Object.keys(p.assets).length === 1 ? '' : 's'}</b></div>
        ${preview.missing.length ? html`<div class="cap-warn">Not found (will show as offline): ${preview.missing.slice(0, 6).map(m => m.split('/').pop()).join(', ')}${preview.missing.length > 6 ? `, and ${preview.missing.length - 6} more` : ''}</div>` : null}
        ${preview.warnings.map(w => html`<div class="cap-warn">${w}</div>`)}
        <div class="hint">The current timeline is replaced in one step: Undo (⌘Z) brings it back.</div>
        <div class="modal-actions">
          <button class="ghost" onClick=${onClose}>Cancel</button>
          <button class="danger" disabled=${busy} onClick=${apply}>${busy ? 'Importing…' : 'Replace project'}</button>
        </div>
      </div>
    </div>
  `
}

function importTimeline() {
  const closePicker = openModal(FilePicker, {
    kind: 'timeline',
    title: 'Import FCPXML or OpenTimelineIO',
    onPick: async rel => {
      closePicker()
      try {
        const preview = await api('/api/interchange/import', { path: rel })
        openModal(ImportConfirm, { rel, preview })
      } catch (error) {
        toast(error.message, 'error')
      }
    },
  })
}

registerDeliver({ id: 'export-fcpxml', label: 'Export FCPXML', order: 10, run: () => exportFormat('fcpxml', 'FCPXML') })
registerDeliver({ id: 'export-otio', label: 'Export OTIO', order: 20, run: () => exportFormat('otio', 'OpenTimelineIO') })
registerDeliver({ id: 'export-edl', label: 'Export EDL', order: 25, run: () => exportFormat('edl', 'CMX 3600 EDL') })
registerDeliver({ id: 'export-srt', label: 'Export SRT', order: 30, run: () => exportFormat('srt', 'SRT captions') })
registerDeliver({ id: 'export-vtt', label: 'Export WebVTT', order: 40, run: () => exportFormat('vtt', 'WebVTT captions') })
registerDeliver({ id: 'import-timeline', label: 'Import FCPXML/OTIO…', order: 50, run: importTimeline })

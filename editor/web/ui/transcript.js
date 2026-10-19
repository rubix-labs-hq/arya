import { h } from 'preact'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { timecode } from '/core/project.js'
import { transcriptDeleteOps } from '/core/shorts.js'
import { MAX_TIMED_TRANSCRIPT_BYTES, parseTimedTranscript, updateTranscriptTiming } from '/core/transcript-edit.js'
import { addRef, api, edit, set, store, time, toast, useStore, viewProject } from './store.js'
import { revealMedia } from './layout.js'
import { host } from '../host.js'
import { runTranscriptJob } from './transcript-jobs.js'
import { transcriptDrafts, transcriptDraftKey, transcriptDraftMatches, transcriptRecoverySession } from './transcript-drafts.js'

const html = htm.bind(h)
const PAGE_WORDS = 300
const CSS = `
.tr-editor { display:flex; flex-direction:column; gap:8px; min-width:0; }
.tr-editor .row { flex-wrap:wrap; }
.tr-editor select, .tr-editor input { min-width:0; }
.tr-editor .tr-source { flex:1; }
.tr-search { flex:1; min-width:130px; }
.tr-status { color:var(--muted); font-size:12px; line-height:1.5; }
.tr-status.error { color:#ff8b83; }
.tr-words { line-height:1.95; }
.tr-word { display:inline; padding:2px 4px; margin:0; border:0; border-radius:4px; background:transparent; color:var(--text); font:inherit; line-height:inherit; cursor:pointer; }
.tr-word:hover { background:#ffffff0c; }
.tr-word.sel { background:#f5b94230; color:var(--accent); }
.tr-word.match { box-shadow:inset 0 -2px #f5b942; }
.tr-word:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
.tr-selection { padding:8px; border:1px solid var(--line); border-radius:8px; display:flex; flex-direction:column; gap:7px; }
.tr-selection p { margin:0; font-size:12px; color:var(--muted); }
.tr-selection input { flex:1; }
.tr-progress { display:flex; align-items:center; gap:8px; }
.tr-progress progress { flex:1; min-width:40px; accent-color:var(--accent); }
.tr-time { font-variant-numeric:tabular-nums; font:11px ui-monospace,Menlo,monospace; color:var(--muted); }
.tr-paging { justify-content:space-between; }
.tr-editor .btn-small { min-height:32px; }
@media(pointer:coarse) { .tr-word { min-height:44px; line-height:2.5; } .tr-editor .btn-small { min-height:44px; } }
`
if (typeof document !== 'undefined' && !document.getElementById('reel-transcript-css')) {
  const style = document.createElement('style')
  style.id = 'reel-transcript-css'
  style.textContent = CSS
  document.head.appendChild(style)
}

const basename = src => String(src ?? '').split('/').pop()
export const transcriptSources = project => Object.keys(project?.assets ?? {}).filter(src => project.assets[src].hasAudio)

export function Transcript() {
  return html`<${host.kind === 'browser-local' ? BrowserTranscript : ConnectedTranscript} />`
}

function BrowserTranscript() {
  return html`<section class="tr-editor" aria-label="Transcript availability">
    <p class="tr-status">Automatic transcription, timed transcript import and automatic captions need a supported native app or local Arya connection. They are unavailable in this browser edition. You can create and edit titles manually.</p>
    <button type="button" class="ghost btn-small" onClick=${() => { revealMedia(); set({ page: 'edit', browserTab: 'titles' }) }}>Open Titles</button>
  </section>`
}

function ConnectedTranscript() {
  const s = useStore(), sources = transcriptSources(s.project)
  const [src, setSrc] = useState(s.transcript?.src ?? (sources.includes(s.source?.src) ? s.source.src : sources[0] ?? ''))
  const [locale, setLocale] = useState(s.transcript?.locale ?? 'en-US')
  const [allowServer, setAllowServer] = useState(false)
  const [record, setRecord] = useState(null)
  const [words, setWords] = useState([])
  const [selection, setSelection] = useState(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [job, setJob] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [draftConflict, setDraftConflict] = useState(false), [reload, setReload] = useState(0)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [importPreview, setImportPreview] = useState(null)
  const [recoveryOffers, setRecoveryOffers] = useState([]), [recoveryStatus, setRecoveryStatus] = useState('')
  const recovery = useRef(null), action = useRef(null), currentKey = useRef(null)
  const controller = useRef(null), generation = useRef(0), drafts = useRef(transcriptDrafts), wordNodes = useRef(new Map()), timelineActions = useRef(null)
  const root = s.root
  const key = transcriptDraftKey(root, src, locale)
  currentKey.current = key
  const dirty = useMemo(() => record && JSON.stringify(words) !== JSON.stringify(record.words ?? []), [record, words])
  const available = s.caps.analysis?.transcript ?? s.caps.whisper ?? false
  const lo = selection ? Math.min(selection.a, selection.b) : -1
  const hi = selection ? Math.max(selection.a, selection.b) : -1
  const chosen = selection ? words.slice(lo, hi + 1) : []
  const matches = useMemo(() => {
    const term = query.trim().toLowerCase()
    return term ? words.flatMap((w, i) => String(w.text).toLowerCase().includes(term) ? [i] : []) : []
  }, [query, words])
  const matchSet = useMemo(() => new Set(matches), [matches])

  const timelineLease = useMemo(() => ({
    blocked: !record || loading || draftConflict || record.status === 'stale' || busy || saving,
    generation: generation.current, project: s.project, comp: s.openComp, version: s.version,
  }), [key, record, words, selection, loading, draftConflict, busy, saving, s.project, s.openComp, s.version, generation.current])
  timelineActions.current = timelineLease
  const canEditTimeline = () => !action.current && timelineActions.current === timelineLease && !timelineLease.blocked &&
    generation.current === timelineLease.generation && store.root === root &&
    store.project === timelineLease.project && store.openComp === timelineLease.comp && store.version === timelineLease.version
  const ownsRender = () => currentKey.current === key && timelineActions.current === timelineLease && generation.current === timelineLease.generation && store.root === root
  const claimAction = kind => {
    if (action.current || busy || saving || loading || !ownsRender()) return null
    const owned = { kind, generation: generation.current, key, root, recovery: recovery.current }
    action.current = owned; timelineActions.current = null; setSaving(true)
    return owned
  }
  const ownsAction = owned => action.current === owned && currentKey.current === owned.key && generation.current === owned.generation && store.root === owned.root
  const releaseAction = owned => { if (action.current === owned) { action.current = null; if (currentKey.current === owned.key && generation.current === owned.generation && store.root === owned.root) setSaving(false) } }

  useEffect(() => {
    const next = s.transcript?.src
    if (next && sources.includes(next) && next !== src) setSrc(next)
  }, [s.transcript?.src])
  useEffect(() => {
    if (!sources.includes(src)) setSrc(sources[0] ?? '')
  }, [Object.keys(s.project?.assets ?? {}).join('\n')])
  useEffect(() => {
    let active = true
    const token = ++generation.current
    const current = () => active && generation.current === token && currentKey.current === key && store.root === root
    action.current = null
    timelineActions.current = null
    controller.current?.abort()
    controller.current = null
    setBusy(false); setSaving(false); setJob(null); setSelection(null); setPage(0); setError(''); setConfirmDiscard(false); setImportPreview(null)
    const draft = drafts.current.get(key)
    setRecord(draft?.record ?? null)
    setWords(draft?.words ?? [])
    setDraftConflict(Boolean(draft))
    if (!src) { setLoading(false); return () => { active = false; generation.current++ } }
    setLoading(true); setRecoveryOffers([]); setRecoveryStatus('')
    const ownedAPI = (...args) => store.root === root ? api(...args) : Promise.reject(new Error('The transcript project changed before its recovery request'))
    recovery.current = transcriptRecoverySession(key, ownedAPI, { src, locale }, message => { if (current()) setRecoveryStatus(message) })
    api(`/api/transcript?src=${encodeURIComponent(src)}&locale=${encodeURIComponent(locale)}`).then(value => {
      if (!current()) return
      const recoveryLoad = api(`/api/transcript/drafts?src=${encodeURIComponent(src)}&locale=${encodeURIComponent(locale)}`).then(context => {
        if (!current()) return
        setRecoveryOffers(context.offers ?? [])
        const latest = drafts.current.get(key)
        if (latest?.basis && (!context.basis || Object.keys(latest.basis).length !== Object.keys(context.basis).length || Object.keys(latest.basis).some(field => latest.basis[field] !== context.basis[field]))) {
          setDraftConflict(true); setError('Retained corrections have an older project or source identity. Copy them before discarding this draft.'); return
        }
        recovery.current.capture(context, value)
        if (latest && transcriptDraftMatches(latest, value)) recovery.current.update(latest.words)
        if (context.reason || context.warnings?.length) setRecoveryStatus(context.reason ?? 'Some recovery files could not be read. They were preserved.')
      }).catch(err => { if (current()) setRecoveryStatus(`Recovery copies unavailable: ${err.message}`) })
      const conflict = Boolean(draft && !transcriptDraftMatches(draft, value))
      if (!draft) { setRecord(value); setWords(value.words ?? []) }
      setDraftConflict(conflict)
      if (conflict) setError('Unsaved corrections were retained, but the saved transcript or source changed. Copy your words or explicitly discard the draft before loading the current transcript.')
      set({ transcript: { ...(draft ? { ...draft.record, words: draft.words, src, locale } : value), ownerRoot: root } })
      return recoveryLoad
    }).catch(err => {
      if (current()) setError(err.message)
    }).finally(() => { if (current()) setLoading(false) })
    return () => { active = false; generation.current++; controller.current?.abort() }
  }, [key, reload])

  const selectWord = (index, extend = false) => {
    if (action.current || busy || saving || loading || !ownsRender()) return
    const anchor = extend && selection ? selection.a : index
    const first = words[Math.min(anchor, index)], last = words[Math.max(anchor, index)]
    setSelection({ a: anchor, b: index })
    set({ source: { src, in: first.t, out: last.end, t: first.t, seekToken: (store.source?.seekToken ?? 0) + 1 }, viewerMode: 'source' })
  }
  const run = async () => {
    if (action.current || controller.current || busy || saving || loading || dirty || !ownsRender()) return
    const token = ++generation.current, ctrl = new AbortController()
    controller.current = ctrl
    setBusy(true); setError(''); setJob(null); setImportPreview(null)
    try {
      await runTranscriptJob(api, '/api/analyze', { src, locale, kind: 'transcript', allowServer, force: record?.status === 'partial' || words.length > 0 }, { signal: ctrl.signal, onJob: value => generation.current === token && setJob(value) })
      const value = await api(`/api/transcript?src=${encodeURIComponent(src)}&locale=${encodeURIComponent(locale)}`)
      if (generation.current !== token || ctrl.signal.aborted) return
      drafts.current.delete(key)
      setRecord(value); setWords(value.words ?? []); setSelection(null); setPage(0)
      set({ transcript: { ...value, ownerRoot: root } })
      toast(`Transcribed ${value.words?.length ?? 0} words`)
    } catch (err) {
      if (generation.current === token) setError(err.name === 'AbortError' ? 'Transcription cancelled.' : err.message)
    } finally {
      if (generation.current === token) { setBusy(false); setJob(null); controller.current = null }
    }
  }
  const updateWords = next => {
    timelineActions.current = null
    setWords(next)
    drafts.current.set(key, { record, words: next, basis: recovery.current?.basis })
    recovery.current?.update(next)
    set({ transcript: { ...record, src, locale, words: next, ownerRoot: root } })
  }
  const correct = text => {
    if (action.current || loading || draftConflict || busy || saving || !ownsRender()) return
    updateWords(words.map((w, i) => i === lo ? { ...w, text } : w))
  }
  const correctTiming = (field, value) => {
    if (chosen.length !== 1 || action.current || loading || draftConflict || busy || saving || !ownsRender()) return
    try {
      updateWords(updateTranscriptTiming(words, lo, { [field]: value }, s.project.assets[src]?.duration))
      setError('')
    } catch (err) { setError(err.message) }
  }
  const sameImportSource = context => store.project === context.project && store.version === context.version &&
    store.project?.assets?.[src] === context.asset && context.duration === store.project?.assets?.[src]?.duration &&
    context.assetJSON === JSON.stringify(store.project?.assets?.[src])
  const readImport = async event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !record || draftConflict || record.status === 'stale' || !canEditTimeline()) return
    const context = { project: s.project, version: s.version, asset: s.project.assets[src], duration: s.project.assets[src]?.duration, assetJSON: JSON.stringify(s.project.assets[src]) }
    const owned = claimAction('import'); if (!owned) return
    setError(''); setImportPreview(null)
    try {
      if (file.size > MAX_TIMED_TRANSCRIPT_BYTES) throw new Error('Choose a timed transcript smaller than 16 MB')
      const text = await file.text()
      if (!ownsAction(owned)) return
      if (!sameImportSource(context)) throw new Error('The project or source changed while reading the transcript. Choose the file again.')
      const parsed = parseTimedTranscript(text, file.name, context.duration)
      setImportPreview({ ...parsed, name: file.name, key, revision: record.revision, fingerprint: record.fingerprint, context })
    } catch (err) { if (ownsAction(owned)) setError(err.message) }
    finally { releaseAction(owned) }
  }
  const useImport = () => {
    if (!importPreview || action.current || loading || draftConflict || busy || saving || !ownsRender() || importPreview.key !== key || importPreview.revision !== record?.revision || importPreview.fingerprint !== record?.fingerprint) return
    if (!sameImportSource(importPreview.context)) { setImportPreview(null); setError('The project or source changed after the import preview. Choose the file again.'); return }
    updateWords(importPreview.words)
    setSelection(null); setPage(0); setQuery(''); setImportPreview(null); setError('')
    toast('Imported transcript is an unsaved draft. Review and save it.')
  }
  const save = async () => {
    if (!dirty || draftConflict) return
    const owned = claimAction('save'); if (!owned) return
    setError(''); setDraftConflict(true)
    drafts.current.set(key, { record, words, basis: recovery.current?.basis })
    const ownedRecovery = owned.recovery
    try {
      try { await ownedRecovery?.flush() } catch (err) { if (!ownsAction(owned)) return; setRecoveryStatus(`Recovery copy failed: ${err.message}. Saving the corrections now.`) }
      if (!ownsAction(owned)) return
      const value = await api('/api/transcript', { src, locale, words, revision: record?.revision })
      if (!ownsAction(owned)) return
      try { await ownedRecovery?.retire(); if (ownsAction(owned)) { setRecoveryOffers([]); setRecoveryStatus('') } } catch (err) { if (!ownsAction(owned)) return; setRecoveryStatus(`Corrections saved, but the recovery copy remains: ${err.message}`) }
      if (!ownsAction(owned)) return
      drafts.current.delete(key)
      setRecord(value); setWords(value.words ?? words); setDraftConflict(false); set({ transcript: { ...value, ownerRoot: root } })
      ownedRecovery?.detach(); recovery.current = null
      setLoading(true); setReload(value => value + 1)
      toast('Saved transcript corrections')
    } catch (err) { if (ownsAction(owned)) setError(`${err.message} Recheck the saved transcript before retrying; the dispatched save may have completed.`) }
    finally { releaseAction(owned) }
  }
  const place = async op => {
    if (!chosen.length || !canEditTimeline()) return
    const from = Math.max(0, chosen[0].t - 0.05)
    const to = Math.min(s.project.assets[src]?.duration ?? Infinity, chosen.at(-1).end + 0.05)
    await edit({ op, src, in: from, out: to, start: op === 'append' ? undefined : time.t }, `${op} transcript selection`)
  }
  const lift = () => {
    if (!deletion || !canEditTimeline()) return
    return edit(deletion.ops, 'Lifted the transcript passage from the selected clip')
  }
  const discard = async () => {
    const owned = claimAction('discard'); if (!owned) return
    try {
      try { await owned.recovery?.retire() } catch (err) { if (!ownsAction(owned)) return; setRecoveryStatus(`The recovery copy remains on disk: ${err.message}`) }
      if (!ownsAction(owned)) return
      drafts.current.delete(key); setRecord(null); setWords([]); setSelection(null); setDraftConflict(false); setConfirmDiscard(false); setReload(value => value + 1)
    } finally { releaseAction(owned) }
  }
  const copyCorrections = async () => {
    try {
      await navigator.clipboard.writeText(`Source: ${src}\nLanguage: ${locale}\n\n${words.map(w => `[${w.t}–${w.end} s] ${w.text}`).join('\n')}`)
      toast('Retained transcript corrections copied')
    } catch { setError('Copy was unavailable. Your corrections are still retained; select and copy the transcript text below.') }
  }
  const recoveryAction = async (offer, action) => {
    if (action === 'recover' && dirty) return
    const owned = claimAction(action); if (!owned) return
    try {
      const value = await api(`/api/transcript/drafts/${action === 'copy' ? 'read' : action}`, { src, locale, id: offer.id })
      if (!ownsAction(owned)) return
      if (action === 'copy') { await navigator.clipboard.writeText(value.words.map(word => word.text).join(' ')); if (ownsAction(owned)) toast('Recovery text copied'); return }
      if (action === 'discard') { setRecoveryOffers(values => values.filter(item => item.id !== offer.id)); return }
      if (value.basis?.revision !== record?.revision || value.basis?.fingerprint !== (record?.fingerprint ?? '')) throw new Error('The saved transcript changed. Recheck it before recovery.')
      setWords(value.words); setDraftConflict(false); setSelection(null)
      drafts.current.set(key, { record, words: value.words, basis: value.basis })
      owned.recovery?.update(value.words)
      set({ transcript: { ...record, src, locale, words: value.words, ownerRoot: root } })
      setRecoveryStatus('Recovery words loaded as unsaved corrections. Review them before saving.')
    } catch (err) { if (ownsAction(owned)) setRecoveryStatus(err.message) }
    finally { releaseAction(owned) }
  }
  const captions = () => { if (!action.current && !dirty && canEditTimeline()) set({ transcript: { ...record, src, locale, words, ownerRoot: root }, browserTab: 'captions', page: 'edit', captionFromTranscript: true }) }
  const selectedClip = (viewProject()?.tracks ?? []).flatMap(track => track.clips).find(clip => s.selection.includes(clip.id) && clip.src === src)
  let deletion = null, deleteError = ''
  if (selectedClip && chosen.length) {
    try { deletion = transcriptDeleteOps(s.project, { id: selectedClip.id, comp: s.openComp ?? undefined, ranges: [{ from: chosen[0].t, to: chosen.at(-1).end }], ripple: false }) }
    catch (err) { deleteError = err.message }
  }
  const searchNext = direction => {
    if (!matches.length) return
    const index = direction > 0 ? matches.find(i => i > hi) ?? matches[0] : [...matches].reverse().find(i => i < lo) ?? matches.at(-1)
    selectWord(index)
    setPage(Math.floor(index / PAGE_WORDS))
  }
  const askForShorts = () => { if (!action.current && !dirty && canEditTimeline()) set({ transcript: { ...record, src, locale, words, ownerRoot: root }, page: 'edit', browserTab: 'shorts' }) }
  const currentPage = Math.min(page, Math.max(0, Math.ceil(words.length / PAGE_WORDS) - 1))
  const visible = words.slice(currentPage * PAGE_WORDS, (currentPage + 1) * PAGE_WORDS)

  return html`<section class="tr-editor" aria-label="Transcript editor">
    <div class="row gap">
      <b class="grow">Transcript</b>
      <button class="ghost btn-small" disabled=${!src || !available || busy || saving || loading || dirty} onClick=${run}>${words.length ? 'Transcribe again' : 'Transcribe'}</button>
    </div>
    <select class="tr-source" aria-label="Transcript media" title=${src} value=${src} disabled=${busy || saving} onChange=${e => setSrc(e.target.value)}>
      ${!sources.length ? html`<option value="">Import media with audio</option>` : sources.map(value => html`<option value=${value}>${basename(value)}</option>`)}
    </select>
    <label class="tr-status" for="transcript-import" title="SRT and WebVTT imports estimate word times within each cue. Timed JSON keeps source seconds as words with t, end and text.">Import an SRT, VTT or timed JSON transcript
      <input id="transcript-import" type="file" accept=".srt,.vtt,.json" aria-label="Import timed transcript" disabled=${!src || !record || busy || saving || loading || draftConflict || record.status === 'stale'} onChange=${readImport} />
    </label>
    ${importPreview ? html`<div class="tr-selection" aria-label="Timed transcript import preview">
      <div class="tr-status">${importPreview.name}, ${importPreview.words.length} words, ${importPreview.from} to ${importPreview.to} source seconds.</div>
      ${importPreview.warnings.map(warning => html`<div class="tr-status">${warning}</div>`)}
      <p>${importPreview.words.slice(0, 30).map(word => word.text).join(' ')}${importPreview.words.length > 30 ? '...' : ''}</p>
      <div class="tr-status">${dirty ? 'Using this file replaces the unsaved draft. The saved transcript stays available until you save corrections.' : 'Review the imported words as an unsaved draft, then save corrections.'}</div>
      <div class="row gap"><button class="ghost btn-small" disabled=${busy || saving || loading || draftConflict} onClick=${useImport}>${dirty ? 'Replace unsaved draft with import' : 'Use imported transcript'}</button><button class="ghost btn-small" onClick=${() => { if (!action.current && ownsRender()) setImportPreview(null) }}>Cancel import</button></div>
    </div>` : null}
    <details><summary class="tr-status">Language, recognition and imports</summary>
      <div class="tr-status">SRT and WebVTT imports estimate word times within each cue. Timed JSON preserves source seconds as words with t, end and text. Import does not run speech recognition.</div>
      <div class="row gap"><label for="transcript-locale">Language</label><input id="transcript-locale" value=${locale} disabled=${busy || saving || dirty} placeholder="en-US" onChange=${e => setLocale(e.target.value.trim() || 'en-US')} /></div>
      <div class="tr-status">${s.caps.transcriber === 'speech' ? 'Apple Speech uses on-device recognition when available. Server recognition requires your choice below.' : 'whisper.cpp recognizes audio locally with the installed model. Language support depends on that model.'}</div>
      ${s.caps.transcriber === 'speech' ? html`<label class="row gap"><input type="checkbox" checked=${allowServer} disabled=${busy || saving} onChange=${e => setAllowServer(e.target.checked)} />Allow Apple server recognition if this language needs it</label>` : null}
    </details>
    ${!available && words.length ? html`<div class="tr-status">${s.caps.transcriber === 'speech' ? 'Speech recognition is unavailable on this device.' : 'Install whisper.cpp and a model to transcribe again locally.'}</div>` : null}
    ${recoveryStatus ? html`<div class="tr-status" role="status">${recoveryStatus}</div>` : null}
    ${recoveryOffers.map(offer => html`<div class="tr-selection"><div class="tr-status">Recovery copy from ${new Date(offer.createdAt).toLocaleString()}, ${offer.wordCount} words. ${offer.recoverable ? 'Review it as unsaved corrections.' : 'Its project, source or saved transcript changed. Copy its text.'}</div><div class="row gap">${offer.recoverable ? html`<button class="ghost btn-small" disabled=${dirty || busy || saving || loading} onClick=${() => recoveryAction(offer, 'recover')}>Recover corrections</button>` : null}<button class="ghost btn-small" disabled=${busy || saving || loading} onClick=${() => recoveryAction(offer, 'copy')}>Copy recovery text</button><button class="ghost btn-small danger" disabled=${busy || saving} onClick=${() => recoveryAction(offer, 'discard')}>Discard recovery copy</button></div></div>`)}
    ${loading ? html`<div class="tr-status" role="status">Loading the saved transcript...</div>` : null}
    ${busy ? html`<div class="tr-progress" role="status"><span class="tr-status">${job?.message ?? 'Transcribing audio...'}</span><progress max="1" value=${Number.isFinite(job?.progress) ? job.progress : undefined}></progress><button class="ghost btn-small" onClick=${() => controller.current?.abort()}>Cancel</button></div>` : null}
    ${error ? html`<div class="tr-status error" role="alert">${error}</div>` : null}
    ${record?.status === 'partial' ? html`<div class="tr-status error">This transcript is partial. ${record.warnings?.join(' ') ?? 'Review the recognized portion before using it.'}</div>` : null}
    ${record?.status === 'stale' ? html`<div class="tr-status error">${record.warning ?? 'The source changed. Transcribe it again.'}</div>` : null}
    ${dirty ? html`<div class="row gap"><button class="ghost btn-small" disabled=${busy || saving || loading} onClick=${() => setReload(value => value + 1)}>Recheck saved transcript</button><button class="ghost btn-small" onClick=${copyCorrections}>Copy retained corrections</button><button class="ghost btn-small danger" disabled=${busy || saving} onClick=${() => setConfirmDiscard(true)}>Discard unsaved corrections</button></div>` : null}
    ${confirmDiscard ? html`<div class="tr-status error">Discard this unsaved draft and load the saved words?</div><div class="row gap"><button class="ghost btn-small danger" disabled=${busy || saving} onClick=${discard}>Discard corrections</button><button class="ghost btn-small" onClick=${() => setConfirmDiscard(false)}>Keep corrections</button></div>` : null}
    ${words.length ? html`
      <input class="tr-search" type="search" aria-label="Search transcript" placeholder="Search transcript" value=${query} onInput=${e => setQuery(e.target.value)} />
      ${query.trim() ? html`<div class="row gap"><span class="tr-status grow">${matches.length} matches</span><button class="ghost btn-small" disabled=${!matches.length} aria-label="Previous match" onClick=${() => searchNext(-1)}>Previous</button><button class="ghost btn-small" disabled=${!matches.length} aria-label="Next match" onClick=${() => searchNext(1)}>Next</button></div>` : null}
      <div class="row gap">
        <button class="ghost btn-small" disabled=${!dirty || saving || busy || loading || draftConflict} onClick=${save}>${saving ? 'Saving...' : 'Save corrections'}</button>
        <button class="ghost btn-small" disabled=${dirty || busy || saving || loading || draftConflict} onClick=${captions}>Make captions</button><button class="ghost btn-small" disabled=${dirty || busy || saving || loading || draftConflict} onClick=${askForShorts}>Make shorts</button>
      </div>
      <div class="tr-status">Click a word to seek. Shift-click selects a passage. ${dirty ? 'Save your corrections before generating captions or shorts.' : `${words.length} words. Select one word to edit its text and source timing.`}</div>
      <div class="tr-words">${visible.map((word, index) => {
        const i = currentPage * PAGE_WORDS + index
        return html`<button key=${i} ref=${node => node ? wordNodes.current.set(i, node) : wordNodes.current.delete(i)} class=${`tr-word ${i >= lo && i <= hi ? 'sel' : ''} ${matchSet.has(i) ? 'match' : ''}`} aria-pressed=${i >= lo && i <= hi} title=${timecode(word.t, s.project.fps)} onClick=${e => selectWord(i, e.shiftKey)} onKeyDown=${e => {
          if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
            e.preventDefault()
            const target = Math.max(0, Math.min(words.length - 1, i + (e.key === 'ArrowRight' ? 1 : -1)))
            selectWord(target, e.shiftKey); setPage(Math.floor(target / PAGE_WORDS))
            requestAnimationFrame(() => wordNodes.current.get(target)?.focus())
          }
        }}>${word.text}</button>`
      })}</div>
      ${words.length > PAGE_WORDS ? html`<div class="row tr-paging"><button class="ghost btn-small" disabled=${currentPage === 0} onClick=${() => setPage(currentPage - 1)}>Previous words</button><span class="tr-status">${currentPage * PAGE_WORDS + 1}-${Math.min(words.length, (currentPage + 1) * PAGE_WORDS)} of ${words.length}</span><button class="ghost btn-small" disabled=${(currentPage + 1) * PAGE_WORDS >= words.length} onClick=${() => setPage(currentPage + 1)}>Next words</button></div>` : null}
      ${chosen.length ? html`<div class="tr-selection">
        <span class="tr-time">${timecode(chosen[0].t, s.project.fps)} to ${timecode(chosen.at(-1).end, s.project.fps)} in the source</span>
        ${chosen.length === 1 ? html`<div class="row gap"><label for="transcript-word">Correct word</label><input id="transcript-word" aria-label="Correct selected word" value=${chosen[0].text} disabled=${busy || saving || loading || draftConflict} onInput=${e => correct(e.target.value)} /></div>
        <div class="row gap"><label for="transcript-word-start">Start seconds</label><input id="transcript-word-start" type="number" min="0" max=${s.project.assets[src]?.duration} step="0.001" aria-label="Selected word start seconds" value=${chosen[0].t} disabled=${busy || saving || loading || draftConflict} onChange=${e => correctTiming('t', e.target.value)} /><label for="transcript-word-end">End seconds</label><input id="transcript-word-end" type="number" min="0" max=${s.project.assets[src]?.duration} step="0.001" aria-label="Selected word end seconds" value=${chosen[0].end} disabled=${busy || saving || loading || draftConflict} onChange=${e => correctTiming('end', e.target.value)} /></div>` : html`<p>${chosen.map(w => w.text).join(' ')}</p>`}
        <div class="row gap"><button class="ghost btn-small" disabled=${timelineLease.blocked} onClick=${() => place('append')}>Append selection</button><button class="ghost btn-small" disabled=${timelineLease.blocked} onClick=${() => place('insert')}>Insert at playhead</button><button class="ghost btn-small" onClick=${() => addRef({ kind: 'transcript', id: `${src}@${chosen[0].t}-${chosen.at(-1).end}`, label: chosen.map(w => w.text).join(' ').slice(0, 100) })}>Ask agent about selection</button></div>
        ${selectedClip ? html`<div class="row gap"><button class="ghost btn-small danger" disabled=${!deletion || timelineLease.blocked} onClick=${lift}>Lift from selected clip</button><span class="tr-status">${deleteError || `Cuts ${selectedClip.id} and its linked audio. Other tracks keep their timing.`}</span></div>` : html`<p>Select a matching timeline clip to lift this passage from the edit.</p>`}
      </div>` : null}` : !loading && !busy ? html`<div class="tr-status tr-next">${!src ? 'Import media with audio to transcribe it.' : available ? 'Press Transcribe to search, correct and caption this source.' : s.caps.transcriber === 'speech' ? 'Speech recognition is unavailable here. Import a transcript file above.' : 'Install whisper.cpp and a model to transcribe, or import a transcript file above.'}</div>` : null}
  </section>`
}

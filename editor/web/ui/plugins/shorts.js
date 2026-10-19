import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { timecode } from '/core/project.js'
import { api, set, store, toast, useStore } from '../store.js'
import { transcriptSources } from '../transcript.js'
import { registerBrowserTab } from '../registry.js'
import { shortsCapture, shortsCaptureMatches, shortsCreationBody, shortsEvidence, shortsNavigationMatches, shortsRanges, shortsReview, shortsReviewBody, shortsTranscriptGuard } from '../shorts-workflow.js'

const html = htm.bind(h)
const CSS = `
.shorts-tab { display:flex; flex-direction:column; gap:9px; }
.shorts-tab input,.shorts-tab select { min-width:0; }
.shorts-form { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
.shorts-form label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--muted); }
.shorts-form .full { grid-column:1/-1; }
.shorts-form input,.shorts-form select { width:100%; }
.shorts-note { color:var(--muted); font-size:12px; line-height:1.45; }
.shorts-list { display:flex; flex-direction:column; gap:8px; }
.shorts-card { border:1px solid var(--line); border-radius:9px; padding:8px; display:flex; flex-direction:column; gap:7px; }
.shorts-card.chosen { border-color:#f5b94280; }
.shorts-card input[type=text] { width:100%; }
.shorts-card .row { flex-wrap:wrap; }
.shorts-card .shorts-range { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
.shorts-range label { font-size:11px; color:var(--muted); }
.shorts-range input { width:100%; font-variant-numeric:tabular-nums; }
.shorts-evidence { margin:0; padding:0; border:0; max-height:110px; overflow:auto; font-size:12px; line-height:1.5; white-space:pre-wrap; }
.shorts-review { padding:9px; border:1px solid #f5b94260; border-radius:9px; font-size:12px; line-height:1.5; }
.shorts-tab .error { color:#ff8b83; }
.shorts-tab button { min-height:32px; }
@media(pointer:coarse) { .shorts-tab button,.shorts-tab input,.shorts-tab select { min-height:44px; } }
`
if (typeof document !== 'undefined' && !document.getElementById('reel-shorts-css')) {
  const style = document.createElement('style'); style.id = 'reel-shorts-css'; style.textContent = CSS; document.head.appendChild(style)
}

function ShortsTab() {
  const s = useStore(), sources = transcriptSources(s.project)
  const [src, setSrc] = useState(s.transcript?.src ?? (sources.includes(s.source?.src) ? s.source.src : sources[0] ?? ''))
  const [transcript, setTranscript] = useState(null)
  const [locale, setLocale] = useState(s.transcript?.locale ?? 'en-US')
  const [minDur, setMinDur] = useState(15), [maxDur, setMaxDur] = useState(60), [count, setCount] = useState(5)
  const [query, setQuery] = useState(''), [format, setFormat] = useState('vertical'), [style, setStyle] = useState('karaoke')
  const [captions, setCaptions] = useState(true), [candidates, setCandidates] = useState([])
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const generation = useRef(0)
  const chosen = candidates.filter(c => c.chosen)
  const dimensions = format === 'square' ? [1080, 1080] : format === 'portrait' ? [1080, 1350] : format === 'landscape' ? [1920, 1080] : [1080, 1920]
  useEffect(() => {
    let active = true
    const token = ++generation.current, root = s.root
    setCandidates([]); setPreview(null); setError(''); setTranscript(null); setBusy(false)
    if (src && !sources.includes(src)) { setSrc(sources[0] ?? ''); return }
    if (src) api(`/api/transcript?src=${encodeURIComponent(src)}&locale=${encodeURIComponent(locale)}`).then(value => active && generation.current === token && store.root === root && setTranscript(value)).catch(err => active && generation.current === token && store.root === root && setError(err.message))
    return () => { active = false; generation.current++ }
  }, [s.root, src, locale])
  const update = (index, patch) => { setCandidates(list => list.map((c, i) => i === index ? { ...c, ...patch, ...('from' in patch || 'to' in patch ? { reason: 'Your edited source range' } : {}) } : c)); setPreview(null) }
  const reload = async () => {
    const token = ++generation.current, root = store.root
    setBusy(true); setError(''); setPreview(null)
    try {
      const value = await api(`/api/transcript?src=${encodeURIComponent(src)}&locale=${encodeURIComponent(locale)}`)
      if (generation.current === token && store.root === root) setTranscript(value)
    } catch (err) { if (generation.current === token && store.root === root) setError(err.message) }
    finally { if (generation.current === token) setBusy(false) }
  }
  const propose = async () => {
    const token = generation.current
    setBusy(true); setError(''); setPreview(null)
    try {
      const capture = shortsCapture(store, src, locale), guard = shortsTranscriptGuard(transcript)
      const result = await api('/api/shorts/propose', { src, locale, minDur, maxDur, count, query, expectedVersion: capture.version, ...guard })
      if (generation.current !== token) return
      if (!shortsCaptureMatches(capture, store, src, locale) || result.sourceFingerprint !== guard.expectedSourceFingerprint || result.transcriptRevision !== guard.expectedTranscriptRevision) throw new Error('The project, source or transcript changed. Reload the transcript and find excerpts again.')
      setCandidates(result.candidates.map((c, i) => ({ ...c, name: `Clip ${i + 1}`, chosen: true })))
      if (!result.candidates.length) setError(result.warnings?.join(' ') || 'No matching speech range. Try a shorter duration or a different topic.')
    } catch (err) { if (generation.current === token) setError(err.message) }
    finally { if (generation.current === token) setBusy(false) }
  }
  const marked = s.source?.src === src && Number.isFinite(s.source.in) && Number.isFinite(s.source.out) && s.source.in >= 0 && s.source.out > s.source.in && s.source.out <= s.project?.assets?.[src]?.duration && s.source.out - s.source.in <= 600
  const addMarked = () => {
    setCandidates(list => [...list, { from: s.source.in, to: s.source.out, name: `Clip ${list.length + 1}`, chosen: true, reason: 'Your source selection' }])
    setPreview(null)
  }
  const previewRange = candidate => {
    try {
      shortsCapture(store, src, locale)
      const [range] = shortsRanges([candidate], store.project.assets[src].duration)
      set({ source: { src, in: range.from, out: range.to, t: range.from }, viewerMode: 'source' })
      setError('')
    } catch (err) { setError(err.message) }
  }
  const build = async apply => {
    const token = generation.current
    setBusy(true); setError('')
    try {
      const capture = shortsCapture(store, src, locale)
      const body = apply ? shortsCreationBody(preview, store, src, locale) : shortsReviewBody(capture, chosen, { dimensions, style, captions }, transcript)
      if (apply) setPreview(null)
      const result = await api('/api/shorts/build', body)
      if (generation.current !== token || store.root !== capture.root) return
      if (!apply) {
        if (!shortsCaptureMatches(capture, store, src, locale)) throw new Error('The project changed during review. Review the compositions again.')
        setPreview(shortsReview(capture, body, result))
      } else {
        if (result.applied !== true) throw new Error('The compositions were not created. Review and try again.')
        const loaded = result.project ? result : await api('/api/project')
        if (generation.current !== token || store.root !== capture.root) return
        if (loaded.project && loaded.version >= store.version) set({ project: loaded.project, version: loaded.version })
        const first = result.comps?.[0]?.id
        if (!first || !store.project?.comps?.[first]) throw new Error('The shorts were created, but the updated project could not be loaded. Refresh the project before continuing.')
        if (shortsNavigationMatches(capture, store)) set({ page: 'edit', openComp: first, selection: [], viewerMode: 'timeline' })
        toast(`Created ${result.comps.length} editable short composition${result.comps.length === 1 ? '' : 's'}`)
      }
    } catch (err) { if (generation.current === token) { setPreview(null); setError(err.message) } }
    finally { if (generation.current === token) setBusy(false) }
  }
  const canUseTranscript = ['complete', 'ready', 'partial'].includes(transcript?.status) && transcript.words?.length > 0
  return html`<section class="tab-body shorts-tab" aria-label="Short clip builder">
    <b>Make shorts</b><div class="shorts-note">Review speech excerpts, then build separate compositions with native video, audio and captions.</div>
    <div class="shorts-form">
      <label class="full">Source<select value=${src} disabled=${busy} onChange=${e => setSrc(e.target.value)}>${!sources.length ? html`<option value="">Import media with audio</option>` : sources.map(value => html`<option value=${value}>${value.split('/').pop()}</option>`)}</select></label>
      <label class="full">Language<input value=${locale} disabled=${busy} placeholder="en-US" onChange=${e => setLocale(e.target.value.trim() || 'en-US')} /></label>
      <label>Minimum seconds<input type="number" min="1" max="600" value=${minDur} disabled=${busy} onInput=${e => (setMinDur(Number(e.target.value)), setPreview(null))} /></label>
      <label>Maximum seconds<input type="number" min="1" max="600" value=${maxDur} disabled=${busy} onInput=${e => (setMaxDur(Number(e.target.value)), setPreview(null))} /></label>
      <label>Clip count<input type="number" min="1" max="20" value=${count} disabled=${busy} onInput=${e => setCount(Number(e.target.value))} /></label>
      <label>Format<select value=${format} disabled=${busy} onChange=${e => (setFormat(e.target.value), setPreview(null))}><option value="vertical">9:16 vertical</option><option value="portrait">4:5 portrait</option><option value="square">1:1 square</option><option value="landscape">16:9 landscape</option></select></label>
      <label class="full">Topic or phrase<input type="search" value=${query} disabled=${busy} placeholder="Optional transcript search" onInput=${e => setQuery(e.target.value)} /></label>
      <label class="full">Caption style<select value=${style} disabled=${busy || !captions} onChange=${e => (setStyle(e.target.value), setPreview(null))}><option value="plain">Plain</option><option value="boxed">Boxed</option><option value="karaoke">Word highlight</option><option value="word">One word at a time</option></select></label>
    </div>
    <label class="row gap"><input type="checkbox" checked=${captions} disabled=${busy} onChange=${e => (setCaptions(e.target.checked), setPreview(null))} />Include editable captions</label>
    ${!canUseTranscript ? html`<div class="shorts-note">Transcribe this source on the Media page first. You can also build a range you marked in the source viewer without captions.</div><button class="ghost" onClick=${() => set({ page: 'media', source: { src }, transcript: { src, locale, words: transcript?.words ?? [] } })}>Open transcript</button>` : null}
    <div class="row gap wrap"><button class="ghost" disabled=${busy || !src} onClick=${reload}>Reload transcript</button><button disabled=${busy || !canUseTranscript} onClick=${propose}>${busy ? 'Working...' : 'Find excerpts'}</button><button class="ghost" disabled=${busy || !marked || candidates.length >= 20} onClick=${addMarked}>Add source selection</button></div>
    <div class="shorts-note">Suggestions use speech boundaries and matching transcript words. Review their meaning and framing before publishing.</div>
    ${transcript?.status === 'partial' ? html`<div class="shorts-note error">This transcript is partial. Excerpts can use only the words recognized so far.</div>` : null}
    ${error ? html`<div class="shorts-note error" role="alert">${error}</div>` : null}
    <div class="shorts-list">${candidates.map((candidate, i) => html`<article key=${i} class=${`shorts-card ${candidate.chosen ? 'chosen' : ''}`}>
      <div class="row gap"><label><input type="checkbox" checked=${candidate.chosen} disabled=${busy} onChange=${e => update(i, { chosen: e.target.checked })} /> Include</label><span class="grow"></span><span class="tr-time">${Math.max(0, candidate.to - candidate.from).toFixed(1)}s</span><button class="ghost" disabled=${busy} onClick=${() => previewRange(candidate)}>Preview</button></div>
      <input type="text" aria-label=${`Clip ${i + 1} name`} value=${candidate.name} disabled=${busy} onInput=${e => update(i, { name: e.target.value })} />
      <div class="shorts-range"><label>Source start<input type="number" min="0" step="0.01" value=${candidate.from} disabled=${busy} onInput=${e => update(i, { from: Number(e.target.value) })} /></label><label>Source end<input type="number" min="0" step="0.01" value=${candidate.to} disabled=${busy} onInput=${e => update(i, { to: Number(e.target.value) })} /></label></div>
      <div class="shorts-note">${candidate.reason}</div><p class="shorts-evidence">${shortsEvidence(transcript?.words, candidate)}</p>
    </article>`)}</div>
    ${chosen.length ? html`<button class="ghost" disabled=${busy || (captions && !canUseTranscript)} onClick=${() => build(false)}>Review ${chosen.length} composition${chosen.length === 1 ? '' : 's'}</button>` : null}
    ${preview ? html`<div class="shorts-review">${preview.comps.map(comp => html`<div>${comp.name}: ${timecode(comp.duration, s.project.fps)} at ${preview.body.width} × ${preview.body.height}</div>`)}<p>Each composition keeps its cuts and captions editable. The source files stay in place. This is one undoable project edit.</p><button disabled=${busy || !shortsCaptureMatches(preview.capture, s, src, locale)} onClick=${() => build(true)}>Create ${preview.comps.length} composition${preview.comps.length === 1 ? '' : 's'}</button>${!shortsCaptureMatches(preview.capture, s, src, locale) ? html`<div class="shorts-note">The project changed. Review the compositions again.</div>` : null}</div>` : null}
  </section>`
}

registerBrowserTab({ id: 'shorts', label: 'Shorts', order: 55, component: ShortsTab })

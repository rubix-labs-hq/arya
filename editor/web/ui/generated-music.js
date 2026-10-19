import { h, render } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { MUSIC_INSTRUMENTS, validateMusicScore } from '/core/music-score.js'
import { createGeneratedMusicSession, musicVariation, newMusicScore, resizeMusicScore } from './generated-music-model.js'
import { api, store, time, useStore } from './store.js'

const html = htm.bind(h)
const read = () => ({ root: store.root, comp: store.openComp, project: store.project, version: store.version, connected: store.connected })
const controlStyle = { minHeight: '44px' }
let closeCurrent = null

export function openGeneratedMusicDetails(source = null) {
  closeCurrent?.()
  const previous = document.activeElement, mount = document.createElement('div')
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    render(null, mount); mount.remove()
    if (closeCurrent === close) closeCurrent = null
    if (previous?.isConnected) previous.focus?.()
  }
  document.body.append(mount)
  closeCurrent = close
  try { render(html`<${GeneratedMusicDetails} source=${source} onClose=${close} />`, mount) }
  catch (error) { close(); throw error }
}

export function GeneratedMusicDetails({ source = null, onClose }) {
  useStore()
  const [, update] = useState(0)
  const [session] = useState(() => createGeneratedMusicSession({ source, read, request: api, changed: () => update(n => n + 1) }))
  const state = session.state, creating = source === null, saved = state.original?.generated.score
  const retainedScore = state.retained ? JSON.parse(state.retained.assetJSON).generated.score : null
  const [mode, setMode] = useState(creating ? 'create' : 'place')
  const [draft, setDraft] = useState(() => creating ? newMusicScore() : ({ ...saved, title: `${saved?.title ?? 'Music'} variation`.slice(0, 120) }))
  const scope = store.openComp == null ? store.project : store.project?.comps?.[store.openComp]
  const tracks = scope?.tracks?.filter(track => track.kind === 'audio') ?? []
  const [track, setTrack] = useState(() => tracks.find(track => track.id === 'A3')?.id ?? '')
  const [start, setStart] = useState(() => String(time.t))
  const [error, setError] = useState('')
  const [durationInput, setDurationInput] = useState(null)
  const [durationError, setDurationError] = useState('')
  const dialog = useRef(null)
  useEffect(() => { session.loadCapabilities().catch(e => setError(e.message)) }, [session])
  useLayoutEffect(() => {
    dialog.current?.querySelector('[data-music-close]')?.focus()
    return () => session.close()
  }, [session])
  const close = () => { session.close(); onClose() }
  const change = action => { session.invalidate(); setError(''); action() }
  let normalized = null, scoreError = ''
  try { normalized = mode === 'create' ? validateMusicScore(draft) : mode === 'variation' ? musicVariation(saved, { title: draft.title, bpm: draft.bpm, seed: draft.seed ?? 0, parts: draft.parts }) : validateMusicScore(retainedScore ?? saved) }
  catch (e) { scoreError = e.message }
  if (mode === 'create' && durationError) scoreError = durationError
  const displayScore = creating && mode === 'create' ? draft : saved ?? retainedScore ?? draft
  const displayName = creating && mode === 'create' ? draft.title : state.original?.name || state.retained?.name || draft.title
  let savedSummary = ''
  try { const original = validateMusicScore(displayScore); savedSummary = `${original.bpm} BPM · ${(original.lengthBeats * 60 / original.bpm).toFixed(2)} seconds · ${original.parts.map(part => part.instrument).join(', ')}` } catch {}
  const blocked = state.busy || state.checking || !session.sourceCurrent() || !session.available()
  const review = async () => {
    setError('')
    try { await session.review({ mode, track, start: start.trim() === '' ? NaN : Number(start), score: normalized }) }
    catch (e) { setError(e.message) }
  }
  const run = async () => {
    setError('')
    try { const result = await session.run(); if (result && mode !== 'place') setMode('place') }
    catch (e) { setError(e.message) }
  }
  const durationChanged = event => change(() => {
    const value = event.target.value
    setDurationInput(value)
    try { setDraft(resizeMusicScore(draft, value.trim() === '' ? NaN : Number(value))); setDurationInput(null); setDurationError('') }
    catch (e) { setDurationError(e.message) }
  })
  const noteChanged = (partIndex, noteIndex, field, value) => change(() => setDraft({ ...draft,
    parts: draft.parts.map((part, i) => i !== partIndex ? part : { ...part, notes: part.notes.map((note, j) => j !== noteIndex ? note : { ...note, [field]: value }) }),
  }))
  const pitchName = value => `${['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'][value % 12]}${Math.floor(value / 12) - 1}`
  const trap = event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const element = dialog.current
    const controls = [...element.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href]')].filter(control => !control.matches(':disabled') && control.getClientRects().length)
    const first = controls[0], last = controls.at(-1), outside = !element.contains(document.activeElement) || document.activeElement === element
    if (!first) { event.preventDefault(); element.focus() }
    else if (event.shiftKey && (document.activeElement === first || outside)) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && (document.activeElement === last || outside)) { event.preventDefault(); first.focus() }
  }
  return html`
    <div class="modal-back" onClick=${close}>
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="generated-music-title" tabIndex="-1" ref=${dialog} onKeyDown=${trap} onClick=${event => event.stopPropagation()}>
        <div class="row gap" style=${{ justifyContent: 'space-between' }}>
          <h3 id="generated-music-title">${creating ? 'Create music' : 'Music details'}</h3>
          <button type="button" class="ghost" data-music-close style=${controlStyle} onClick=${close}>Close</button>
        </div>
        <div style=${{ overflowY: 'auto', minHeight: 0, display: 'grid', gap: '12px' }}>
          <div><strong>${displayName || 'Original cue'}</strong><p class="hint">${savedSummary}</p><p class="hint">${creating ? 'Create a locally synthesized instrumental cue from editable notes. The WAV is saved in Media, then placed in your reviewed empty range.' : 'Locally synthesized. Reuse this source or make a variation from its saved notes.'}</p></div>
          ${saved || retainedScore ? html`<details><summary style=${controlStyle}>Saved score and notes</summary><pre style=${{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text', maxHeight: '240px', overflowY: 'auto' }}>${JSON.stringify(saved ?? retainedScore, null, 2)}</pre></details>` : null}
          ${state.retained ? html`<div role="status">${creating ? 'Saved music' : 'Saved variation'}: ${state.retained.name}. Reuse places this Media source without rendering again.${state.original ? html`<button type="button" class="ghost" style=${controlStyle} disabled=${state.busy} onClick=${() => change(() => session.useOriginal())}>Use original source</button>` : null}</div>` : null}
          ${!session.sourceCurrent() ? html`<p role="alert">${creating ? 'The project or composition changed, or the editor disconnected. Close and reopen Create music for the current project.' : 'The project, composition or source changed, or the editor disconnected. Close and reopen its current Media entry.'}</p>` : null}
          ${state.checking ? html`<p role="status">Checking local composer availability…</p>` : !session.available() ? html`<button type="button" style=${controlStyle} disabled=${state.busy || !session.sourceCurrent()} onClick=${() => { setError(''); return session.loadCapabilities().catch(e => setError(e.message)) }}>Check composer availability</button>` : null}
          <fieldset disabled=${blocked} style=${{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'grid', gap: '12px' }}>
            <legend>${creating ? 'Compose or reuse' : 'Reuse or vary'}</legend>
            <div class="row gap" style=${{ flexWrap: 'wrap' }}>
              ${state.original || state.retained ? html`<button type="button" style=${controlStyle} aria-pressed=${mode === 'place'} onClick=${() => change(() => setMode('place'))}>Reuse saved music</button>` : null}
              <button type="button" style=${controlStyle} aria-pressed=${mode !== 'place'} onClick=${() => change(() => setMode(creating ? 'create' : 'variation'))}>${creating ? state.retained ? 'Create another score' : 'Create music' : 'Create variation'}</button>
            </div>
            ${mode !== 'place' ? html`<div style=${{ display: 'grid', gap: '8px' }}>
              <p class="hint">${creating ? 'Start with four editable notes. Tempo changes playback speed; duration stretches note timing. Choose the instrument below. No external model or recordings are used.' : 'Keep the saved notes. Change tempo or instruments; the seed changes synthesized noise. Your original source stays in Media.'}</p>
              <label>${creating ? 'Music name' : 'Variation name'} <input style=${controlStyle} value=${draft.title ?? ''} maxLength="120" onInput=${event => change(() => setDraft({ ...draft, title: event.target.value }))} /></label>
              <label>Tempo in BPM <input style=${controlStyle} type="number" min="40" max="220" step="1" value=${draft.bpm ?? ''} onInput=${event => change(() => setDraft({ ...draft, bpm: event.target.value === '' ? NaN : Number(event.target.value) }))} /></label>
              ${creating ? html`<label>Duration in seconds <input style=${controlStyle} type="number" min="0.25" max="60" step="0.25" value=${durationInput ?? (Number.isFinite(draft.bpm) && draft.bpm > 0 ? draft.lengthBeats * 60 / draft.bpm : '')} onInput=${durationChanged} /></label>` : null}
              <label>Synthesis seed <input style=${controlStyle} type="number" min="0" max="4294967295" step="1" value=${draft.seed ?? 0} onInput=${event => change(() => setDraft({ ...draft, seed: event.target.value === '' ? NaN : Number(event.target.value) }))} /></label>
              ${(Array.isArray(draft.parts) ? draft.parts : []).map((part, index) => html`<label key=${part.id}>${part.id} instrument <select style=${controlStyle} value=${part.instrument} onChange=${event => change(() => setDraft({ ...draft, parts: draft.parts.map((item, i) => i === index ? { ...item, instrument: event.target.value } : item) }))}>${MUSIC_INSTRUMENTS.map(instrument => html`<option key=${instrument} value=${instrument}>${instrument}</option>`)}</select></label>`)}
              ${creating ? html`<details><summary style=${controlStyle}>Edit starting notes</summary><p class="hint">Note positions and lengths are in beats. Review the duration again after editing.</p>
                ${draft.parts.map((part, partIndex) => html`<fieldset key=${part.id} style=${{ minWidth: 0 }}><legend>${part.id}</legend>${part.notes.map((note, noteIndex) => html`<div key=${noteIndex} class="row gap" style=${{ flexWrap: 'wrap', marginBottom: '8px' }}>
                  <label>Note ${noteIndex + 1} pitch <select style=${controlStyle} value=${note.pitch} onChange=${event => noteChanged(partIndex, noteIndex, 'pitch', Number(event.target.value))}>${Array.from({ length: 73 }, (_, index) => index + 24).map(pitch => html`<option key=${pitch} value=${pitch}>${pitchName(pitch)}</option>`)}</select></label>
                  <label>Start beat <input style=${{ ...controlStyle, width: '80px' }} type="number" min="0" step="0.25" value=${note.at} onInput=${event => noteChanged(partIndex, noteIndex, 'at', event.target.value === '' ? NaN : Number(event.target.value))} /></label>
                  <label>Length in beats <input style=${{ ...controlStyle, width: '80px' }} type="number" min="0.025" step="0.25" value=${note.duration} onInput=${event => noteChanged(partIndex, noteIndex, 'duration', event.target.value === '' ? NaN : Number(event.target.value))} /></label>
                </div>`)}</fieldset>`)}
              </details>` : null}
            </div>` : null}
            <div style=${{ display: 'grid', gap: '8px' }}>
              <label>Audio track <select style=${controlStyle} value=${track} onChange=${event => change(() => setTrack(event.target.value))}><option value="">Choose an audio track</option>${tracks.map(item => html`<option key=${item.id} value=${item.id} disabled=${item.locked}>${item.name || item.id}${item.locked ? ' · locked' : ''}</option>`)}</select></label>
              <div class="row gap" style=${{ flexWrap: 'wrap' }}><label>Start in seconds <input style=${controlStyle} type="number" min="0" max="14400" step="any" value=${start} onInput=${event => change(() => setStart(event.target.value))} /></label><button type="button" class="ghost" style=${controlStyle} onClick=${() => change(() => setStart(String(time.t)))}>Use playhead</button></div>
              <p class="hint">Review the current timeline before placing. Music fills an empty range; it does not move or replace clips.</p>
              <button type="button" style=${controlStyle} disabled=${!!scoreError || !track} onClick=${review}>Review target</button>
            </div>
          </fieldset>
          ${scoreError ? html`<p role="alert">${creating ? 'Score' : 'Saved score'} cannot be used: ${scoreError}</p>` : null}
          ${state.review ? html`<p role="status">Reviewed ${state.review}${!session.currentReview() ? '. The timeline changed. Review again.' : ''}</p>` : null}
          ${error || state.error ? html`<p role="alert">${error || state.error}</p>` : null}
          ${state.message ? html`<p role="status" aria-live="polite">${state.message}</p>` : null}
          ${state.busy ? html`<p role="status">Waiting for the music request. Closing this dialog does not cancel it. Completed music remains in Media.</p>` : null}
        </div>
        <div class="modal-actions"><button type="button" style=${controlStyle} disabled=${blocked || !!scoreError || !session.currentReview()} onClick=${run}>${mode === 'create' ? 'Create music and place' : mode === 'variation' ? 'Create variation and place' : state.retained && !creating ? 'Place saved variation' : 'Place saved music'}</button></div>
      </section>
    </div>
  `
}

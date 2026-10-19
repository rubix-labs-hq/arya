import { formatFileSize } from '../browser-local/delivery-preview.js'
import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'

const html = htm.bind(h)
export function DeliveryPreview({ state, close }) {
  const dialog = useRef(null), media = useRef(null)
  const [details, setDetails] = useState(null), [error, setError] = useState('')
  useEffect(() => {
    const previous = document.activeElement
    dialog.current?.querySelector('button')?.focus()
    return () => {
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  useEffect(() => {
    const element = media.current
    return () => { if (element) { element.pause(); element.removeAttribute('src'); element.load() } }
  }, [state.receipt?.previewID])
  useEffect(() => { setDetails(null); setError('') }, [state.receipt?.previewID])
  const trap = event => {
    event.stopPropagation()
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.key !== 'Tab') return
    const controls = [...dialog.current.querySelectorAll('button:not(:disabled),video[controls],audio[controls]')].filter(element => element.getClientRects().length)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  const receipt = state.receipt
  const loaded = event => { const element = event.currentTarget; setDetails({ duration: element.duration, width: element.videoWidth, height: element.videoHeight }) }
  const failed = () => setError('This browser could not play the saved file. Download it and inspect it in another player. The export remains saved.')
  const playback = { ref: media, controls: true, tabIndex: 0, playsInline: true, preload: 'metadata', src: receipt?.url,
    'aria-label': `Saved export ${receipt?.name ?? ''}`, onLoadedMetadata: loaded, onError: failed }
  return html`<div class="modal-back"><section class="modal browser-export-preview" ref=${dialog} role="dialog" aria-modal="true" aria-labelledby="export-preview-title" tabIndex="-1" onKeyDown=${trap}>
    <header class="row gap"><h2 id="export-preview-title">Saved export preview</h2><span class="grow"></span><button type="button" class="ghost" onClick=${close}>Close preview</button></header>
    <div class="browser-export-preview-body">
    ${state.phase === 'loading' ? html`<p role="status">Opening the actual saved file...</p>` : null}
    ${state.error || error ? html`<p role="alert">${state.error || error}</p>` : null}
    ${receipt ? html`<p class="browser-export-name">${receipt.name}</p><p class="hint">${formatFileSize(receipt.bytes)} · ${receipt.bytes.toLocaleString()} bytes · ${receipt.preset} · Saved ${new Date(receipt.completed).toLocaleString()}</p>
      ${receipt.audioOnly ? h('audio', playback) : h('video', playback)}
      ${error ? null : details ? html`<p role="status">${Number.isFinite(details.duration) ? `${details.duration.toFixed(2)} seconds` : 'Duration unavailable'}${details.width ? ` · ${details.width}×${details.height}` : ''} · Use the player controls to inspect this file.</p>` : html`<p role="status">Reading playback metadata...</p>`}` : null}
    <p class="hint">This preview reads the saved output on your device. Previewing a file does not confirm that a separate download has finished saving.</p>
    </div>
  </section></div>`
}

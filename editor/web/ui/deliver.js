// Deliver page: export presets, render settings and the render queue.

import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { duration, timecode } from '/core/project.js'
import { api, set, store, toast, useStore, viewProject } from './store.js'
import { Viewer } from './viewer.js'
import { registry } from './registry.js'
import { host } from '../host.js'
import { DeliveryPreview } from './delivery-preview.js'
import { createDeliveryPreview } from '../browser-local/delivery-preview.js'
import { createDeliverRequest, deliverOutputName, deliverRangeMode } from './deliver-request.js'

const html = htm.bind(h)

const PRESETS = [
  { id: 'youtube', name: 'YouTube 1080p', preset: 'h264-high', shortEdge: 1080, note: 'H.264 High, CRF 17, AAC 320k, short edge 1080' },
  { id: '4k', name: '4K master', preset: 'h264-high', maxEdge: 3840, note: 'H.264 up to 3840×2160, landscape or portrait' },
  { id: 'web', name: 'Web / Vimeo', preset: 'h264-web', note: 'H.264, smaller file' },
  { id: 'fast', name: 'Fast H.264', preset: 'h264-fast', note: 'VideoToolbox hardware encode' },
  { id: 'hevc', name: 'HEVC (H.265)', preset: 'hevc', note: 'VideoToolbox HEVC, Apple-friendly' },
  { id: 'prores', name: 'ProRes 422', preset: 'prores-422', note: '10-bit mezzanine for finishing' },
  { id: 'proreshq', name: 'ProRes 422 HQ', preset: 'prores-422hq', note: 'high-bitrate master' },
  { id: 'prores4444', name: 'ProRes 4444', preset: 'prores-4444', note: 'with alpha' },
  { id: 'gif', name: 'GIF', preset: 'gif', width: 640, note: 'palette-optimized, 640 wide' },
  { id: 'wav', name: 'Audio WAV', preset: 'audio-wav', note: '24-bit mix' },
  { id: 'm4a', name: 'Audio AAC', preset: 'audio-m4a', note: '256k mix' },
  { id: 'png', name: 'PNG sequence', preset: 'png-seq', note: 'one PNG per frame' },
]

// The same limits as EXPORT_LIMITS in core/processing-export.js, so no offered size is one the export refuses.
const SIZE_LIMIT = { edge: 8192, pixels: 33554432 }
const SHORT_EDGES = [2160, 1440, 1080, 720, 540]
const even = value => Math.max(2, Math.round(value / 2) * 2)
// The project width made even without growing past it, so an odd project size is still one the export accepts.
const projectWidth = p => Math.max(2, Math.floor(p.width / 2) * 2)
const heightFor = (p, width) => Math.round((width * p.height) / p.width / 2) * 2
// The project's shape with its short edge at the given length. Both sides are even.
const shapedSize = (p, shortEdge) => {
  const longEdge = even((shortEdge * Math.max(p.width, p.height)) / Math.min(p.width, p.height))
  return p.width <= p.height ? { width: shortEdge, height: longEdge } : { width: longEdge, height: shortEdge }
}
// The size a preset starts at: its own short edge, its bounding box, its fixed width, or the project size.
const presetSize = (p, choice) => {
  if (choice.shortEdge) return shapedSize(p, choice.shortEdge)
  const width = choice.maxEdge
    ? Math.max(2, Math.floor(p.width * Math.min(3840 / Math.max(p.width, p.height), 2160 / Math.min(p.width, p.height)) / 2) * 2)
    : choice.width ?? projectWidth(p)
  return { width, height: heightFor(p, width) }
}
const presetAllows = (choice, size) => {
  const shortEdge = Math.min(size.width, size.height), longEdge = Math.max(size.width, size.height)
  if (longEdge > SIZE_LIMIT.edge || size.width * size.height > SIZE_LIMIT.pixels) return false
  if (choice.shortEdge) return shortEdge <= choice.shortEdge
  if (choice.maxEdge) return longEdge <= choice.maxEdge && shortEdge <= (choice.maxEdge * 9) / 16
  return choice.width ? size.width <= choice.width : true
}
// The largest size in the project's shape that the preset and the export both allow, for shapes no listed size fits.
const fittedSize = (p, choice) => {
  let width = even(p.width * Math.min(SIZE_LIMIT.edge / Math.max(p.width, p.height), Math.sqrt(SIZE_LIMIT.pixels / (p.width * p.height))))
  while (width > 2 && !presetAllows(choice, { width, height: heightFor(p, width) })) width -= 2
  return { width, height: heightFor(p, width) }
}
// Every size the Resolution menu offers, largest first: the preset's own size, the common short edges and the project size.
// Each one passes the same limits, so the menu never lists a size the export refuses.
const deliverSizes = (p, choice) => {
  const seen = new Set(), project = projectWidth(p)
  const sizes = [presetSize(p, choice), ...SHORT_EDGES.map(edge => shapedSize(p, edge)), { width: project, height: heightFor(p, project) }]
    .filter(size => presetAllows(choice, size))
    .filter(size => !seen.has(size.width) && seen.add(size.width))
    .sort((a, b) => b.width - a.width)
  return sizes.length ? sizes : [fittedSize(p, choice)]
}
// The size Render uses when none is chosen: the preset's own size when it is allowed, else the largest allowed.
const defaultSize = (p, choice, sizes) => sizes.find(size => size.width === presetSize(p, choice).width) ?? sizes[0]

// The tip card counts only exports started in this tab, even if Deliver closed before the reply.
// Retry re-sends exactly what this tab requested, including the composition, so it never renders something else.
const requestedSpecs = new Map()
const noteStartedExport = (job, spec) => {
  if (!job?.id) return
  requestedSpecs.set(job.id, spec)
  while (requestedSpecs.size > 20) requestedSpecs.delete(requestedSpecs.keys().next().value)
  set({ startedExports: [...(store.startedExports ?? []), job.id].slice(-20) })
}

const jobFile = job => (job?.output ?? job?.spec?.out ?? '').split('/').pop()
// Why a queued job has not started, in the words the queue shows.
function waitingText(job, jobs) {
  const reason = job.waiting?.reason
  if (reason === 'behind-job') {
    const ahead = jobFile(jobs.find(other => other.id === job.waiting.job))
    return ahead ? `Waiting for ${ahead} to finish` : 'Waiting for another render to finish'
  }
  return { 'behind-processing': 'Waiting for other processing', 'copying-sources': 'Copying media', 'worker-starting': 'Starting the render worker' }[reason] ?? ''
}
// One line under a job's bar. A failed job shows the server's own sentence, which is written for the person reading it.
function jobStatus(job, jobs) {
  if (job.state === 'done') return `done in ${((job.finished - job.created) / 1000).toFixed(1)}s`
  if (job.state === 'cancelled') return 'Cancelled'
  if (job.state === 'cancelling') return 'Cancelling…'
  if (job.state === 'committing') return 'Saving export…'
  if (job.state === 'failed') return job.error || 'The render could not finish. Try again.'
  // The server drops the reason when the worker takes the job, so a reason means it has not started.
  return ['queued', 'running'].includes(job.state) && waitingText(job, jobs) || `${Math.round((job.progress ?? 0) * 100)}%`
}

export function DeliverPage() {
  const s = useStore()
  useEffect(() => { set({ viewerMode: 'timeline' }) }, [])
  const composition = s.openComp ? s.project.comps?.[s.openComp] : null
  const p = composition ? { ...viewProject(), name: composition.name, range: composition.range ?? null } : s.project
  const [choice, setChoice] = useState(PRESETS[0])
  const [name, setName] = useState(p.name)
  const [width, setWidth] = useState(null)
  const [fps, setFps] = useState(null)
  useEffect(() => { setName(p.name); setWidth(null); setFps(null) }, [s.root, s.openComp])
  const [dismissed, setDismissed] = useState({ root: s.root, ids: [] })
  // The range choice lives in the store, so leaving Deliver or picking a preset keeps it.
  const rangeMode = deliverRangeMode(s.deliverRange, { root: s.root, comp: s.openComp, range: p.range })
  const setRangeMode = mode => set({ deliverRange: { root: s.root, comp: s.openComp ?? null, mode } })
  const sizes = deliverSizes(p, choice)
  const { width: outW, height: outH } = sizes.find(size => size.width === width) ?? defaultSize(p, choice, sizes)
  const range = rangeMode === 'range' && p.range ? p.range : { in: 0, out: duration(p) }
  const native = host.kind === 'native' || host.kind === 'browser-local'
  // In the Mac app's Web Editor the page encodes with WebCodecs, so offer only what that route renders.
  const offered = host.kind === 'native' && s.caps?.webPresets ? s.caps.webPresets : s.caps?.presets
  const presets = offered ? PRESETS.filter(pr => offered.includes(pr.preset)) : PRESETS
  useEffect(() => { if (presets.length && !presets.some(preset => preset.id === choice.id)) setChoice(presets[0]) }, [presets.map(preset => preset.id).join('|')])
  const [, refreshRequest] = useState(0)
  const request = useRef(null)
  if (!request.current) request.current = createDeliverRequest({
    getScope: () => ({ root: s.root, version: s.version, project: s.project, comp: s.openComp }),
    changed: () => refreshRequest(value => value + 1),
    started: () => toast('Render started'),
    start: async (spec, project, guard) => {
      if (host.kind === 'native' || host.kind === 'browser-local') {
        const { startNativeExport } = await import('../engine/export-webcodecs.js')
        guard.assertCurrent()
        const { job, completion } = await startNativeExport(project, spec)
        noteStartedExport(job, spec)
        completion.catch(error => { if (guard.isCurrent() && error.message !== 'cancelled') toast(error.message, 'error') })
      } else noteStartedExport(await api('/api/export', spec), spec)
    },
  })
  useEffect(() => () => request.current.dispose(), [])
  const renderRequest = request.current.state()
  const requestPending = ['pending', 'stale-pending'].includes(renderRequest.phase)

  const exportJobs = s.jobs.filter(job => job.kind === 'export' && !(dismissed.root === s.root && dismissed.ids.includes(job.id)))
  const dismiss = id => setDismissed(previous => ({ root: s.root, ids: [...(previous.root === s.root ? previous.ids : []), id] }))
  const retry = job => request.current.run(requestedSpecs.get(job.id), native ? s.project : null)
  const render = () => request.current.run({ preset: choice.preset, name, width: outW, height: outH, fps: fps ?? p.fps, range, ...(composition ? { comp: s.openComp } : {}) }, native ? s.project : null)
  const still = async () => {
    try {
      // In the App Store app a free still that is too large shrinks to the 1080p fit instead of failing.
      const options = { at: window.reel.player.t, width: outW, freeFit: true, ...(composition ? { comp: s.openComp } : {}) }
      const r = native ? await (await import('../engine/export-webcodecs.js')).saveNativeFrame(s.project, options) : await api('/api/frame', options)
      toast(r.fitted ? `Saved ${r.path} at ${r.width} pixels wide. Arya Pro saves full size.` : `Saved ${r.path}`)
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  const choosePreset = preset => { setChoice(preset); setWidth(null) }
  const presetDetail = preset => {
    if (!native) return preset.note
    if (preset.preset === 'audio-wav') return '16-bit stereo mix'
    return preset.preset.startsWith('audio') ? 'AAC stereo mix' : 'WebCodecs encode with AAC stereo'
  }

  return html`
    <div class="page deliver">
      <div class="panel deliver-settings">
        <h3>Render settings</h3>
        ${composition ? html`<div class="hint">Exporting composition: <b>${composition.name}</b></div>` : null}
        <label class="deliver-preset-picker">
          <span>Preset</span>
          <select value=${choice.id} onChange=${event => {
            const preset = presets.find(item => item.id === event.target.value)
            if (preset) choosePreset(preset)
          }}>${presets.map(preset => html`<option value=${preset.id}>${preset.name}</option>`)}</select>
          <small class="muted">${presetDetail(choice)}</small>
        </label>
        <div class="preset-list">
          ${presets.map(pr => {
            const detail = presetDetail(pr)
            return html`<button type="button" class=${`deliver-preset ${choice.id === pr.id ? 'on' : ''}`} aria-pressed=${choice.id === pr.id} title=${`${pr.name}: ${detail}`} onClick=${() => choosePreset(pr)}><b>${pr.name}</b><span class="muted">${detail}</span></button>`
          })}
        </div>
        <div class="field"><label>File name</label><input value=${name} onInput=${e => setName(e.target.value)} onKeyDown=${e => e.stopPropagation()} /></div>
        ${!choice.preset.startsWith('audio') ? html`
          <div class="field"><label>Resolution</label><select value=${outW} onChange=${e => setWidth(Number(e.target.value))}>
            ${sizes.map(size => html`<option value=${size.width}>${size.width}×${size.height}</option>`)}
          </select></div>
          <div class="field"><label>Frame rate</label><select value=${fps ?? p.fps} onChange=${e => setFps(Number(e.target.value))}>${[p.fps, 24, 25, 30, 50, 60].filter((v, i, a) => a.indexOf(v) === i).map(f => html`<option value=${f}>${f}</option>`)}</select></div>` : null}
        <div class="field"><label>Range</label><div class="seg">
          <button class=${rangeMode === 'all' ? 'on' : ''} onClick=${() => setRangeMode('all')}>Entire timeline</button>
          <button class=${rangeMode === 'range' ? 'on' : ''} disabled=${!p.range} onClick=${() => setRangeMode('range')}>In → Out</button>
        </div></div>
        <div class="kv"><span>Length</span><b>${timecode(range.out - range.in, p.fps)}</b></div>
        <div class="kv"><span>Output</span><b>renders/${deliverOutputName(name, host.kind)}.${choice.preset.startsWith('prores') ? 'mov' : choice.preset === 'gif' ? 'gif' : choice.preset === 'audio-wav' ? 'wav' : choice.preset === 'audio-m4a' ? 'm4a' : choice.preset === 'png-seq' ? 'png…' : 'mp4'}</b></div>
        ${/* Pinned under the settings: what will render, then the one primary action. */ null}
        <div class="deliver-actions"><span class="muted small deliver-range-note">${rangeMode === 'range' ? 'In → Out' : 'Entire timeline'} · ${timecode(range.in, p.fps)} to ${timecode(range.out, p.fps)}</span><button class="primary deliver-render" disabled=${requestPending} aria-busy=${requestPending} onClick=${render}><svg class="ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="M10 9.2v5.6l4.8-2.8z" fill="currentColor" stroke="none" /></svg>${renderRequest.phase === 'stale-pending' ? 'Waiting for previous request…' : renderRequest.phase === 'pending' ? 'Preparing render…' : renderRequest.phase === 'failed' ? 'Retry render' : 'Render'}</button></div>
        ${renderRequest.phase === 'failed' ? html`<div class="hint" role="alert">Render could not start: ${renderRequest.error} Retry when you’re ready.</div>` : null}
        ${host.kind === 'browser-local' && (range.out - range.in <= 0 || range.out - range.in > 300) ? html`<div class="hint" role="note">${range.out - range.in <= 0 ? 'Add media or mark a non-empty In → Out range before rendering.' : 'This range is longer than the five-minute hosted beta export limit. Mark a shorter In → Out range.'}</div>` : null}
        <div class="hint">${host.kind === 'browser-local' ? 'Your browser renders the GPU compositor and audio mix, then saves the completed file on this device. Use Download in Saved exports. Keep this tab open during rendering. The hosted beta supports exports up to five minutes. Available presets depend on the browser codecs.' : native ? 'Renders use the viewer compositor and audio mixer. WebCodecs encodes the file and Arya saves it in your project. For ProRes, GIF or PNG sequences, turn off View > Web Editor and render from the Deliver page.' : 'Renders use the same compositor as the viewer, in a background browser, encoded by ffmpeg.'}</div>
        ${registry.deliver.length ? html`<h3>Interchange</h3><div class="row gap wrap">${registry.deliver.map(a => html`<button class="ghost" onClick=${() => a.run(p)}>${a.label}</button>`)}</div>` : null}
      </div>
      <div class="deliver-center"><div class="deliver-viewer-tools"><button class="ghost tiny" disabled=${host.kind === 'browser-local'} title=${host.kind === 'browser-local' ? 'Still-frame saving is not yet available in the hosted beta.' : undefined} onClick=${still}><svg class="ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="7" width="17" height="12" rx="2" /><path d="M8.5 7l1.2-2.2h4.6L15.5 7" /><circle cx="12" cy="13" r="3" /></svg>Save still frame</button></div><${Viewer} compact=${true} /></div>
      <div class="panel deliver-queue">
        <h3>Render queue</h3>
        ${requestPending ? html`<div class="hint" role="status" aria-live="polite">${renderRequest.phase === 'stale-pending' ? 'A render request for the previous timeline is still waiting for confirmation. Wait for confirmation before starting another.' : 'Preparing the render. Waiting for confirmation.'}</div>` : null}
        ${!requestPending && exportJobs.length === 0 ? html`<div class="empty-hint">The queue is empty. Select Render to add a job.</div>` : null}
        ${[...exportJobs].reverse().map(j => html`
          <div class=${`job ${j.state}`}>
            <div class="job-name"><b>${jobFile(j)}</b><span class="muted">${j.spec?.preset} · ${j.spec?.width}×${j.spec?.height}</span></div>
            <div class="bar"><div style=${{ width: `${Math.round((j.progress ?? 0) * 100)}%` }}></div></div>
            <div class="row gap">
              <span class="muted small">${jobStatus(j, s.jobs)}</span>
              <span class="grow"></span>
              ${j.state === 'running' || j.state === 'queued' ? html`<button class="ghost tiny" onClick=${() => api('/api/jobs/cancel', { id: j.id }).catch(error => toast(error.message, 'error'))}>Cancel</button>` : null}
              ${j.state === 'failed' || j.state === 'cancelled' ? html`${requestedSpecs.has(j.id) ? html`<button class="ghost tiny" disabled=${requestPending} onClick=${() => retry(j)}>Retry</button>` : null}<button class="ghost tiny" onClick=${() => dismiss(j.id)}>Dismiss</button>` : null}
              ${j.deliveryWarning ? html`<span class="hint">${j.deliveryWarning}</span>` : null}
            </div>
          </div>`)}
        <${DeliveryHistoryView} key=${s.root} root=${s.root} jobs=${s.jobs} connected=${s.connected} />
      </div>
    </div>
  `
}


function DeliveryHistoryView({ root, jobs, connected }) {
  const [history, setHistory] = useState(null)
  const [error, setError] = useState('')
  const request = useRef(0), preview = useRef(null)
  const [previewState, setPreviewState] = useState({ phase: 'idle' })
  if (!preview.current && host.kind === 'browser-local') preview.current = createDeliveryPreview({
    getRoot: () => store.root, changed: setPreviewState,
    open: (id, root) => host.request('/api/deliveries/access', { id, root, action: 'preview' }),
    release: id => host.browser.releaseDeliveryPreview(id),
  })
  useEffect(() => () => preview.current?.dispose(), [])
  const completed = jobs.filter(j => j.kind === 'export' && ['done', 'failed'].includes(j.state)).map(j => `${j.id}:${j.state}:${j.finished}`).join('|')
  const refresh = async () => {
    const token = ++request.current
    try {
      const value = await host.request('/api/deliveries')
      if (token !== request.current) return
      if (value.root !== root) throw new Error('The project changed. Reopen Deliver to refresh its files.')
      setHistory(value); setError('')
    } catch (error) { if (token === request.current) { setHistory(null); setError(error.message) } }
  }
  useEffect(() => { refresh(); return () => { request.current++ } }, [root, completed, connected])
  const access = async (row, action) => {
    if (action === 'preview' && preview.current) return preview.current.show(row.id, history.root)
    try {
      if (action === 'share') await host.shareDelivery(row.id, history.root)
      else await host.request('/api/deliveries/access', { id: row.id, root: history.root, action })
    } catch (error) { toast(error.message, 'error') }
    await refresh()
  }
  return html`${previewState.phase !== 'idle' ? html`<${DeliveryPreview} state=${previewState} close=${() => preview.current.close()} />` : null}<h3>Saved exports</h3><button class="ghost tiny" onClick=${refresh}>Refresh files</button>
    ${error ? html`<div class="hint">${error}</div>` : null}
    ${history?.warnings?.map(warning => html`<div class="hint">${warning}</div>`)}
    ${history && !history.deliveries.length ? html`<div class="empty-hint">No saved exports found in this project.</div>` : null}
    ${history?.deliveries.map(row => html`<div class="job">
      <div class="job-name"><b>${row.output}</b></div>
      <div class="muted small">${row.provenance === 'completed' ? `Completed export${row.preset ? ` · ${row.preset}` : ''}` : 'Existing output · completion not recorded'}${row.sequence ? ' · frame sequence' : ''}</div>
      ${!row.available ? html`<div class="hint">${row.problem}</div>` : null}
      <div class="row gap wrap">${(history.actions ?? []).map(action => html`<button class="ghost tiny" disabled=${!row.available} onClick=${() => access(row, action)}>${action === 'preview' ? 'Preview saved file' : action === 'download' ? 'Download' : action === 'share' ? 'Share export' : action === 'open' ? 'Open' : 'Show in Finder'}</button>`)}</div>
    </div>`)}`
}

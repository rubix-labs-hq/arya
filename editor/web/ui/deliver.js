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
import { createDeliverRequest } from './deliver-request.js'

const html = htm.bind(h)

const PRESETS = [
  { id: 'youtube', name: 'YouTube 1080p', preset: 'h264-high', scale: 1, note: 'H.264 High, CRF 17, AAC 320k' },
  { id: '4k', name: '4K master', preset: 'h264-high', width: 3840, note: 'H.264 at 3840 wide' },
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

export function DeliverPage() {
  const s = useStore()
  useEffect(() => { set({ viewerMode: 'timeline' }) }, [])
  const composition = s.openComp ? s.project.comps?.[s.openComp] : null
  const p = composition ? { ...viewProject(), name: composition.name, range: composition.range ?? null } : s.project
  const [choice, setChoice] = useState(PRESETS[0])
  const [name, setName] = useState(p.name)
  const [rangeMode, setRangeMode] = useState(p.range ? 'range' : 'all')
  const [width, setWidth] = useState(null)
  const [fps, setFps] = useState(null)
  const outW = width ?? choice.width ?? p.width
  const outH = Math.round((outW * p.height) / p.width / 2) * 2
  const range = rangeMode === 'range' && p.range ? p.range : { in: 0, out: duration(p) }
  const native = host.kind === 'native' || host.kind === 'browser-local'
  const presets = s.caps?.presets ? PRESETS.filter(pr => s.caps.presets.includes(pr.preset)) : PRESETS
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
        const { completion } = await startNativeExport(project, spec)
        completion.catch(error => { if (guard.isCurrent() && error.message !== 'cancelled') toast(error.message, 'error') })
      } else await api('/api/export', spec)
    },
  })
  useEffect(() => () => request.current.dispose(), [])
  const renderRequest = request.current.state()
  const requestPending = ['pending', 'stale-pending'].includes(renderRequest.phase)

  const render = () => request.current.run({ preset: choice.preset, name, width: outW, height: outH, fps: fps ?? p.fps, range, ...(composition ? { comp: s.openComp } : {}) }, native ? s.project : null)
  const still = async () => {
    try {
      const options = { at: window.reel.player.t, width: p.width, ...(composition ? { comp: s.openComp } : {}) }
      const r = native ? await (await import('../engine/export-webcodecs.js')).saveNativeFrame(s.project, options) : await api('/api/frame', options)
      toast(`Saved ${r.path}`)
    } catch (error) {
      toast(error.message, 'error')
    }
  }

  return html`
    <div class="page deliver">
      <div class="panel deliver-settings">
        <h3>Render settings</h3>
        ${composition ? html`<div class="hint">Exporting composition: <b>${composition.name}</b></div>` : null}
        <div class="preset-list">
          ${presets.map(pr => {
            const detail = native ? pr.preset === 'audio-wav' ? '16-bit stereo mix' : pr.preset.startsWith('audio') ? 'AAC stereo mix' : 'WebCodecs encode with AAC stereo' : pr.note
            return html`<button type="button" class=${`deliver-preset ${choice.id === pr.id ? 'on' : ''}`} aria-pressed=${choice.id === pr.id} title=${`${pr.name}: ${detail}`} onClick=${() => (setChoice(pr), setWidth(null))}><b>${pr.name}</b><span class="muted">${detail}</span></button>`
          })}
        </div>
        <div class="field"><label>File name</label><input value=${name} onInput=${e => setName(e.target.value)} onKeyDown=${e => e.stopPropagation()} /></div>
        ${!choice.preset.startsWith('audio') ? html`
          <div class="field"><label>Resolution</label><select value=${outW} onChange=${e => setWidth(Number(e.target.value))}>
            ${[...new Set([p.width, 3840, 2560, 1920, 1280, 960, 640].filter(w => w <= Math.max(3840, p.width)))].map(w => html`<option value=${w}>${w}×${Math.round((w * p.height) / p.width / 2) * 2}</option>`)}
          </select></div>
          <div class="field"><label>Frame rate</label><select value=${fps ?? p.fps} onChange=${e => setFps(Number(e.target.value))}>${[p.fps, 24, 25, 30, 50, 60].filter((v, i, a) => a.indexOf(v) === i).map(f => html`<option value=${f}>${f}</option>`)}</select></div>` : null}
        <div class="field"><label>Range</label><div class="seg">
          <button class=${rangeMode === 'all' ? 'on' : ''} onClick=${() => setRangeMode('all')}>Entire timeline</button>
          <button class=${rangeMode === 'range' ? 'on' : ''} disabled=${!p.range} onClick=${() => setRangeMode('range')}>In → Out</button>
        </div></div>
        <div class="kv"><span>Length</span><b>${timecode(range.out - range.in, p.fps)}</b></div>
        <div class="kv"><span>Output</span><b>renders/${name.replace(/[^\w.-]+/g, '-')}.${choice.preset.startsWith('prores') ? 'mov' : choice.preset === 'gif' ? 'gif' : choice.preset === 'audio-wav' ? 'wav' : choice.preset === 'audio-m4a' ? 'm4a' : choice.preset === 'png-seq' ? 'png…' : 'mp4'}</b></div>
        <div class="row gap deliver-actions"><button class="primary" disabled=${requestPending} aria-busy=${requestPending} onClick=${render}>${renderRequest.phase === 'stale-pending' ? 'Waiting for previous request…' : renderRequest.phase === 'pending' ? 'Preparing render…' : renderRequest.phase === 'failed' ? 'Retry render' : '⇪ Render'}</button><button class="ghost" disabled=${host.kind === 'browser-local'} title=${host.kind === 'browser-local' ? 'Still-frame saving is not yet available in the hosted beta.' : undefined} onClick=${still}>Save still frame</button></div>
        ${renderRequest.phase === 'failed' ? html`<div class="hint" role="alert">Render could not start: ${renderRequest.error} Retry when you’re ready.</div>` : null}
        <div class="hint">${host.kind === 'browser-local' ? 'Your browser renders the GPU compositor and audio mix, then saves the completed file on this device. Use Download in Saved exports. Keep this tab open during rendering. The hosted beta supports exports up to five minutes. Available presets depend on the browser codecs.' : native ? 'Renders use the viewer compositor and audio mixer. WebCodecs encodes the file and Arya saves it in your project. ProRes, GIF and PNG sequences are available in the browser editor.' : 'Renders use the same compositor as the viewer, in a background browser, encoded by ffmpeg.'}</div>
        ${registry.deliver.length ? html`<h3>Interchange</h3><div class="row gap wrap">${registry.deliver.map(a => html`<button class="ghost" onClick=${() => a.run(p)}>${a.label}</button>`)}</div>` : null}
      </div>
      <div class="deliver-center"><${Viewer} compact=${true} /></div>
      <div class="panel deliver-queue">
        <h3>Render queue</h3>
        ${requestPending ? html`<div class="hint" role="status" aria-live="polite">${renderRequest.phase === 'stale-pending' ? 'A render request for the previous timeline is still waiting for confirmation. Wait for confirmation before starting another.' : 'Preparing the render. Waiting for confirmation.'}</div>` : null}
        ${!requestPending && s.jobs.filter(j => j.kind === 'export').length === 0 ? html`<div class="empty-hint">Nothing rendered yet. Choose a preset, then press Render.</div>` : null}
        ${[...s.jobs].filter(j => j.kind === 'export').reverse().map(j => html`
          <div class=${`job ${j.state}`}>
            <div class="job-name"><b>${(j.output ?? j.spec?.out ?? '').split('/').pop()}</b><span class="muted">${j.spec?.preset} · ${j.spec?.width}×${j.spec?.height}</span></div>
            <div class="bar"><div style=${{ width: `${Math.round((j.progress ?? 0) * 100)}%` }}></div></div>
            <div class="row gap">
              <span class="muted small">${j.state === 'done' ? `done in ${((j.finished - j.created) / 1000).toFixed(1)}s` : j.state === 'failed' ? j.error : `${Math.round((j.progress ?? 0) * 100)}%`}</span>
              <span class="grow"></span>
              ${j.state === 'running' || j.state === 'queued' ? html`<button class="ghost tiny" onClick=${() => api('/api/jobs/cancel', { id: j.id })}>Cancel</button>` : null}
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

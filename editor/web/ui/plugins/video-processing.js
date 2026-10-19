import { h } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import htm from 'htm'
import { host } from '../../host.js'
import { player } from '../engine-host.js'
import { registerClipMenu, registerInspector } from '../registry.js'
import { revealInspector } from '../layout.js'
import { api, edit, set, store, toast, useStore, viewProject } from '../store.js'
import { captureMatches, createProcessingRuns, processingBody, processingCapture, denoiseSource, restoreDenoiseOps, sourceKey, trackedReframe } from '../processing-workflows.js'

const html = htm.bind(h)
const actions = createProcessingRuns({ api, edit, notify: toast, current: () => ({ s: store, p: viewProject() }), changed: () => set(s => ({ processingTick: (s.processingTick ?? 0) + 1 })) })

export function VideoProcessing({ clip }) {
  const s = useStore()
  const [caps, setCaps] = useState(null)
  const [quality, setQuality] = useState('balanced')
  const [strength, setStrength] = useState(0.65)
  const [spatial, setSpatial] = useState(0.5)
  const [temporal, setTemporal] = useState(0.8)
  const [detail, setDetail] = useState(0.7)
  const [sigma, setSigma] = useState(0.06)
  const [smooth, setSmooth] = useState(0.5)
  const savedSettings = clip.noiseReduction?.settings
  useEffect(() => {
    const settings = savedSettings ?? {}
    setQuality(['fast', 'balanced', 'high'].includes(settings.quality) ? settings.quality : 'balanced')
    for (const [name, update, fallback] of [['strength', setStrength, 0.65], ['spatial', setSpatial, 0.5], ['temporal', setTemporal, 0.8], ['detail', setDetail, 0.7], ['sigma', setSigma, 0.06]]) {
      const value = settings[name], minimum = name === 'sigma' ? 0.002 : 0, maximum = name === 'sigma' ? 0.25 : 1
      update(Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback)
    }
  }, [s.root, s.openComp, clip.id, JSON.stringify(savedSettings)])
  useEffect(() => {
    let active = true
    setCaps(null)
    if (host.kind === 'native') setCaps(s.caps.processing ?? {})
    else api('/api/video/caps').then(value => { if (active) setCaps(value) }).catch(error => { if (active) setCaps({ videoDenoise: false, reason: error.message }) })
    return () => { active = false }
  }, [s.root, s.caps])
  let capture, issue = ''
  try { capture = processingCapture(s, viewProject(), clip) } catch (error) { issue = error.message }
  let original, originalIssue = ''
  if (capture) { try { original = denoiseSource(capture) } catch (error) { originalIssue = error.message } }
  const denoise = capture && actions.runs.get(actions.key(capture, 'denoise'))
  const reframe = capture && actions.runs.get(actions.key(capture, 'reframe'))
  const run = (kind, path, options, extra) => {
    try { actions.start(capture, kind, path, processingBody(capture, options), extra) } catch (error) { toast(error.message, 'error') }
  }
  const draw = () => {
    try {
      if (!captureMatches(capture, store, viewProject())) throw new Error('Choose the clip again before drawing the subject.')
      set({ trk: { clipId: capture.id, mode: 'point', boxes: [], k0: null, results: {}, busy: null, lostAt: null, next: 0, reframeSourceKey: sourceKey(capture) }, tool: 'track', inspectorTab: 'tracking', viewerMode: 'timeline' })
      player.seek(clip.start)
    } catch (error) { toast(error.message, 'error') }
  }
  const applyTrack = async () => {
    try {
      if (!captureMatches(capture, store, viewProject())) throw new Error('Choose the clip again before applying the track.')
      const response = await edit(trackedReframe(capture, store.trk, smooth), 'Reframed tracked subject', { expectedVersion: capture.version })
      if (response) toast('Reframed tracked subject. Undo restores the previous framing.')
    } catch (error) { toast(error.message, 'error') }
  }
  const restoreOriginal = async () => {
    try {
      if (!captureMatches(capture, store, viewProject())) throw new Error('Choose the clip again before restoring its source.')
      const response = await edit(restoreDenoiseOps(capture), 'Restored source before video denoise', { expectedVersion: capture.version })
      if (response) toast('Restored the original source. Undo restores the denoised copy.')
    } catch (error) { toast(error.message, 'error') }
  }
  const slider = (label, value, update, min = 0, max = 1, step = 0.01) => html`<div class="field"><label>${label}</label><input aria-label=${label} type="range" min=${min} max=${max} step=${step} value=${value} onInput=${e => update(Number(e.target.value))} /><span class="dim">${value.toFixed(2)}</span></div>`
  const status = job => job ? html`<div class="row gap wrap"><span role="status">${job.state === 'running' ? `Processing${job.progress !== undefined ? ` ${Math.round(job.progress * 100)}%` : ''}` : job.error ?? job.state}</span>${job.state === 'running' ? html`<button class="ghost danger" onClick=${() => actions.cancel(job).catch(error => toast(error.message, 'error'))}>${job.cancelRequested ? 'Cancel requested' : 'Cancel'}</button>` : null}</div>` : null
  const nativeReframe = s.caps.analysis?.autoReframe === true
  return html`<div class="section-body">
    ${issue ? html`<p role="status">${issue}</p>` : null}
    <h4>Denoise video</h4>
    <p class="dim">Save a processed copy and replace this clip's source range. The original file remains available and Undo restores it.</p>
    <p class="dim">${host.kind === 'native' ? 'Uses the native video processor with automatic HDR and alpha codec preservation.' : 'Uses local ffmpeg on 8-bit SDR video. HDR, alpha and high bit-depth sources require the native processor.'}</p>
    <div class="field"><label>Quality</label><select aria-label="Denoise quality" value=${quality} onChange=${e => setQuality(e.target.value)}>${['fast', 'balanced', 'high'].map(value => html`<option value=${value}>${value}</option>`)}</select></div>
    ${slider('Strength', strength, setStrength)}${slider('Spatial reduction', spatial, setSpatial)}${slider('Temporal reduction', temporal, setTemporal)}${slider('Preserve detail', detail, setDetail)}${slider('Noise sigma', sigma, setSigma, 0.002, 0.25, 0.002)}
    ${host.kind === 'native' && quality === 'fast' ? html`<p class="dim">Fast quality uses spatial reduction only. Balanced and high quality also use temporal neighbors.</p>` : null}
    ${original ? html`<p class="dim">${host.kind === 'native' ? 'Restore the saved source before rendering revised settings in the native host.' : 'Revised settings render from the saved original source.'} Restore source removes this denoise pass.</p><button class="ghost" disabled=${denoise?.state === 'running'} onClick=${restoreOriginal}>Restore source before denoise</button>` : null}
    ${originalIssue ? html`<p role="status">${originalIssue}</p>` : null}
    <button disabled=${!capture || caps?.videoDenoise !== true || !!originalIssue || host.kind === 'native' && !!original || denoise?.state === 'running'} onClick=${() => run('denoise', '/api/video/denoise', { quality, strength, spatial, temporal, detail, sigma, codec: 'auto', apply: true, useOriginal: host.kind !== 'native' && !!original }, { jobPrefix: host.kind === 'native' ? '/api/analysis/jobs' : '/api/video/jobs' })}>Denoise selected clip</button>
    ${caps?.reason ? html`<p role="status">${caps.reason}</p>` : caps === null ? html`<p class="dim">Checking video processor…</p>` : null}
    ${status(denoise)}
    <h4>Reframe subject</h4>
    <p class="dim">Uses the current composition dimensions. Replaces position and scale animation with an editable subject path and cover fit. Undo restores the previous framing.</p>
    ${nativeReframe ? html`<button disabled=${!capture || reframe?.state === 'running'} onClick=${() => run('reframe', '/api/analysis/autoreframe', { width: capture.width, height: capture.height, fps: 2, apply: false }, { applyReframe: true })}>Detect subject and reframe</button>` : html`<p class="dim">Draw a box on a textured subject, track forward from the first frame through the last in Track, then return here to apply the path.</p>`}
    ${status(reframe)}
    <button class="ghost" disabled=${!capture} onClick=${draw}>Draw subject for local tracking</button>
    ${slider('Reframe smoothing', smooth, setSmooth, 0, 2, 0.05)}
    <button disabled=${!capture || !s.trk || s.trk.busy} onClick=${applyTrack}>Reframe tracked subject</button>
  </div>`
}

registerInspector({ id: 'processing', label: 'Process', order: 63, when: c => c.kind === 'video' && c.src, component: VideoProcessing })
registerClipMenu((_p, { clip }) => clip.kind === 'video' && clip.src ? [{ label: 'Denoise or reframe…', run: () => { revealInspector(); set({ page: 'edit', selection: [clip.id], inspectorTab: 'processing', viewerMode: 'timeline', source: null }) } }] : [])

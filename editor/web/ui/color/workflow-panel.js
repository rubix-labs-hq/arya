import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { host } from '../../host.js'
import { api, set, store, time, useStore } from '../store.js'
import { gradedClip, selectedNode } from './state.js'
import { createColorWorkflows, lutTarget } from './workflows.js'

const html = htm.bind(h)
export function LUTWorkflowPanel({ clip, node }) {
  const state = useStore(), caps = state.caps?.color ?? {}
  const [panel, setPanel] = useState({ busy: false, inspected: null, error: '', notice: '' })
  const [luts, setLuts] = useState([]), [path, setPath] = useState('')
  const [reference, setReference] = useState(null), [name, setName] = useState('Reference look')
  const [strength, setStrength] = useState(0.75), [mix, setMix] = useState(1), [space, setSpace] = useState('srgb')
  const workflow = useRef(null)
  if (!workflow.current) workflow.current = createColorWorkflows({
    getState: () => { const current = gradedClip(); return { ...store, clip: current, node: selectedNode(current), at: time.t } },
    request: api, upload: file => host.upload(file), commit: set, onState: setPanel,
    download: ({ name, text }) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = name
      document.body.appendChild(anchor); anchor.click(); anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    },
  })
  useEffect(() => () => workflow.current.dispose(), [])
  useEffect(() => { let active = true; api('/api/luts').then(r => { if (active && Array.isArray(r?.luts)) setLuts(r.luts) }).catch(() => {}); return () => { active = false } }, [panel.inspected?.path, state.root])
  const attempt = task => task.catch(() => {})
  const target = lutTarget(clip, node)
  return html`<div class="node-panel" aria-label="LUT and reference tools">
    <div class="hint">Target: ${target ? `${clip.id} · ${target.kind === 'clipGrade' ? 'primary grade' : node.id}` : 'Choose a primary, corrector or LUT node on a visual clip.'}</div>
    <div class="field"><label>Import CUBE</label><input type="file" accept=".cube" disabled=${panel.busy || caps.cubeImport !== true} onChange=${e => { const file = e.target.files?.[0]; e.target.value = ''; if (file) attempt(workflow.current.importCube(file)) }} /></div>
    ${caps.cubeImport !== true ? html`<div class="hint">This backend does not support CUBE import.</div>` : null}
    <div class="field"><label>Project LUT</label><select value=${path} disabled=${panel.busy} onChange=${e => setPath(e.target.value)}><option value="">Choose a LUT</option>${luts.map(lut => html`<option value=${lut}>${lut}</option>`)}</select><button disabled=${panel.busy || !path || caps.lutInspect !== true} onClick=${() => attempt(workflow.current.inspect(path))}>Inspect</button></div>
    <div class="field"><label>Reference image</label><input type="file" accept="image/png,image/jpeg,image/webp" disabled=${panel.busy || caps.referenceMatch !== true} onChange=${e => { setReference(e.target.files?.[0] ?? null) }} /></div>
    <div class="field"><label>Look name</label><input value=${name} disabled=${panel.busy} onInput=${e => setName(e.target.value)} /></div>
    <div class="field"><label>Match strength</label><input type="range" min="0" max="1" step="0.01" value=${strength} disabled=${panel.busy} onInput=${e => setStrength(Number(e.target.value))} /><span>${Math.round(strength * 100)}%</span></div>
    <div class="row gap wrap"><button disabled=${panel.busy || !reference || !target || caps.referenceMatch !== true} onClick=${() => attempt(workflow.current.match(reference, { name, strength }))}>Create reference LUT</button>${panel.busy && panel.phase !== 'applying' ? html`<button onClick=${() => workflow.current.cancel()}>Stop waiting</button>` : null}</div>
    <div class="hint">${caps.referenceMatch === true ? `Match the displayed composition at the current frame with ${caps.referenceEngine ?? 'the local renderer'}. Matching transfers overall RGB color and contrast; review the result on the scopes.` : 'Reference matching is unavailable on this backend. Standalone matching requires local Chrome and ffmpeg.'}</div>
    ${panel.inspected ? html`<div class="hint">${panel.inspected.path} · ${panel.inspected.size}³ · domain ${panel.inspected.domainMin.join(', ')} → ${panel.inspected.domainMax.join(', ')}<br />SHA256: ${panel.inspected.sourceHash}</div>` : null}
    ${panel.inspected?.measurements?.source?.mean ? html`<div class="hint">RGB mean: ${panel.inspected.measurements.source.mean.map(x => x.toFixed(3)).join(', ')} → ${panel.inspected.measurements.reference.mean.map(x => x.toFixed(3)).join(', ')}</div>` : null}
    ${(panel.inspected?.warnings ?? []).map(warning => html`<div class="hint">${warning}</div>`)}
    <div class="field"><label>LUT mix</label><input type="range" min="0" max="1" step="0.01" value=${mix} disabled=${panel.busy} onInput=${e => setMix(Number(e.target.value))} /><span>${Math.round(mix * 100)}%</span></div>
    <div class="field"><label>LUT space</label><select value=${space} disabled=${panel.busy} onChange=${e => setSpace(e.target.value)}><option value="srgb">Display RGB (sRGB)</option><option value="working">Project working space</option></select></div>
    <button disabled=${panel.busy || !panel.inspected || !target || caps.lutApply !== true} onClick=${() => attempt(workflow.current.apply({ mix, space }))}>Apply inspected LUT</button>
    ${host.kind === 'native' ? html`<div class="hint">Export inspected LUTs from the native Color controls.</div>` : html`<button disabled=${panel.busy || !panel.inspected || caps.lutExport !== true} onClick=${() => attempt(workflow.current.exportCube())}>Export inspected LUT</button>`}
    ${panel.notice ? html`<div role="status" class="hint">${panel.notice}</div>` : null}${panel.error ? html`<div role="alert" class="warn">${panel.error}</div>` : null}
  </div>`
}

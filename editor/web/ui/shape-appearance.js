import { h } from 'preact'
import { useRef } from 'preact/hooks'
import htm from 'htm'
import { edit, store, toast, viewProject } from './store.js'

const html = htm.bind(h)
const signature = value => JSON.stringify(value)
const colorPattern = /^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i
export function shapeColor(value) {
  if (typeof value !== 'string' || !colorPattern.test(value)) throw new Error('Use a hex color such as #d95d18 or #d95d18ff.')
  const hex = value.slice(1).toLowerCase()
  return '#' + (hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex)
}
export function shapePickerColor(value, fallback) {
  if (typeof value !== 'string' || !colorPattern.test(value)) return fallback
  const hex = value.slice(1)
  return '#' + (hex.length <= 4 ? [...hex.slice(0, 3)].map(c => c + c).join('') : hex.slice(0, 6))
}
export function captureShapeAppearance(s, view, clip) {
  if (!clip?.id || !s.project || !Number.isSafeInteger(s.version) || s.version < 0 || !s.selection?.length || s.selection[0] !== clip.id) throw new Error('Select the shape again before changing its appearance.')
  const targets = s.selection.map(id => {
    const matches = (view?.tracks?.flatMap(track => track.clips.map(clip => ({ track, clip }))) ?? []).filter(hit => hit.clip.id === id)
    if (matches.length !== 1 || matches[0].clip.kind !== 'shape' || matches[0].track.locked) throw new Error('Select only uniquely identified shapes on unlocked tracks.')
    const found = matches[0]
    return { id, clip: structuredClone(found.clip), track: signature({ ...found.track, clips: undefined }) }
  })
  if (new Set(s.selection).size !== s.selection.length) throw new Error('Select each shape only once.')
  return { root: s.root, version: s.version, project: s.project, scope: s.openComp ?? null, selection: [...s.selection], targets }
}
export function shapeAppearanceMatches(capture, s, view) {
  if (!capture || s.root !== capture.root || s.project !== capture.project || s.version !== capture.version || (s.openComp ?? null) !== capture.scope || signature(s.selection) !== signature(capture.selection)) return false
  try {
    const now = captureShapeAppearance(s, view, capture.targets[0].clip)
    return signature(now.targets) === signature(capture.targets)
  } catch { return false }
}
export function shapeAppearanceOps(capture, action, value) {
  if (!capture?.targets?.length) throw new Error('Select a shape first.')
  if (action === 'fillColor' || action === 'strokeColor') value = shapeColor(value)
  else if (action === 'strokeWidth') {
    if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Stroke width must be from 0 to 100 pixels.')
  } else if (!['fillEnabled', 'strokeEnabled'].includes(action) || typeof value !== 'boolean') throw new Error('Choose a supported shape appearance setting.')
  return capture.targets.map(target => {
    const shape = target.clip.shape ?? {}
    let patch
    if (action === 'fillColor' || action === 'strokeColor') {
      const field = action === 'fillColor' ? 'fill' : 'stroke'
      patch = { [field]: { color: value, ...(shape[field] && Object.hasOwn(shape[field], 'gradient') ? { gradient: null } : {}) } }
    }
    else if (action === 'fillEnabled') patch = { fill: value ? structuredClone(shape.fill ?? { color: '#f5b942' }) : null }
    else if (action === 'strokeEnabled') patch = { stroke: value ? { width: shape.stroke?.width > 0 ? shape.stroke.width : 3, ...(!shape.stroke ? { color: '#ffffff' } : {}) } : { width: 0 } }
    else patch = { stroke: { width: value } }
    return { op: 'update', id: target.id, comp: capture.scope, set: { shape: patch } }
  })
}
export function ShapeAppearance({ clip }) {
  const gesture = useRef(null)
  let rendered, reason
  try { rendered = captureShapeAppearance(store, viewProject(), clip) } catch (error) { reason = error.message }
  const begin = () => { gesture.current = rendered }
  const commit = async (action, value) => {
    const capture = gesture.current ?? rendered
    gesture.current = null
    if (!shapeAppearanceMatches(capture, store, viewProject())) { toast(reason ?? 'The project or shape changed. Reopen its appearance controls.', 'error'); return null }
    try { return await edit(shapeAppearanceOps(capture, action, value), 'Changed shape appearance', { expectedVersion: capture.version }) }
    catch (error) { toast(error.message, 'error'); return null }
  }
  const shape = clip.shape ?? {}, fill = shape.fill, stroke = shape.stroke
  const input = (paint, label, fallback) => html`<div class="field"><label>${label}</label>
    <input type="color" aria-label=${label + ' color'} disabled=${!rendered} value=${shapePickerColor(paint?.color, fallback)} onPointerDown=${begin} onFocus=${begin} onKeyDown=${e => e.stopPropagation()} onChange=${e => commit(label === 'Fill' ? 'fillColor' : 'strokeColor', e.target.value)} />
    <input aria-label=${label + ' hex color'} value=${paint?.color ?? fallback} disabled=${!rendered} onFocus=${begin} onKeyDown=${e => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur() }} onChange=${e => commit(label === 'Fill' ? 'fillColor' : 'strokeColor', e.target.value)} /></div>`
  return html`<section aria-label="Selected shape appearance">
    ${reason ? html`<div class="hint">${reason}</div>` : null}
    <div class="field"><label>Fill enabled</label><input type="checkbox" aria-label="Fill enabled" checked=${Boolean(fill)} disabled=${!rendered} onPointerDown=${begin} onFocus=${begin} onChange=${e => commit('fillEnabled', e.target.checked)} /></div>
    ${input(fill, 'Fill', '#f5b942')}
    <div class="field"><label>Stroke enabled</label><input type="checkbox" aria-label="Stroke enabled" checked=${Boolean(stroke?.width > 0)} disabled=${!rendered} onPointerDown=${begin} onFocus=${begin} onChange=${e => commit('strokeEnabled', e.target.checked)} /></div>
    ${input(stroke, 'Stroke', '#ffffff')}
    <div class="field"><label>Stroke width</label><input type="number" aria-label="Stroke width" value=${stroke?.width ?? 0} min="0" max="100" step="0.5" disabled=${!rendered} onFocus=${begin} onKeyDown=${e => e.stopPropagation()} onChange=${e => commit('strokeWidth', Number(e.target.value))} /><span class="unit">px</span></div>
    ${[fill, stroke].some(p => p?.gradient) ? html`<div class="hint">Choosing a color changes that paint to a solid color. Undo restores its previous paint.</div>` : null}
    <div class="hint">Changes apply to selected shapes. Motion keys and other layers keep their values.</div>
  </section>`
}

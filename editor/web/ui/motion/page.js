// The Motion page: compositions and presets on the left, the viewer with the motion
// tools in the middle, the inspector on the right, the layer timeline below.

import { h } from 'preact'
import htm from 'htm'
import { Inspector } from '../inspector.js'
import { set, useStore } from '../store.js'
import { Icon } from '../icons.js'
import { Viewer } from '../viewer.js'
import { CompList } from './comps.js'
import { LayerTimeline } from './layers.js'
import { PresetsSection } from './presets-ui.js'
import { ms, mset } from './state.js'

const html = htm.bind(h)

// Tool drawings come from ui/icons.js; each button names its tool for assistive technology.
const SHAPES = [['rect', 'shape', 'Rectangle'], ['ellipse', 'ellipse', 'Ellipse'], ['polygon', 'polygon', 'Polygon'], ['star', 'star', 'Star']]
const MASKS = [['rect', 'shape', 'Rectangle mask'], ['ellipse', 'ellipse', 'Ellipse mask'], ['path', 'pen', 'Pen mask']]

function ToolBar() {
  const s = useStore()
  const m = ms()
  const tool = s.tool
  const pick = id => set({ tool: id })

  return html`
    <div class="mo-tools">
      <div class="seg">
        <button class=${tool === 'select' ? 'on' : ''} aria-label="Selection" aria-pressed=${tool === 'select'} title="Selection: move, scale and rotate layers, drag keys and vertices (V)" onClick=${() => pick('select')}><${Icon} name="select" /></button>
      </div>
      <div class="seg" role="group" aria-label="Shape tools" title="Shape tools (Q cycles)">
        <span class="seg-label" aria-hidden="true">Shape</span>
        ${SHAPES.map(([k, icon, label]) => html`<button class=${tool === 'm-shape' && m.shapeKind === k ? 'on' : ''} aria-label=${label} aria-pressed=${tool === 'm-shape' && m.shapeKind === k} title=${`${label}: drag in the viewer (⇧ square, ⌥ from center)`} onClick=${() => (mset({ shapeKind: k }), pick('m-shape'))}><${Icon} name=${icon} /></button>`)}
      </div>
      <div class="seg">
        <button class=${tool === 'm-pen' ? 'on' : ''} aria-label="Pen" aria-pressed=${tool === 'm-pen'} title="Pen: click for corners, drag for curves, click the first point to close (G)" onClick=${() => pick('m-pen')}><${Icon} name="pen" /></button>
      </div>
      <div class="seg" role="group" aria-label="Mask tools" title="Mask tools: draw on the selected layer">
        <span class="seg-label" aria-hidden="true">Mask</span>
        ${MASKS.map(([k, icon, label]) => html`<button class=${tool === 'm-mask' && m.maskKind === k ? 'on' : ''} aria-label=${label} aria-pressed=${tool === 'm-mask' && m.maskKind === k} title=${label} onClick=${() => (mset({ maskKind: k }), pick('m-mask'))}><${Icon} name=${icon} /></button>`)}
      </div>
      <div class="seg">
        <button class=${tool === 'm-anchor' ? 'on' : ''} aria-label="Anchor point" aria-pressed=${tool === 'm-anchor'} title="Anchor point: drag to move the anchor without moving the layer (Y)" onClick=${() => pick('m-anchor')}><${Icon} name="anchor" /></button>
      </div>
      <span class="mo-sep"></span>
      <label class="mo-swatch" title="Fill for new shapes"><input type="checkbox" checked=${m.fillOn} onChange=${e => mset({ fillOn: e.target.checked })} />Fill<input type="color" aria-label="Fill color for new shapes" value=${m.fill} onInput=${e => mset({ fill: e.target.value })} /></label>
      <label class="mo-swatch" title="Stroke for new shapes (width 0 = none)">Stroke<input type="color" aria-label="Stroke color for new shapes" value=${m.stroke} onInput=${e => mset({ stroke: e.target.value })} />
        <input class="mo-num" type="number" aria-label="Stroke width in pixels" min="0" max="200" value=${m.strokeWidth} onKeyDown=${e => e.stopPropagation()} onInput=${e => mset({ strokeWidth: Math.max(0, Number(e.target.value) || 0) })} />px</label>
      ${tool === 'm-shape' && m.shapeKind === 'polygon' ? html`<label class="mo-swatch">Sides<input class="mo-num" type="number" aria-label="Polygon sides" min="3" max="64" value=${m.sides} onKeyDown=${e => e.stopPropagation()} onInput=${e => mset({ sides: Math.max(3, Number(e.target.value) || 3) })} /></label>` : null}
      ${tool === 'm-shape' && m.shapeKind === 'star' ? html`<label class="mo-swatch">Points<input class="mo-num" type="number" aria-label="Star points" min="3" max="64" value=${m.points} onKeyDown=${e => e.stopPropagation()} onInput=${e => mset({ points: Math.max(3, Number(e.target.value) || 3) })} /></label>` : null}
    </div>
  `
}

function LeftPanel() {
  const s = useStore()
  const m = ms()
  const tab = m.leftTab

  return html`
    <div class="panel mo-left">
      <div class="tabs">
        <button class=${tab === 'comps' ? 'on' : ''} onClick=${() => mset({ leftTab: 'comps' })}>Compositions</button>
        <button class=${tab === 'presets' ? 'on' : ''} onClick=${() => mset({ leftTab: 'presets' })}>Presets</button>
      </div>
      <div class="tab-body">${tab === 'comps' ? html`<${CompList} />` : html`<${PresetsSection} key=${s.selection[0] ?? 'none'} />`}</div>
    </div>
  `
}

export function MotionPage() {
  const s = useStore()

  return html`
    <div class=${`page motion ${s.chatOpen ? 'with-chat' : ''}`}>
      <div class="mo-upper">
        <${LeftPanel} />
        <div class="mo-center"><${ToolBar} /><${Viewer} /></div>
        <${Inspector} />
      </div>
      <div class="mo-lower"><${LayerTimeline} /></div>
    </div>
  `
}

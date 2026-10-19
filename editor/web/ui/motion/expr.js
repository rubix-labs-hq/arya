// Expression field for one property (⌥-click a stopwatch, as in After Effects):
// live validation through core check(), a result preview at the playhead, and a
// reference list of the language's building blocks.

import { h } from 'preact'
import { useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { check } from '/core/expr.js'
import { valueAt } from '/core/project.js'
import { edit, useTime } from '../store.js'
import { mset, ms } from './state.js'

const html = htm.bind(h)

export const EXPR_REFERENCE = [
  ['wiggle(2, 30)', 'Random motion: 2 wiggles a second, up to 30 units from the keyed value'],
  ['loopOut("cycle")', 'Repeat the keyframes after the last one'],
  ['loopOut("pingpong")', 'Play the keyframes back and forth'],
  ['linear(time, 0, 2, 0, 360)', 'Map time 0–2 s onto 0–360, clamped'],
  ['ease(time, 0, 1, 0, 100)', 'Like linear, eased at both ends'],
  ['time * 90', 'time is clip seconds: 90 a second'],
  ['value + sin(time * 4) * 20', 'value is the keyed value; oscillate around it'],
  ['valueAtTime(time - 0.25)', 'The keyed value a quarter second ago'],
  ['layer("Null").x', "Another layer's x (by name or id); also y, scale, rotation, opacity, anchorX, anchorY"],
  ['frame % 2 ? 0 : 1', 'frame, fps, width, height, index; conditions with ? :'],
  ['clamp(value, 0, 1)', 'Also min, max, abs, round, floor, ceil, sqrt, pow, noise, random'],
]

export function ExpressionRow({ view, clip, prop, scale = 1 }) {
  const t = useTime()
  const saved = clip.expr?.[prop] ?? ''
  const [text, setText] = useState(null)
  const [ref, setRef] = useState(false)
  const input = useRef(null)
  const src = text ?? saved
  const err = src.trim() ? check(src) : null
  const local = Math.max(0, Math.min(clip.dur, t - clip.start))
  let result = null
  if (!err && src.trim()) {
    const tmp = { ...clip, expr: { ...(clip.expr ?? {}), [prop]: src } }
    result = valueAt(view, tmp, prop, local) * scale
  }
  const save = () => {
    if (text === null || text === saved) return
    if (err) return
    edit({ op: 'expression', id: clip.id, prop, expr: text.trim() ? text.trim() : null }, text.trim() ? `expression on ${prop}` : `removed expression on ${prop}`)
    setText(null)
  }
  const insert = snippet => {
    const el = input.current
    const cur = text ?? saved
    const at = el?.selectionStart ?? cur.length
    const end = el?.selectionEnd ?? at
    setText(cur.slice(0, at) + snippet + cur.slice(end))
    setRef(false)
    setTimeout(() => el?.focus(), 0)
  }

  return html`
    <div class="mt-expr">
      <span class="mt-expr-eq" title="Expression">=</span>
      <input ref=${input} class=${`mt-expr-input ${err ? 'bad' : ''}`} value=${src} placeholder='e.g. wiggle(2, 30)' spellcheck="false"
        onInput=${e => setText(e.target.value)}
        onKeyDown=${e => {
          e.stopPropagation()
          if (e.key === 'Enter') save()
          if (e.key === 'Escape') {
            setText(null)
            e.target.blur()
          }
        }}
        onBlur=${save} />
      <span class=${`mt-expr-status ${err ? 'bad' : 'ok'}`} title=${err ?? ''}>${err ? err : src.trim() ? `→ ${fmt(result)}` : 'no expression'}</span>
      <button class="ghost tiny" title="Expression reference" onClick=${() => setRef(!ref)}>ƒx</button>
      ${saved ? html`<button class="ghost tiny" title="Remove the expression" onClick=${() => (edit({ op: 'expression', id: clip.id, prop, expr: null }), setText(null))}>✕</button>` : null}
      <button class="ghost tiny" title="Hide the expression field" onClick=${() => mset({ exprOpen: { ...ms().exprOpen, [`${clip.id}|${prop}`]: false } })}>▴</button>
      ${ref ? html`<div class="mt-expr-ref">${EXPR_REFERENCE.map(([code, note]) => html`<div class="mt-expr-ref-item" onPointerDown=${e => (e.preventDefault(), insert(code))}><code>${code}</code><span>${note}</span></div>`)}</div>` : null}
    </div>
  `
}

const fmt = v => (typeof v === 'number' && Number.isFinite(v) ? (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3)) : String(v))

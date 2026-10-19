// Arya interface icons. Original 24-unit outline drawings with one stroke weight,
// so the top bar, transport and timeline tools match each other at 16 pixels.
// Icons are decorative: the button that holds one must carry its own aria-label.
import { h } from 'preact'
import htm from 'htm'

const html = htm.bind(h)

// Each entry is a list of SVG children. Strings are path data; objects are other shapes.
// `fill: true` marks a solid shape inside the outline set (play and pause only).
const ICONS = {
  undo: ['M9 14 4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
  redo: ['M15 14l5-5-5-5', 'M20 9H9.5a5.5 5.5 0 0 0 0 11H13'],
  keyboard: [{ rect: [2.5, 6, 19, 12, 2] }, 'M6.5 10h1M10 10h1M13.5 10h1M17 10h.5M7.5 14h9'],
  assistant: ['M5 4.5h14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z', 'M7.5 9.5h9M7.5 12.5h5.5'],
  attach: ['M8 8v9a4 4 0 0 0 8 0V6.5a2.5 2.5 0 0 0-5 0V17a1 1 0 0 0 2 0V8'],
  close: ['M6 6l12 12M18 6 6 18'],
  export: ['M12 15V3.5', 'M7.5 8 12 3.5 16.5 8', 'M4.5 14.5v4a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4'],
  select: ['M5.5 3.5 19 10l-6.2 2.1L10.5 18.5z'],
  trim: ['M10 4H6.5v16H10', 'M14 4h3.5v16H14', 'M12 9v6'],
  blade: [{ circle: [6.5, 6.5, 2.75] }, { circle: [6.5, 17.5, 2.75] }, 'M8.6 8.6 20 20', 'M8.6 15.4 20 4'],
  slip: [{ rect: [3, 6, 18, 12, 1.5] }, 'M8.5 12h7', 'M10.5 10l-2 2 2 2', 'M13.5 10l2 2-2 2'],
  slide: ['M3.5 6v12', 'M20.5 6v12', { rect: [8.5, 8, 7, 8, 1.25] }, 'M6 12h2.5', 'M15.5 12H18'],
  hand: ['M8 13V6a1.5 1.5 0 0 1 3 0v5', 'M11 11V4.5a1.5 1.5 0 0 1 3 0V11', 'M14 11V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.6a6 6 0 0 1-4.8-2.4L3.4 15.6a1.5 1.5 0 0 1 2.3-1.9L8 16'],
  magnet: ['M5 3.5h4v7.5a3 3 0 0 0 6 0V3.5h4V11a7 7 0 0 1-14 0z', 'M5 7.5h4M15 7.5h4'],
  link: ['M10 13.5a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2', 'M14 10.5a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2'],
  minus: ['M5.5 12h13'],
  plus: ['M12 5.5v13M5.5 12h13'],
  fit: ['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5'],
  'skip-start': ['M6 5v14', { path: 'M18.5 5.5 9 12l9.5 6.5z', fill: true }],
  'skip-end': ['M18 5v14', { path: 'M5.5 5.5 15 12l-9.5 6.5z', fill: true }],
  'prev-edit': ['M5 5v14', 'M19 12H9.5', 'M13 8.5 9.5 12l3.5 3.5'],
  'next-edit': ['M19 5v14', 'M5 12h9.5', 'M11 8.5l3.5 3.5-3.5 3.5'],
  'step-back': ['M14.5 6.5 9 12l5.5 5.5'],
  'step-forward': ['M9.5 6.5 15 12l-5.5 5.5'],
  play: [{ path: 'M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z', fill: true }],
  pause: [{ rect: [6.5, 5, 3.5, 14, 1], fill: true }, { rect: [14, 5, 3.5, 14, 1], fill: true }],
  loop: ['M17 2.5l3 3-3 3', 'M4 11.5V10a4.5 4.5 0 0 1 4.5-4.5H20', 'M7 21.5l-3-3 3-3', 'M20 12.5V14a4.5 4.5 0 0 1-4.5 4.5H4'],
  clear: ['M6.5 6.5l11 11M17.5 6.5l-11 11'],
  shape: [{ rect: [4, 6, 16, 12, 1.5] }],
  pen: ['M12 3.5l6.5 8.5L12 20.5 5.5 12z', 'M12 3.5v7', { circle: [12, 12.5, 1.6] }],
  mask: [{ rect: [3.5, 4.5, 17, 15, 2] }, { circle: [12, 12, 4.25] }],
  anchor: [{ circle: [12, 12, 3] }, 'M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5'],
  track: [{ circle: [12, 12, 7.5] }, { circle: [12, 12, 1.75], fill: true }, 'M12 2v3M12 19v3M2 12h3M19 12h3'],
  'chevron-down': ['M6.5 9.5 12 15l5.5-5.5'],
  'safe-area': [{ rect: [3, 5, 18, 14, 1.5] }, { rect: [6.5, 8, 11, 8, 1] }],
  grid: [{ rect: [3.5, 4.5, 17, 15, 1.5] }, 'M9.2 4.5v15M14.8 4.5v15M3.5 9.5h17M3.5 14.5h17'],
  ellipse: ['M3.5 12a8.5 6.5 0 1 0 17 0a8.5 6.5 0 1 0-17 0z'],
  polygon: ['M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z'],
  star: ['M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8l-5.1 2.7 1-5.7-4.1-4 5.7-.8z'],
}

function part(p, i) {
  if (typeof p === 'string') return html`<path key=${i} d=${p} />`
  const solid = p.fill ? { fill: 'currentColor', stroke: 'none' } : {}
  if (p.path) return html`<path key=${i} d=${p.path} ...${solid} />`
  if (p.circle) return html`<circle key=${i} cx=${p.circle[0]} cy=${p.circle[1]} r=${p.circle[2]} ...${solid} />`
  const [x, y, width, height, rx] = p.rect
  return html`<rect key=${i} x=${x} y=${y} width=${width} height=${height} rx=${rx} ...${solid} />`
}

export function hasIcon(name) {
  return Object.hasOwn(ICONS, name)
}

// Returns null for an unknown name so a caller can fall back to its text label.
export function Icon({ name, size = 16 }) {
  // Own-property check, so names such as `constructor` or `__proto__` fall back like any unknown name.
  if (!hasIcon(name)) return null
  const parts = ICONS[name]
  return html`<svg class="ico" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${parts.map(part)}</svg>`
}

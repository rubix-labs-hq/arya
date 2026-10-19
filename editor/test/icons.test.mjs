import './fixtures/browser-host-imports.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { Icon, hasIcon } from '../web/ui/icons.js'

const editor = new URL('../', import.meta.url)
registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('/core/') ? new URL('.' + specifier, editor).href : specifier, context) } })
const { duration, newProject } = await import('../core/project.js')

const ui = new URL('../web/ui/', import.meta.url)
const read = name => fs.readFile(new URL(name, ui), 'utf8')
const moduleURL = text => 'data:text/javascript;base64,' + Buffer.from(text).toString('base64')
const ICON_NAMES = [...(await read('icons.js')).matchAll(/^  '?([a-z-]+)'?: \[/gm)].map(m => m[1])

// Loads an actual UI module with its relative imports replaced by the given stubs.
// `tag` makes the module URL unique so each case gets fresh module state.
async function load(file, stubs, tag, append = '') {
  let source = await read(file)
  const imports = {
    preact: import.meta.resolve('preact'), htm: import.meta.resolve('htm'),
    '/core/project.js': new URL('../core/project.js', import.meta.url).href,
    './icons.js': new URL('../web/ui/icons.js', import.meta.url).href,
    ...stubs,
  }
  for (const [specifier, target] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(target))
  return import(moduleURL(`${source}\n${append}\n// ${tag}`))
}

// Expands function components so the result contains only DOM vnodes.
function expand(node) {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node == null || typeof node !== 'object') return [node]
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return [{ ...node, props: { ...node.props, children: expand(node.props.children) } }]
}
const walk = (nodes, out = []) => { for (const n of nodes) if (n && typeof n === 'object') { out.push(n); walk(n.props.children, out) } return out }
const buttons = tree => walk(tree).filter(n => n.type === 'button')
const text = button => walk([button]).flatMap(n => n.props.children).filter(c => typeof c === 'string' || typeof c === 'number').join('').trim()
const shape = svg => JSON.stringify(expand(svg.props.children).map(c => [c.type, Object.entries(c.props).filter(([k]) => k !== 'children' && k !== 'key').sort()]))
const DRAWINGS = new Map(ICON_NAMES.map(name => [shape(Icon({ name })), name]))
// Names the drawn icon inside a button by its geometry, or null when it holds none.
function iconOf(button) {
  const svgs = walk(button.props.children).filter(n => n.type === 'svg')
  assert.ok(svgs.length <= 1, 'a button holds more than one icon')
  if (!svgs.length) return null
  const name = DRAWINGS.get(shape(svgs[0]))
  assert.ok(name, 'a button holds an unknown drawing')
  return name
}
// Every test removes the globals its stubs read, so no state leaks into other test files.
test.after(() => {
  const leaked = Object.keys(globalThis).filter(k => /^__(viewer|toolbar)/.test(k)).concat('document' in globalThis ? ['document'] : [])
  assert.deepEqual(leaked, [])
})
const byName = tree => new Map(buttons(tree).map(b => [b.props['aria-label'] ?? text(b), b]))

test('every icon name used by the top bar, transport and timeline toolbar is drawn, and drawings are distinct', async () => {
  const used = new Set()
  for (const file of ['app.js', 'viewer.js', 'timeline-toolbar.js']) {
    for (const m of (await read(file)).matchAll(/<\$\{Icon\} name="([^"]+)"/g)) used.add(m[1])
  }
  const toolbar = await read('timeline-toolbar.js')
  for (const m of toolbar.matchAll(/\['[a-z]+', '([a-z-]+)', '/g)) used.add(m[1])
  for (const m of toolbar.slice(toolbar.indexOf('PLUGIN_ICONS')).split('\n')[0].matchAll(/: '([a-z-]+)'/g)) used.add(m[1])
  assert.ok(used.size >= 25, `found ${used.size} icon names`)
  for (const name of used) assert.ok(hasIcon(name), `missing icon ${name}`)
  assert.equal(DRAWINGS.size, ICON_NAMES.length, 'two icons share a drawing')
})

test('every drawn icon is hidden from assistive technology; unknown and prototype names render nothing', () => {
  for (const name of ICON_NAMES) {
    const svg = Icon({ name })
    assert.equal(svg.type, 'svg', name)
    assert.equal(svg.props['aria-hidden'], 'true', name)
    assert.equal(svg.props.focusable, 'false', name)
  }
  for (const name of ['no-such-icon', 'constructor', 'toString', '__proto__', 'hasOwnProperty', undefined]) {
    assert.equal(hasIcon(name), false, String(name))
    assert.equal(Icon({ name }), null, String(name))
  }
})

test('actual timeline toolbar: names, icons, pressed states in both directions and every click', async () => {
  const calls = []
  const store = moduleURL(`export const set=v=>globalThis.__toolbarCalls.push(v);export const useStore=()=>globalThis.__toolbarState;export const viewProject=()=>globalThis.__toolbarProject;`)
  const registry = moduleURL(`export const registry={tools:[{id:'m-shape',label:'Shape tool',icon:'▭',key:'Q'},{id:'m-pen',label:'Pen tool',icon:'✎'},{id:'m-mask',label:'Mask tool',icon:'◪'},{id:'m-anchor',label:'Anchor point tool',icon:'⊕'},{id:'track',label:'Track',icon:'⌖'},{id:'custom-plugin',label:'Custom plugin tool',icon:'★'}],pages:[]};`)
  const p = newProject('Toolbar', { width: 640, height: 360, fps: 30 })
  p.tracks[0].clips.push({ id: 'c1', kind: 'title', start: 0, dur: 20, text: 'x' })
  const tools = [
    ['Select', 'select', 'select'], ['Trim: ripple edges, roll edit points, slip bodies, ⌥ slide', 'trim', 'trim'], ['Blade', 'blade', 'blade'],
    ['Slip', 'slip', 'slip'], ['Slide', 'slide', 'slide'], ['Hand', 'hand', 'hand'],
    ['Shape tool', 'shape', 'm-shape'], ['Pen tool', 'pen', 'm-pen'], ['Mask tool', 'mask', 'm-mask'], ['Anchor point tool', 'anchor', 'm-anchor'], ['Track', 'track', 'track'],
    ['Custom plugin tool', null, 'custom-plugin'],
  ]
  globalThis.__toolbarCalls = calls; globalThis.__toolbarProject = p
  globalThis.document = { querySelector: () => ({ clientWidth: 1050 }) }
  try {
    // Each tool takes a turn as the active one; snapping and linking alternate.
    for (const [index, [, , active]] of tools.entries()) {
      const tag = `tool-${active}`, state = { tool: active, snapping: index % 2 === 0, linked: index % 2 === 1, selection: [], zoom: 10, openComp: null }
      globalThis.__toolbarState = state
      const { Toolbar } = await load('timeline-toolbar.js', { './store.js': store, './registry.js': registry }, tag)
      const named = byName(expand(Toolbar()))
      for (const b of named.values()) assert.ok(b.props['aria-label'], `button without aria-label: ${text(b)}`)
      for (const [label, icon, id] of tools) {
        const b = named.get(label)
        assert.ok(b, `missing ${label}`)
        assert.equal(iconOf(b), icon, `${label} icon`)
        assert.equal(b.props['aria-pressed'], state.tool === id, `${label} pressed`)
        calls.length = 0; b.props.onClick()
        assert.deepEqual(calls, [{ tool: id }], `${label} click`)
      }
      assert.equal(text(named.get('Custom plugin tool')), '★', 'an unknown plugin tool keeps its glyph')
      for (const [label, icon, key] of [['Snapping', 'magnet', 'snapping'], ['Linked selection', 'link', 'linked']]) {
        const b = named.get(label)
        assert.equal(iconOf(b), icon)
        assert.equal(b.props['aria-pressed'], state[key], `${label} pressed`)
        calls.length = 0; b.props.onClick()
        assert.deepEqual(calls, [{ [key]: !state[key] }], `${label} click`)
      }
      for (const [label, icon, expected] of [
        ['Zoom out', 'minus', { zoom: 10 / 1.5 }],
        ['Zoom in', 'plus', { zoom: 15 }],
        ['Fit timeline', 'fit', { zoom: 1050 / (duration(p) * 1.05), scroll: 0 }],
      ]) {
        const b = named.get(label)
        assert.equal(iconOf(b), icon)
        assert.equal(b.props['aria-pressed'], undefined, `${label} is an action, not a toggle`)
        calls.length = 0; b.props.onClick()
        assert.deepEqual(calls, [expected], `${label} click`)
      }
    }
  } finally { delete globalThis.__toolbarCalls; delete globalThis.__toolbarState; delete globalThis.__toolbarProject; delete globalThis.document }
})

// Shared stubs for viewer.js. Node caches these data-URL modules across cases, so they read
// live globals. useState returns __viewerState values in call order (reset __viewerStateIndex
// before each render); useRef hands a null ref the fake video element.
const viewerStubs = () => ({
  'preact/hooks': moduleURL('export const useEffect=()=>{};export const useRef=x=>({current:x===null?globalThis.__viewerVideo??null:x});export const useState=x=>{const o=globalThis.__viewerState,i=globalThis.__viewerStateIndex=(globalThis.__viewerStateIndex??0)+1;return[o&&i-1 in o?o[i-1]:x,()=>{}]};'),
  './engine-host.js': moduleURL(`export const canvas={},comp={size:[320,180]},media={titles:new Map()};export const player={seek:t=>globalThis.__viewerLog.push(['seek',t]),step:d=>globalThis.__viewerLog.push(['step',d]),toggle:()=>globalThis.__viewerLog.push(['toggle'])};`),
  './store.js': moduleURL(`export const addRef=()=>{},toast=()=>{};export const useStore=()=>globalThis.__viewerStore;export const edit=v=>globalThis.__viewerLog.push(['edit',v]);export const set=v=>globalThis.__viewerLog.push(['set',v]);export const store=new Proxy({},{get:(_,k)=>globalThis.__viewerStore[k]});export const time={t:2};export const useTime=()=>2;export const viewProject=()=>globalThis.__viewerProject;`),
  '../engine/frame.js': moduleURL('export const titleAnim=()=>({});'),
  '../engine/media.js': moduleURL('export const mediaUrl=()=>"/media/source.mp4";'),
  '../engine/shapes.js': new URL('../web/engine/shapes.js', import.meta.url).href,
  './motion/geometry.js': new URL('../web/ui/motion/geometry.js', import.meta.url).href,
  './source-media.js': new URL('../web/ui/source-media.js', import.meta.url).href,
  './registry.js': new URL('../web/ui/registry.js', import.meta.url).href,
})

function transportProject() {
  const p = newProject('Transport', { width: 640, height: 360, fps: 30 })
  p.tracks[0].clips.push({ id: 'c1', kind: 'title', start: 1, dur: 4, text: 'x' })
  p.markers = [{ id: 'm1', t: 3 }]
  return p
}

test('actual timeline transport: play, pause and shuttle label, icons, loop state and every click', async () => {
  const log = []
  const p = transportProject()
  assert.equal(duration(p), 5)
  globalThis.__viewerLog = log; globalThis.__viewerProject = p
  try {
    for (const [tag, state, label, icon, rateText] of [
      ['play', { playing: false, rate: 1, loop: false }, 'Play', 'play', ''],
      ['pause', { playing: true, rate: 1, loop: true }, 'Pause', 'pause', ''],
      ['shuttle', { playing: true, rate: 2, loop: false }, 'Pause', null, '2×'],
    ]) {
      globalThis.__viewerStore = state
      const { Transport } = await load('viewer.js', viewerStubs(), tag)
      const named = byName(expand(Transport({ p })))
      for (const b of named.values()) assert.ok(b.props['aria-label'], `button without aria-label: ${text(b)}`)
      const play = named.get(label)
      assert.equal(play.props.class, 'play')
      assert.equal(iconOf(play), icon)
      assert.equal(text(play), rateText)
      assert.equal(named.get('Loop playback').props['aria-pressed'], state.loop)
      const expected = [
        ['Go to start', 'skip-start', ['seek', 0]], ['Previous edit', 'prev-edit', ['seek', 1]], ['Back one frame', 'step-back', ['step', -1]],
        [label, icon, ['toggle']], ['Forward one frame', 'step-forward', ['step', 1]], ['Next edit', 'next-edit', ['seek', 3]], ['Go to end', 'skip-end', ['seek', 5]],
        ['Mark in', null, ['edit', { op: 'range', in: 2, out: 5 }]], ['Mark out', null, ['edit', { op: 'range', in: 0, out: 2 }]],
        ['Clear range', 'clear', ['edit', { op: 'range', in: null }]], ['Loop playback', 'loop', ['set', { loop: !state.loop }]],
      ]
      assert.equal(named.size, expected.length)
      for (const [name, drawn, call] of expected) {
        const b = named.get(name)
        assert.ok(b, `missing ${name}`)
        assert.equal(iconOf(b), drawn, `${name} icon`)
        log.length = 0; b.props.onClick()
        assert.deepEqual(log, [call], `${name} click`)
      }
      assert.equal(named.get('Clear range').props.disabled, true, 'clear range is disabled without a range')
    }
  } finally { delete globalThis.__viewerLog; delete globalThis.__viewerStore; delete globalThis.__viewerProject; delete globalThis.__viewerStateIndex }
})

test('actual source monitor transport: play and pause names and icons, and the toggle reaches the video', async () => {
  const log = []
  const p = transportProject()
  p.assets = { 'clip.mp4': { hasVideo: true, hasAudio: true, duration: 8, fps: 30 } }
  globalThis.__viewerLog = log; globalThis.__viewerProject = p
  globalThis.__viewerStore = { source: { src: 'clip.mp4', t: 0 }, project: p, root: '/tmp', version: 1, openComp: null }
  try {
    for (const [tag, playing, label, icon, call] of [['source-play', false, 'Play source', 'play', 'play'], ['source-pause', true, 'Pause source', 'pause', 'pause']]) {
      globalThis.__viewerVideo = { paused: !playing, readyState: 4, currentTime: 0, play() { log.push('play'); return Promise.resolve() }, pause() { log.push('pause') }, addEventListener() {}, removeEventListener() {} }
      globalThis.__viewerState = [0, playing]
      const { loadedSource } = await load('viewer.js', viewerStubs(), tag, 'export { SourceViewer as loadedSource }')
      globalThis.__viewerStateIndex = 0
      const named = byName(expand(loadedSource()))
      const play = named.get(label)
      assert.ok(play, `missing ${label}`)
      assert.equal(play.props.class, 'play')
      assert.equal(iconOf(play), icon)
      assert.equal(named.has(playing ? 'Play source' : 'Pause source'), false)
      for (const name of ['Mark source in', 'Mark source out']) assert.equal(iconOf(named.get(name)), null, name)
      for (const name of ['Append', 'Insert', 'Overwrite', 'Connect']) assert.ok(named.has(name), `${name} keeps its visible text name`)
      log.length = 0; play.props.onClick()
      assert.deepEqual(log, [call])
    }
  } finally { delete globalThis.__viewerLog; delete globalThis.__viewerStore; delete globalThis.__viewerProject; delete globalThis.__viewerVideo; delete globalThis.__viewerState; delete globalThis.__viewerStateIndex }
})

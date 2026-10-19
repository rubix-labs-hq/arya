// Reusable components contain only native project data. Operations copy that data
// into the project and leave the source objects and earlier library copies alone.
import { evaluate as evalExpr, parse as parseExpr } from './expr.js'

export const LIBRARY_VERSION = 1
export const LIBRARY_CATEGORIES = ['title', 'composition', 'effect', 'transition', 'motion']
const KINDS = ['video', 'image', 'audio', 'title', 'color', 'adjustment', 'shape', 'null', 'comp', 'multicam', 'caption']
const VISUAL = ['video', 'image', 'title', 'color', 'adjustment', 'shape', 'comp', 'multicam']
const EFFECT_TYPES = ['blur', 'sharpen', 'vignette', 'grain', 'pixelate', 'glow', 'mirror', 'invert', 'posterize', 'chromaticAberration', 'letterbox']
const NODE_TYPES = ['source', 'primary', 'corrector', 'parallel', 'layerMixer', 'key', 'lut', 'blur', 'sharpen', 'glow', 'output']
const TRANSITIONS = ['crossDissolve', 'dipBlack', 'dipWhite', 'wipeLeft', 'wipeRight', 'wipeUp', 'wipeDown', 'slideLeft', 'slideRight', 'pushLeft', 'pushRight', 'zoomIn', 'iris', 'blurDissolve']
const TITLE_ANIMS = ['none', 'fade', 'rise', 'drop', 'pop', 'slideLeft', 'slideRight', 'typewriter', 'blurIn', 'tracking']
const PROPS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'anchorX', 'anchorY', 'volume', 'pan', 'blur']
const EASES = ['linear', 'in', 'out', 'inOut', 'smooth', 'backOut', 'expoOut', 'expoIn', 'hold']
const EXPR_FUNCTIONS = 'sin cos tan asin acos atan atan2 abs min max floor ceil round sqrt pow exp log sign clamp degreesToRadians radiansToDegrees linear ease easeIn easeOut noise random wiggle valueAtTime loopOut layer'.split(' ')
const EXPR_NAMES = 'time value fps frame index width height PI true false cycle pingpong continue'.split(' ')
const EFFECT_PARAMS = { blur: ['radius'], sharpen: ['amount'], vignette: ['amount', 'softness'], grain: ['amount', 'size'], pixelate: ['size'], glow: ['amount', 'threshold', 'radius'], mirror: ['axis'], invert: [], posterize: ['levels'], chromaticAberration: ['amount'], letterbox: ['ratio'] }
const CLIP_FIELDS = ('id kind start dur src in speed reverse freeze enabled label note tag link x y anchorX anchorY scale scaleX scaleY rotation opacity crop fit blend fadeIn fadeOut parent parentRef volume pan eq mute audioDetached grade nodes effects key masks matte transitionIn title color shape comp angles cuts audioAngle text words source style anim expr blurAmount').split(' ')
const fail = message => { throw new Error(`Library: ${message}`) }
const obj = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = value => Number.isFinite(value) && value > 0 && value < 1000000
const idOK = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id)
const clone = value => structuredClone(value)
const sameData = (a, b) => {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameData(v, b[i]))
  if (!obj(a) || !obj(b)) return false
  const aKeys = Object.keys(a).filter(k => a[k] !== undefined).sort(), bKeys = Object.keys(b).filter(k => b[k] !== undefined).sort()
  return aKeys.length === bKeys.length && aKeys.every((k, i) => k === bKeys[i] && sameData(a[k], b[k]))
}
const clipsIn = tracks => (tracks ?? []).flatMap(t => t.clips ?? [])
const rootTracks = p => p.__rootTracks ?? p.tracks
const allClips = p => [...clipsIn(rootTracks(p)), ...Object.values(p.comps ?? {}).flatMap(c => clipsIn(c.tracks))]
const isPlacementBody = item => Boolean(item.body?.clip || item.body?.composition)
export const libraryPlacesObject = item => ['title', 'composition'].includes(item.category) || item.category === 'effect' && isPlacementBody(item)
const bodyDuration = body => {
  if (body.clip) return body.clip.dur
  const comp = body.comps?.[body.composition]
  return comp?.duration ?? (Math.max(0, ...clipsIn(comp?.tracks).map(c => c.start + c.dur)) || 5)
}

function keys(value, allowed, label) {
  if (!obj(value)) fail(`${label} must be an object`)
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown ${label} field ${key}`)
}

function numbers(value, fields, label) {
  for (const field of fields) if (value[field] !== undefined && !Number.isFinite(value[field])) fail(`${label}.${field} must be a number`)
}

function grade(value) {
  keys(value, 'exposure contrast pivot saturation hue temperature tint lift gamma gain offset shadowTint highlightTint curves lut lutMix lutSpace look vignette blur brightness gammaV1'.split(' '), 'grade')
  numbers(value, 'exposure contrast pivot saturation hue temperature tint lutMix vignette blur brightness gammaV1'.split(' '), 'grade')
  for (const field of ['lift', 'gamma', 'gain', 'offset', 'shadowTint', 'highlightTint']) if (value[field] !== undefined && !(Number.isFinite(value[field]) || Array.isArray(value[field]) && value[field].length === 3 && value[field].every(Number.isFinite))) fail(`grade.${field} needs three numbers`)
  if (value.curves) {
    keys(value.curves, ['master', 'r', 'g', 'b'], 'curves')
    for (const curve of Object.values(value.curves)) if (!Array.isArray(curve) || curve.length < 2 || !curve.every(pt => Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite))) fail('invalid grade curve')
  }
}

function pathData(value) {
  keys(value, ['closed', 'vertices', 'in', 'out'], 'path')
  if (!Array.isArray(value.vertices) || !value.vertices.length) fail('path needs vertices')
  for (const field of ['vertices', 'in', 'out']) if (value[field] !== undefined && (!Array.isArray(value[field]) || !value[field].every(pt => Array.isArray(pt) && pt.length === 2 && pt.every(Number.isFinite)))) fail('invalid path points')
}

function titleData(value) {
  keys(value, 'text font weight size color gradient align lineHeight tracking italic stroke shadow plate padding radius anim box'.split(' '), 'title')
  numbers(value, ['weight', 'size', 'lineHeight', 'tracking', 'padding', 'radius'], 'title')
  if (value.font !== undefined && typeof value.font !== 'string') fail('title font must be text')
  if (value.anim !== undefined && !TITLE_ANIMS.includes(value.anim)) fail('invalid title animator')
  if (value.align !== undefined && !['left', 'center', 'right', 'justify'].includes(value.align)) fail('invalid title alignment')
  if (value.box) {
    keys(value.box, ['width', 'height', 'wrap', 'alignY'], 'title box'); numbers(value.box, ['width', 'height'], 'title box')
    if (value.box.wrap !== undefined && typeof value.box.wrap !== 'boolean' || value.box.alignY !== undefined && !['top', 'center', 'bottom'].includes(value.box.alignY)) fail('invalid title box')
  }
  if (value.stroke) { keys(value.stroke, ['color', 'width'], 'title stroke'); numbers(value.stroke, ['width'], 'title stroke') }
  if (value.shadow) { keys(value.shadow, ['color', 'blur', 'x', 'y'], 'title shadow'); numbers(value.shadow, ['blur', 'x', 'y'], 'title shadow') }
}

function shapeData(value) {
  keys(value, 'type width height radius sides points innerRadius path fill stroke trim'.split(' '), 'shape')
  numbers(value, ['width', 'height', 'radius', 'sides', 'points', 'innerRadius'], 'shape')
  if (value.path) pathData(value.path)
  if (value.fill) {
    keys(value.fill, ['color', 'gradient'], 'shape fill')
    if (value.fill.gradient) {
      const g = value.fill.gradient
      keys(g, ['type', 'stops', 'angle', 'center', 'radius', 'from', 'to'], 'shape gradient')
      if (!['linear', 'radial'].includes(g.type) || !Array.isArray(g.stops) || g.stops.length < 2 || !g.stops.every(s => Array.isArray(s) && s.length === 2 && Number.isFinite(s[0]) && typeof s[1] === 'string')) fail('invalid shape gradient')
    }
  }
  if (value.stroke) { keys(value.stroke, ['color', 'width', 'join', 'cap', 'dash'], 'shape stroke'); numbers(value.stroke, ['width'], 'shape stroke') }
  if (value.trim) { keys(value.trim, ['start', 'end', 'offset'], 'shape trim'); numbers(value.trim, ['start', 'end', 'offset'], 'shape trim') }
}

function plain(value, depth = 0, count = { n: 0 }) {
  if (++count.n > 100000 || depth > 40) fail('component is too large or deeply nested')
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('numbers must be finite'); return }
  if (typeof value === 'string') { if (value.length > 200000) fail('text is too long'); return }
  if (Array.isArray(value)) { value.forEach(v => plain(v, depth + 1, count)); return }
  if (!obj(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('only declarative JSON data is allowed')
  for (const [key, val] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('unsafe object key')
    if (val !== undefined) plain(val, depth + 1, count)
  }
}

function pathOK(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 2048 && !/^[\/\\]|^[a-z][a-z0-9+.-]*:|[\0\\]|(^|\/)\.\.?(\/|$)/i.test(path)
}

function animProp(prop, clip) {
  if (PROPS.includes(prop)) return ['volume', 'pan'].includes(prop) ? ['audio', 'video', 'comp', 'multicam'].includes(clip.kind) : clip.kind !== 'audio' && clip.kind !== 'caption'
  if (/^shape\.(width|height|radius|innerRadius|stroke\.width|trim\.(start|end|offset))$/.test(prop)) return clip.kind === 'shape'
  if (/^title\.(size|tracking|lineHeight)$/.test(prop)) return clip.kind === 'title'
  const ref = /^(mask|node)\.([A-Za-z0-9_-]+)\.(.+)$/.exec(prop)
  if (!ref) return false
  if (ref[1] === 'mask') return (clip.masks ?? []).some(m => m.id === ref[2]) && /^(x|y|w|h|radius|feather|expansion|opacity)$/.test(ref[3])
  const node = (clip.nodes?.list ?? []).find(n => n.id === ref[2])
  if (!node || ['source', 'output'].includes(node.type)) return false
  if (/^window\.(x|y|w|h|softness|rotation)$/.test(ref[3])) return obj(node.window)
  if (/^grade\.(exposure|contrast|pivot|saturation|hue|temperature|tint)$/.test(ref[3])) return ['primary', 'corrector'].includes(node.type)
  return { blur: ['radius'], sharpen: ['amount'], glow: ['radius', 'amount', 'threshold'], lut: ['mix'] }[node.type]?.includes(ref[3]) ?? false
}

function validateAnim(anim, clip) {
  if (!obj(anim)) fail('animation must be a property map')
  for (const [prop, frames] of Object.entries(anim)) {
    if (!animProp(prop, clip)) fail(`animation property ${prop} is incompatible with ${clip.kind}`)
    if (!Array.isArray(frames) || !frames.length || frames.length > 10000) fail(`invalid keyframes for ${prop}`)
    let last = -Infinity
    for (const key of frames) {
      if (!Array.isArray(key) || key.length < 2 || key.length > 3 || !Number.isFinite(key[0]) || !Number.isFinite(key[1]) || Math.abs(key[0]) >= 1000000 || key[0] <= last) fail(`invalid or unsorted keyframes for ${prop}`)
      last = key[0]
      if (key[2] !== undefined && !(EASES.includes(key[2]) || Array.isArray(key[2]) && key[2].length === 4 && key[2].every(Number.isFinite) && key[2][0] >= 0 && key[2][0] <= 1 && key[2][2] >= 0 && key[2][2] <= 1)) fail(`invalid easing for ${prop}`)
    }
  }
}

function retimeFrames(frames, sourceDur, targetDur, round = value => value) {
  if (!positive(sourceDur) || !positive(targetDur)) fail('animation needs positive source and target durations')
  let last = -Infinity
  return frames.map(([time, value, ease]) => {
    const at = round(time / sourceDur * targetDur)
    if (!Number.isFinite(at) || Math.abs(at) >= 1000000 || at <= last) fail('retimed keyframes must be finite, ordered and within the supported timeline range')
    last = at
    return [at, value, ...(ease === undefined ? [] : [clone(ease)])]
  })
}

function validateGraph(graph) {
  keys(graph, ['list', 'links'], 'node graph')
  if (!Array.isArray(graph.list) || !Array.isArray(graph.links) || graph.list.length > 1000) fail('invalid node graph')
  const ids = new Set()
  for (const node of graph.list) {
    keys(node, 'id type x y enabled grade qualifier window weights blends color similarity smoothness spill lut mix lutSpace radius amount threshold'.split(' '), 'node')
    if (!idOK(node.id) || ids.has(node.id) || !NODE_TYPES.includes(node.type)) fail('invalid or duplicate node')
    numbers(node, ['x', 'y', 'radius', 'amount', 'threshold', 'mix', 'similarity', 'smoothness', 'spill'], 'node')
    if (node.grade) grade(node.grade)
    if (node.window) { keys(node.window, 'type x y w h rotation softness invert points'.split(' '), 'node window'); numbers(node.window, ['x', 'y', 'w', 'h', 'rotation', 'softness'], 'node window') }
    if (node.qualifier) {
      keys(node.qualifier, ['hue', 'sat', 'lum', 'soft', 'invert'], 'qualifier')
      numbers(node.qualifier, ['soft'], 'qualifier')
      for (const prop of ['hue', 'sat', 'lum']) if (node.qualifier[prop] !== undefined && (!Array.isArray(node.qualifier[prop]) || node.qualifier[prop].length !== 2 || !node.qualifier[prop].every(Number.isFinite))) fail('invalid qualifier range')
    }
    ids.add(node.id)
  }
  if (graph.list.filter(n => n.type === 'source').length !== 1 || graph.list.filter(n => n.type === 'output').length !== 1) fail('node graph needs one source and one output')
  const inputs = new Set()
  for (const l of graph.links) {
    keys(l, ['from', 'to', 'input'], 'node link')
    if (!ids.has(l.from) || !ids.has(l.to) || !Number.isInteger(l.input) || l.input < 0 || l.input > 1000 || graph.list.find(n => n.id === l.to).type === 'source') fail('invalid node link')
    const input = `${l.to}:${l.input}`
    if (inputs.has(input)) fail('duplicate node input')
    inputs.add(input)
  }
  const visiting = new Set(), visited = new Set()
  const visit = id => {
    if (visiting.has(id)) fail('node graph has a cycle')
    if (visited.has(id)) return
    visiting.add(id)
    for (const l of graph.links) if (l.to === id) visit(l.from)
    visiting.delete(id); visited.add(id)
  }
  for (const id of ids) visit(id)
  const output = graph.list.find(n => n.type === 'output')
  if (!graph.links.some(l => l.to === output.id)) fail('node output is disconnected')
}

function validateEffects(effects) {
  if (!Array.isArray(effects) || effects.length > 1000) fail('effects must be an array')
  for (const effect of effects) {
    keys(effect, ['type', 'enabled', 'params'], 'effect')
    if (!EFFECT_TYPES.includes(effect.type) || effect.enabled !== undefined && typeof effect.enabled !== 'boolean' || !obj(effect.params)) fail('invalid effect')
    keys(effect.params, EFFECT_PARAMS[effect.type], 'effect params')
    numbers(effect.params, EFFECT_PARAMS[effect.type].filter(p => p !== 'axis'), 'effect params')
    if (effect.type === 'mirror' && effect.params.axis !== undefined && !['x', 'y', 'both'].includes(effect.params.axis)) fail('invalid mirror axis')
  }
}

function layerRefs(expr) {
  try {
    evalExpr(expr, { time: 1, value: 0, fps: 30, index: 1, width: 1920, height: 1080, layer: () => ({ x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, anchorX: 0, anchorY: 0 }), valueAtTime: () => 0, keys: [], seed: 1 })
  } catch (error) { fail(`invalid expression: ${error.message}`) }
  const refs = []
  const visit = tree => {
    if (!obj(tree)) return
    if (tree.k === 'call' && !EXPR_FUNCTIONS.includes(tree.name)) fail(`unknown expression function ${tree.name}`)
    if (tree.k === 'id' && !EXPR_NAMES.includes(tree.v)) fail(`unknown expression name ${tree.v}`)
    if (tree.k === 'member' && (tree.obj?.k !== 'call' || tree.obj.name !== 'layer' || !['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'anchorX', 'anchorY'].includes(tree.name))) fail('expressions only read supported layer properties')
    if (tree.k === 'call' && tree.name === 'layer') {
      if (tree.args.length !== 1 || tree.args[0].k !== 'str') fail('layer expressions need an explicit layer name or ID')
      refs.push(tree.args[0].v)
    }
    for (const v of Object.values(tree)) if (Array.isArray(v)) v.forEach(visit); else if (obj(v)) visit(v)
  }
  visit(parseExpr(expr))
  return refs
}

function rewriteExpr(expr, replacements) {
  const emit = tree => {
    if (tree.k === 'num') return String(tree.v)
    if (tree.k === 'id') return tree.v
    if (tree.k === 'str') {
      const quote = tree.v.includes('"') ? "'" : '"'
      return `${quote}${tree.v}${quote}`
    }
    if (tree.k === 'bin') return `(${emit(tree.left)} ${tree.op} ${emit(tree.right)})`
    if (tree.k === 'un') return `(${tree.op}${emit(tree.arg)})`
    if (tree.k === 'cond') return `(${emit(tree.test)} ? ${emit(tree.a)} : ${emit(tree.b)})`
    if (tree.k === 'member') return `${emit(tree.obj)}.${tree.name}`
    if (tree.k === 'call') {
      const args = tree.name === 'layer' && replacements.has(tree.args[0]?.v) ? [{ k: 'str', v: replacements.get(tree.args[0].v) }] : tree.args
      return `${tree.name}(${args.map(emit).join(', ')})`
    }
    fail('unsupported expression tree')
  }
  const rewritten = emit(parseExpr(expr))
  parseExpr(rewritten)
  return rewritten
}

function validateScope(clips, normalize = false) {
  const byId = new Map()
  for (const c of clips) {
    if (byId.has(c.id)) fail('duplicate clip ID')
    byId.set(c.id, c)
  }
  for (const c of clips) {
    for (const ref of [c.parent, c.matte?.source].filter(Boolean)) if (!byId.has(ref)) fail(`external layer dependency ${ref}; save its composition instead`)
    const seen = new Set([c.id]); let parent = c.parent
    while (parent) { if (seen.has(parent)) fail('parent cycle'); seen.add(parent); parent = byId.get(parent)?.parent }
    for (const [prop, expr] of Object.entries(c.expr ?? {})) {
      if (!animProp(prop, c)) fail(`invalid expression property ${prop}`)
      const replacements = new Map()
      for (const ref of layerRefs(expr)) {
        const matches = byId.has(ref) ? [byId.get(ref)] : clips.filter(x => x.label === ref || x.title?.text === ref)
        if (matches.length !== 1) fail(`unresolved or ambiguous expression layer ${ref}; save its composition instead`)
        replacements.set(ref, matches[0].id)
      }
      if (normalize) c.expr[prop] = rewriteExpr(expr, replacements)
    }
  }
}

function validateClip(c) {
  keys(c, CLIP_FIELDS, 'clip')
  if (!idOK(c.id) || !KINDS.includes(c.kind) || !Number.isFinite(c.start) || c.start < 0 || !positive(c.dur)) fail('invalid clip identity or timing')
  if (['video', 'image', 'audio'].includes(c.kind) && !pathOK(c.src)) fail('media clip needs a relative source path')
  if (c.kind === 'title' && (!obj(c.title) || typeof c.title.text !== 'string' || !positive(c.title.size))) fail('invalid title')
  if (c.kind === 'shape' && (!obj(c.shape) || !['rect', 'ellipse', 'polygon', 'star', 'line', 'path'].includes(c.shape.type))) fail('invalid shape')
  if (c.title) titleData(c.title)
  if (c.shape) shapeData(c.shape)
  if (c.grade) grade(c.grade)
  if (c.kind === 'comp' && !idOK(c.comp)) fail('composition clip needs a composition ID')
  if (c.source !== undefined) {
    keys(c.source, ['src', 'clip', 'from', 'to'], 'caption source')
    if (c.kind !== 'caption' || !pathOK(c.source.src) || c.source.clip !== undefined && !idOK(c.source.clip)) fail('invalid caption source')
    if (c.source.from !== undefined || c.source.to !== undefined) {
      if (!Number.isFinite(c.source.from) || c.source.from < 0 || !Number.isFinite(c.source.to) || c.source.to <= c.source.from) fail('invalid caption source timing')
    }
  }
  for (const field of ['x', 'y', 'anchorX', 'anchorY', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'volume', 'pan', 'in', 'freeze', 'blurAmount']) if (c[field] !== undefined && !Number.isFinite(c[field])) fail(`clip ${field} must be a number`)
  if (c.speed !== undefined && !positive(c.speed)) fail('speed must be positive')
  if (c.parentRef) {
    keys(c.parentRef, ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'anchorX', 'anchorY'], 'parent reference')
    if (!c.parent || !Object.values(c.parentRef).every(Number.isFinite)) fail('invalid parent reference')
  }
  if (c.matte && (!obj(c.matte) || !['alpha', 'alphaInverted', 'luma', 'lumaInverted'].includes(c.matte.mode))) fail('invalid matte')
  if (c.kind === 'multicam') {
    if (!Array.isArray(c.angles) || !c.angles.length || !c.angles.every(a => obj(a) && pathOK(a.src) && Number.isFinite(a.offset ?? 0))) fail('invalid multicam angles')
    if (!Array.isArray(c.cuts) || !c.cuts.every(cut => obj(cut) && Number.isFinite(cut.t) && Number.isInteger(cut.angle) && cut.angle >= 0 && cut.angle < c.angles.length)) fail('invalid multicam cuts')
  }
  if (c.effects) validateEffects(c.effects)
  if (c.nodes) validateGraph(c.nodes)
  if (c.masks) {
    if (!Array.isArray(c.masks)) fail('masks must be an array')
    const ids = new Set()
    for (const m of c.masks) {
      keys(m, 'id type mode feather expansion opacity inverted x y w h radius path'.split(' '), 'mask')
      if (!idOK(m.id) || ids.has(m.id) || !['rect', 'ellipse', 'path'].includes(m.type)) fail('invalid mask')
      if (m.mode !== undefined && !['add', 'subtract', 'intersect'].includes(m.mode) || m.inverted !== undefined && typeof m.inverted !== 'boolean') fail('invalid mask mode')
      numbers(m, ['x', 'y', 'w', 'h', 'radius', 'feather', 'expansion', 'opacity'], 'mask')
      if (m.path) pathData(m.path)
      ids.add(m.id)
    }
  }
  if (c.anim) validateAnim(c.anim, c)
  if (c.expr && !obj(c.expr)) fail('expressions must be a property map')
  if (c.transitionIn && (!TRANSITIONS.includes(c.transitionIn.type) || !positive(c.transitionIn.dur))) fail('invalid transition')
}

function dependencyPaths(body, kind) {
  const paths = new Set()
  const scan = v => {
    if (Array.isArray(v)) { v.forEach(scan); return }
    if (!obj(v)) return
    for (const [key, value] of Object.entries(v)) {
      if ((kind ? key === kind : ['src', 'lut'].includes(key)) && typeof value === 'string' && value) {
        if (!pathOK(value)) fail('dependencies need relative project paths')
        paths.add(value)
      } else if (obj(value) || Array.isArray(value)) scan(value)
    }
  }
  scan(body.clip); scan(body.comps); scan(body.settings)
  return paths
}

function validateLUTResources(resources, paths) {
  if (!obj(resources) || paths.size > 32) fail('LUT resources need a dependency map with at most 32 files')
  for (const path of paths) if (!obj(resources[path])) fail(`inspect LUT dependency ${path} before saving`)
  for (const [path, resource] of Object.entries(resources)) {
    if (!pathOK(path) || !/\.cube$/i.test(path) || !paths.has(path)) fail('unreferenced or unsafe LUT resource')
    keys(resource, ['type', 'size', 'sourceHash'], 'LUT resource')
    if (resource.type !== 'lut' || !Number.isInteger(resource.size) || resource.size < 2 || resource.size > 256 ||
        typeof resource.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(resource.sourceHash)) fail('LUT resources need inspected CUBE size and SHA256')
  }
}

// Hosts inspect these files before admitting the edit. LUTs stay separate from Media.
export function libraryLUTDependencies(p, op) {
  if (!['library_save', 'library_register', 'library_apply'].includes(op?.op)) return []
  const body = op.op === 'library_save' ? snapshotBody(p, op) : op.op === 'library_register' ? op.item?.body : p.library?.items?.find(item => item.id === op.item)?.body
  if (!body) fail('item does not exist')
  const paths = dependencyPaths(body, 'lut')
  if ([...paths].some(path => !/\.cube$/i.test(path))) fail('LUT resources need CUBE project paths')
  if (paths.size > 32) fail('a component supports at most 32 LUT files')
  const resources = op.op === 'library_save' ? op.resources : body.resources
  if (resources !== undefined || op.op !== 'library_save') validateLUTResources(resources ?? {}, paths)
  return [...paths].sort().map(path => ({ path, ...(resources?.[path]?.sourceHash === undefined ? {} : { sourceHash: resources[path].sourceHash, size: resources[path].size }) }))
}

function validateProvenance(value) {
  keys(value, ['format', 'version', 'imports'], 'provenance')
  if (value.format !== 'arya-component' || value.version !== 1) fail('unsupported component provenance')
  if (!Array.isArray(value.imports) || !value.imports.length || value.imports.length > 32) fail('component provenance needs 1 to 32 import receipts')
  const digest = text => typeof text === 'string' && /^[a-f0-9]{64}$/.test(text)
  for (const receipt of value.imports) {
    keys(receipt, ['sourceItemID', 'sourceProjectName', 'sourceProjectVersion', 'exportedAt', 'itemSHA256', 'packageSHA256'], 'import receipt')
    if (!idOK(receipt.sourceItemID)) fail('invalid source component ID')
    if (typeof receipt.sourceProjectName !== 'string' || !receipt.sourceProjectName.trim() || receipt.sourceProjectName.length > 512) fail('source project name needs 1 to 512 characters')
    if (!Number.isSafeInteger(receipt.sourceProjectVersion) || receipt.sourceProjectVersion < 0) fail('source project version must be a nonnegative safe integer')
    if (typeof receipt.exportedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(receipt.exportedAt)) fail('export time must be a UTC ISO 8601 timestamp')
    const exportedAt = Date.parse(receipt.exportedAt)
    if (!Number.isFinite(exportedAt) || new Date(exportedAt).toISOString().slice(0, 19) !== receipt.exportedAt.slice(0, 19)) fail('export time must be a valid UTC date')
    if (!digest(receipt.itemSHA256) || !digest(receipt.packageSHA256)) fail('component provenance needs SHA256 item and package digests')
  }
}

export function validateLibraryItem(item) {
  plain(item)
  if (JSON.stringify(item).length > 2 * 1024 * 1024) fail('component exceeds 2 MB')
  keys(item, ['id', 'name', 'description', 'category', 'body', 'provenance'], 'item')
  if (item.provenance !== undefined) validateProvenance(item.provenance)
  if (item.id !== undefined && !idOK(item.id)) fail('invalid item ID')
  if (typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120) fail('name must contain 1 to 120 characters')
  if (item.description !== undefined && (typeof item.description !== 'string' || item.description.length > 2000)) fail('description must be at most 2000 characters')
  if (!LIBRARY_CATEGORIES.includes(item.category)) fail('unknown category')
  const b = item.body
  keys(b, ['clip', 'composition', 'comps', 'assets', 'resources', 'settings'], 'body')
  if (b.comps !== undefined && !obj(b.comps)) fail('compositions must be a dependency map')
  if (libraryPlacesObject(item) || item.category === 'transition' && isPlacementBody(item)) {
    if (b.settings || !!b.clip === !!b.composition) fail('placement needs one clip or composition')
    if (b.clip) {
      if (!['title', 'comp'].includes(b.clip.kind) || ['composition', 'transition', 'effect'].includes(item.category) && b.clip.kind !== 'comp') fail('placement component needs a title layer or composition clip')
      validateClip(b.clip); validateScope([b.clip], true)
      if (b.clip.matte && !b.clip.matte.source) fail('implicit track matte needs its composition')
      if (b.clip.transitionIn) fail('a title with a transition needs its composition')
    }
    if (b.composition && (!idOK(b.composition) || !b.comps?.[b.composition])) fail('missing root composition')
  } else {
    if (b.clip || b.composition || b.comps && Object.keys(b.comps).length) fail('target components cannot contain layers')
    if (item.category === 'effect') {
      keys(b.settings, ['effects', 'nodes', 'grade', 'anim', 'dur'], 'effect settings')
      validateEffects(b.settings.effects ?? [])
      if (b.settings.nodes) validateGraph(b.settings.nodes)
      if (b.settings.grade) grade(b.settings.grade)
      if (!(b.settings.effects?.length || b.settings.nodes || b.settings.grade && Object.keys(b.settings.grade).length)) fail('no effects to save')
      if (b.settings.dur !== undefined && !positive(b.settings.dur)) fail('effect source duration must be positive')
      if (b.settings.anim) {
        if (!positive(b.settings.dur)) fail('effect animation needs a positive source duration')
        validateAnim(b.settings.anim, { kind: 'adjustment', dur: b.settings.dur, nodes: b.settings.nodes })
        for (const frames of Object.values(b.settings.anim)) retimeFrames(frames, b.settings.dur, b.settings.dur)
      }
    } else if (item.category === 'motion') {
      keys(b.settings, ['anim', 'dur', 'kind'], 'motion settings')
      if (!KINDS.includes(b.settings.kind) || !positive(b.settings.dur) || !Object.keys(b.settings.anim ?? {}).length) fail('no keyframes to save')
      // Mask and node motion depends on those objects. Save an effect or composition.
      validateAnim(b.settings.anim, { kind: b.settings.kind, dur: b.settings.dur })
      for (const frames of Object.values(b.settings.anim)) retimeFrames(frames, b.settings.dur, b.settings.dur)
    } else {
      keys(b.settings, ['transitionIn'], 'transition settings')
      const t = b.settings.transitionIn
      if (!obj(t) || !TRANSITIONS.includes(t.type) || !positive(t.dur)) fail('invalid transition')
      keys(t, ['type', 'dur'], 'transition')
    }
  }
  const globalIds = new Set(Object.keys(b.comps ?? {}))
  if (b.clip) { if (globalIds.has(b.clip.id)) fail('duplicate object ID'); globalIds.add(b.clip.id) }
  for (const [id, c] of Object.entries(b.comps ?? {})) {
    keys(c, ['id', 'name', 'width', 'height', 'fps', 'duration', 'background', 'tracks', 'colorSpace', 'note', 'markers'], 'composition')
    if (!idOK(id) || c.id !== id || !positive(c.width) || !positive(c.height) || !positive(c.fps) || c.duration !== undefined && !positive(c.duration) || !Array.isArray(c.tracks)) fail('invalid composition')
    if (c.markers !== undefined && !Array.isArray(c.markers)) fail('composition markers must be an array')
    for (const marker of c.markers ?? []) {
      keys(marker, ['id', 't', 'label', 'color', 'kind', 'note', 'dur'], 'marker')
      if (!idOK(marker.id) || !Number.isFinite(marker.t) || marker.t < 0 || marker.t >= 1000000 ||
          typeof marker.label !== 'string' || marker.color !== undefined && typeof marker.color !== 'string' ||
          marker.note !== undefined && typeof marker.note !== 'string' || marker.kind !== undefined && !['marker', 'chapter', 'todo'].includes(marker.kind) ||
          marker.dur !== undefined && !positive(marker.dur)) fail('invalid marker')
      if (globalIds.has(marker.id)) fail('duplicate marker ID')
      globalIds.add(marker.id)
    }
    const trackIds = new Set()
    for (const track of c.tracks) {
      keys(track, ['id', 'kind', 'name', 'muted', 'hidden', 'locked', 'volume', 'pan', 'solo', 'burnIn', 'style', 'clips'], 'track')
      if (!idOK(track.id) || trackIds.has(track.id) || !['video', 'audio', 'caption'].includes(track.kind) || !Array.isArray(track.clips)) fail('invalid track')
      trackIds.add(track.id)
      for (const clip of track.clips) { validateClip(clip); if (globalIds.has(clip.id)) fail('duplicate clip ID'); globalIds.add(clip.id) }
    }
    validateScope(clipsIn(c.tracks), true)
  }
  const visiting = new Set(), visited = new Set()
  const visit = id => {
    if (visiting.has(id)) fail('composition cycle')
    if (visited.has(id)) return
    const comp = b.comps?.[id]; if (!comp) fail(`missing composition dependency ${id}`)
    visiting.add(id)
    for (const clip of clipsIn(comp.tracks)) if (clip.kind === 'comp') visit(clip.comp)
    visiting.delete(id); visited.add(id)
  }
  if (b.composition) visit(b.composition)
  if (b.clip?.kind === 'comp') visit(b.clip.comp)
  if (Object.keys(b.comps ?? {}).some(id => !visited.has(id))) fail('unreferenced composition dependency')
  if (b.assets !== undefined && !obj(b.assets)) fail('assets must be a dependency map')
  const paths = dependencyPaths(b, 'src')
  const luts = dependencyPaths(b, 'lut')
  validateLUTResources(b.resources ?? {}, luts)
  for (const path of paths) if (!obj(b.assets?.[path])) fail(`missing asset dependency ${path}`)
  for (const [path, asset] of Object.entries(b.assets ?? {})) {
    if (!pathOK(path) || !paths.has(path)) fail('unreferenced or unsafe asset dependency')
    if (asset.proxy !== undefined && !pathOK(asset.proxy)) fail('unsafe proxy path')
  }
  return item
}

function find(p, id, scope) {
  const timelines = scope === undefined
    ? [[null, { tracks: rootTracks(p) }], ...Object.entries(p.comps ?? {})]
    : [[scope, scope === null ? { tracks: rootTracks(p) } : p.comps?.[scope]]]
  const found = []
  const seenTracks = new Set()
  for (const [comp, timeline] of timelines) for (const track of timeline?.tracks ?? []) {
    if (seenTracks.has(track)) continue
    seenTracks.add(track)
    for (const clip of track.clips) if (clip.id === id) found.push({ clip, track, comp })
  }
  if (found.length > 1) fail('ambiguous clip ID; choose a unique clip in an explicit composition')
  return found[0] ?? null
}

export function describeLibraryItem(item) {
  const b = item.body ?? {}
  if (b.composition || b.clip?.kind === 'comp') {
    const layers = Object.values(b.comps ?? {}).reduce((n, c) => n + clipsIn(c.tracks).length, 0)
    return `Editable ${item.category === 'transition' ? 'transition composition' : item.category === 'effect' ? 'effect composition' : 'composition'}, ${Object.keys(b.comps ?? {}).length} composition${Object.keys(b.comps ?? {}).length === 1 ? '' : 's'}, ${layers} layer${layers === 1 ? '' : 's'}`
  }
  if (b.clip) return `Editable title, ${b.clip.title?.font ?? 'system font'}, ${b.clip.dur}s`
  if (item.category === 'motion') return `Keyframes for ${Object.keys(b.settings?.anim ?? {}).join(', ')}, ${b.settings?.dur}s source timing`
  if (item.category === 'transition') return `${b.settings?.transitionIn?.type ?? 'Transition'}, ${b.settings?.transitionIn?.dur}s`
  return `${b.settings?.effects?.length ?? 0} effects${b.settings?.nodes ? `, ${b.settings.nodes.list.length} nodes` : ''}${b.settings?.grade ? ', saved grade' : ''}`
}

export function libraryCompatibility(p, item, targetId, scope) {
  try {
    validateLibraryItem(clone(item))
    if (libraryPlacesObject(item)) return { ok: true, reason: '' }
    const found = find(p, targetId, scope)
    if (!found) fail('select a target clip')
    const c = found.clip
    if (found.track.locked) fail('target track is locked')
    if (!positive(c.dur)) fail('target duration must be positive')
    if (item.category === 'motion') {
      for (const prop of Object.keys(item.body.settings.anim)) {
        if (!animProp(prop, c)) fail(`${prop} is incompatible with ${c.kind}`)
        if (c.anim?.[prop]?.length || c.expr?.[prop]) fail(`${prop} already has animation; existing animation is preserved`)
        retimeFrames(item.body.settings.anim[prop], item.body.settings.dur, c.dur)
      }
    } else {
      if (!VISUAL.includes(c.kind)) fail('select a visual clip')
      if (item.category === 'effect') for (const frames of Object.values(item.body.settings.anim ?? {})) retimeFrames(frames, item.body.settings.dur, c.dur)
      if (item.category === 'transition') {
        if (c.transitionIn) fail('target already has a transition')
        const previous = found.track.clips.find(other => other !== c && VISUAL.includes(other.kind) && Math.abs(other.start + other.dur - c.start) < 1e-4)
        if (!previous) fail('transition needs an adjacent preceding visual clip')
        if (isPlacementBody(item) && bodyDuration(item.body) / 2 > Math.min(previous.dur, c.dur) + 1e-4) fail('transition composition needs room on both sides of the cut; shorten its source clip or composition')
      }
    }
    return { ok: true, reason: '' }
  } catch (error) { return { ok: false, reason: error.message } }
}

function snapshotBody(p, op) {
  keys(op.source, ['clip', 'composition', 'type'], 'source')
  if (!!op.source.clip === !!op.source.composition) fail('choose one source clip or composition')
  const selected = op.source.clip ? find(p, op.source.clip, op.comp)?.clip : null
  if (op.source.clip && !selected) fail('source clip does not exist')
  if (op.source.type !== undefined && !(op.category === 'effect' && op.source.type === 'composition' && selected?.kind === 'comp')) fail('composition source type needs an effect composition clip')
  const effectComposition = op.category === 'effect' && (op.source.composition || op.source.type === 'composition')
  if (effectComposition && op.index !== undefined) fail('a composition effect cannot select one stack effect')
  const body = { assets: {} }
  if (['title', 'composition'].includes(op.category) || effectComposition || op.category === 'transition' && (op.source.composition || selected?.kind === 'comp')) {
    const compId = op.source.composition ?? (selected?.kind === 'comp' ? selected.comp : null)
    if (compId) {
      if (selected?.kind === 'comp') { body.clip = clone(selected); body.clip.start = 0; delete body.clip.link }
      else body.composition = compId
      body.comps = {}
      const copy = id => {
        if (Object.hasOwn(body.comps, id)) return
        if (!p.comps?.[id]) fail('source composition does not exist')
        body.comps[id] = clone(p.comps[id])
        for (const clip of clipsIn(p.comps[id].tracks)) if (clip.kind === 'comp') copy(clip.comp)
      }
      copy(compId)
    } else if (op.category === 'title' && selected?.kind === 'title') {
      body.clip = clone(selected); body.clip.start = 0
      delete body.clip.link
    } else fail('select a title layer or composition')
  } else {
    if (!selected || op.source.composition) fail('select a source clip')
    if (op.category === 'motion') body.settings = { anim: clone(selected.anim ?? {}), dur: selected.dur, kind: selected.kind }
    else if (op.category === 'transition') body.settings = { transitionIn: clone(selected.transitionIn) }
    else if (op.category === 'effect') {
      if (!VISUAL.includes(selected.kind)) fail('select a visual source clip')
      if (op.index !== undefined && (!Number.isInteger(op.index) || !selected.effects?.[op.index])) fail('effect index does not exist')
      body.settings = { effects: clone(op.index === undefined ? selected.effects ?? [] : [selected.effects[op.index]]) }
      if (op.index === undefined) {
        if (selected.nodes) body.settings.nodes = clone(selected.nodes)
        if (selected.grade) body.settings.grade = clone(selected.grade)
        const nodeAnim = Object.fromEntries(Object.entries(selected.anim ?? {}).filter(([prop]) => prop.startsWith('node.')))
        if (Object.keys(nodeAnim).length) { body.settings.anim = clone(nodeAnim); body.settings.dur = selected.dur }
        if (Object.keys(selected.expr ?? {}).some(prop => prop.startsWith('node.'))) fail('node expressions need a composition component')
      }
    }
  }
  return body
}

function snapshot(p, op) {
  const body = snapshotBody(p, op)
  const luts = dependencyPaths(body, 'lut')
  validateLUTResources(op.resources ?? {}, luts)
  if (luts.size) body.resources = clone(op.resources)
  for (const path of dependencyPaths(body, 'src')) {
    if (!obj(p.assets?.[path])) fail(`import dependency ${path} before saving`)
    body.assets[path] = clone(p.assets[path])
  }
  return { name: op.name, description: op.description ?? '', category: op.category, body }
}

function allocator(p) {
  const used = new Set([...allClips(p).flatMap(c => [c.id, c.link, ...(c.nodes?.list ?? []).map(n => n.id), ...(c.masks ?? []).map(m => m.id)]), ...Object.keys(p.comps ?? {}), ...(p.library?.items ?? []).map(i => i.id), ...(p.__rootMarkers ?? p.markers ?? []).map(m => m.id), ...Object.values(p.comps ?? {}).flatMap(c => (c.markers ?? []).map(m => m.id))])
  return prefix => { let n = 1; while (used.has(`${prefix}${n}`)) n++; const id = `${prefix}${n}`; used.add(id); return id }
}

function remapClip(c, ids, fresh, links) {
  const old = c.id; c.id = ids.get(old)
  if (c.parent) c.parent = ids.get(c.parent)
  if (c.matte?.source) c.matte.source = ids.get(c.matte.source)
  if (c.comp) c.comp = ids.get(c.comp)
  if (c.source?.clip && ids.has(c.source.clip)) c.source.clip = ids.get(c.source.clip)
  if (c.link) { if (!links.has(c.link)) links.set(c.link, fresh('L')); c.link = links.get(c.link) }
  const local = new Map()
  for (const m of c.masks ?? []) { const id = fresh('mk'); local.set(`mask.${m.id}.`, `mask.${id}.`); m.id = id }
  for (const n of c.nodes?.list ?? []) { const id = fresh('n'); local.set(`node.${n.id}.`, `node.${id}.`); local.set(n.id, id); n.id = id }
  for (const l of c.nodes?.links ?? []) { l.from = local.get(l.from); l.to = local.get(l.to) }
  const remapProp = prop => { for (const [before, after] of local) if (prop.startsWith(before) && before.includes('.')) return after + prop.slice(before.length); return prop }
  if (c.anim) c.anim = Object.fromEntries(Object.entries(c.anim).map(([prop, keys]) => [remapProp(prop), keys]))
  if (c.expr) c.expr = Object.fromEntries(Object.entries(c.expr).map(([prop, expr]) => [remapProp(prop), rewriteExpr(expr, ids)]))
}

function applyEffect(c, settings, fresh) {
  c.effects = [...(c.effects ?? []), ...clone(settings.effects ?? [])]
  if (!settings.nodes && !settings.grade) return []
  const graph = c.nodes ?? { list: [{ id: 'n1', type: 'source' }, { id: 'n2', type: 'primary' }, { id: 'n3', type: 'output' }], links: [{ from: 'n1', to: 'n2', input: 0 }, { from: 'n2', to: 'n3', input: 0 }] }
  validateGraph(graph)
  const out = graph.list.find(n => n.type === 'output'), feed = graph.links.find(l => l.to === out.id && l.input === 0)?.from
  if (!feed) fail('target output needs a connected input')
  const used = new Set(graph.list.map(n => n.id))
  const newIds = []
  const nodeId = () => { let id; do { id = fresh('n') } while (used.has(id)); used.add(id); newIds.push(id); return id }
  const right = Math.max(0, ...graph.list.map(n => Number.isFinite(n.x) ? n.x : 0)) + 160
  let next = feed
  const map = new Map()
  if (settings.nodes) {
    const source = settings.nodes.list.find(n => n.type === 'source'), savedOut = settings.nodes.list.find(n => n.type === 'output')
    map.set(source.id, feed)
    for (const node of settings.nodes.list) if (!['source', 'output'].includes(node.type)) {
      const n = clone(node); n.id = nodeId(); map.set(node.id, n.id)
      n.x = right + (newIds.length - 1) * 160; n.y ??= 0
      if (n.type === 'primary') { n.type = 'corrector'; n.grade = clone(settings.grade ?? {}) }
      graph.list.push(n)
    }
    const outputFeed = settings.nodes.links.find(l => l.to === savedOut.id && l.input === 0)?.from
    if (!map.has(outputFeed)) fail('saved output needs a connected input')
    next = map.get(outputFeed)
    for (const l of settings.nodes.links) if (l.to !== savedOut.id) graph.links.push({ ...l, from: map.get(l.from), to: map.get(l.to) })
    if (settings.anim) {
      c.anim ??= {}
      for (const [prop, frames] of Object.entries(settings.anim)) {
        const match = /^node\.([A-Za-z0-9_-]+)\.(.*)$/.exec(prop)
        if (!match || !map.has(match[1])) fail('effect animation has no node')
        const mapped = `node.${map.get(match[1])}.${match[2]}`
        c.anim[mapped] = retimeFrames(frames, settings.dur, c.dur)
      }
    }
  } else {
    const id = nodeId(); graph.list.push({ id, type: 'corrector', x: right, y: 0, grade: clone(settings.grade) }); graph.links.push({ from: feed, to: id, input: 0 }); next = id
  }
  graph.links = graph.links.filter(l => !(l.to === out.id && l.input === 0))
  graph.links.push({ from: next, to: out.id, input: 0 }); c.nodes = graph
  return newIds
}

export function applyLibraryOp(p, op, ctx) {
  if (!op.op?.startsWith('library_')) return false
  p.library ??= { version: LIBRARY_VERSION, items: [] }
  if (p.library.version !== LIBRARY_VERSION || !Array.isArray(p.library.items)) fail('unsupported project library')
  const { created, log } = ctx, fresh = allocator(p)
  if (op.op === 'library_save' || op.op === 'library_register') {
    if (p.library.items.length >= 256) fail('project library is full')
    const item = clone(op.op === 'library_save' ? snapshot(p, op) : op.item)
    validateLibraryItem(item)
    for (const [path, asset] of Object.entries(item.body.assets ?? {})) {
      if (!obj(p.assets?.[path]) || !sameData(p.assets[path], asset)) fail(`dependency ${path} must match imported project media`)
    }
    item.id ??= fresh('lib')
    if (p.library.items.some(i => i.id === item.id) || allClips(p).some(c => c.id === item.id) || Object.hasOwn(p.comps ?? {}, item.id)) fail('duplicate library item ID')
    item.name = item.name.trim(); item.description ??= ''
    p.library.items.push(item); created.push(item.id); log.push(`saved ${item.category} "${item.name}" as ${item.id}`)
    return true
  }
  const item = p.library.items.find(i => i.id === op.item)
  if (!item) fail('item does not exist')
  if (op.op === 'library_remove') { p.library.items = p.library.items.filter(i => i !== item); log.push(`removed library item "${item.name}"`); return true }
  if (op.op === 'library_rename') {
    const candidate = { ...clone(item), name: op.name, ...(op.description === undefined ? {} : { description: op.description }) }
    validateLibraryItem(candidate); item.name = candidate.name.trim(); item.description = candidate.description
    log.push(`renamed library item ${item.id} to "${item.name}"`); return true
  }
  if (op.op !== 'library_apply') fail(`unknown operation ${op.op}`)
  const compatible = libraryCompatibility(p, item, op.id, op.comp)
  if (!compatible.ok) fail(compatible.reason.replace(/^Library: /, ''))
  if (!libraryPlacesObject(item) && !p.tracks.includes(find(p, op.id, op.comp).track)) fail('target clip is outside the operation composition')
  const normalized = clone(item)
  validateLibraryItem(normalized)
  for (const [path, asset] of Object.entries(item.body.assets ?? {})) if (!p.assets[path]) p.assets[path] = clone(asset)
  if (libraryPlacesObject(item) || item.category === 'transition' && isPlacementBody(item)) {
    const transition = item.category === 'transition'
    const duration = bodyDuration(normalized.body)
    const target = transition ? find(p, op.id, op.comp) : null
    const start = transition ? ctx.snapToFrame(target.clip.start - duration / 2, p.fps) : op.start ?? 0
    let track
    if (transition) {
      const index = p.tracks.indexOf(target.track)
      const free = t => t.kind === 'video' && !t.locked && !t.clips.some(c => c.start < start + duration - 1e-6 && c.start + c.dur > start + 1e-6)
      if (op.track) {
        track = p.tracks.find(t => t.id === op.track)
        if (!track || p.tracks.indexOf(track) <= index || !free(track)) fail('custom transition needs a free unlocked video track above its target')
      } else track = p.tracks.slice(index + 1).find(free)
      if (!track) {
        let n = 1; while (p.tracks.some(t => t.id === `V${n}`)) n++
        track = { id: `V${n}`, kind: 'video', name: 'Transitions', clips: [] }
        p.tracks.splice(p.tracks.map(t => t.kind).lastIndexOf('video') + 1, 0, track)
        created.push(track.id)
      }
    } else track = p.tracks.find(t => t.id === (op.track ?? [...p.tracks].reverse().find(t => t.kind === 'video' && !t.locked)?.id))
    if (!track || track.kind !== 'video' || track.locked) fail('placement needs an unlocked video track')
    if (!Number.isFinite(start) || start < 0 || start >= 1000000) fail('invalid placement time')
    const body = normalized.body, ids = new Map(), links = new Map()
    for (const id of Object.keys(body.comps ?? {})) ids.set(id, fresh('k'))
    for (const comp of Object.values(body.comps ?? {})) for (const clip of clipsIn(comp.tracks)) ids.set(clip.id, fresh('c'))
    if (body.clip) ids.set(body.clip.id, fresh('c'))
    for (const comp of Object.values(body.comps ?? {})) {
      comp.id = ids.get(comp.id)
      for (const marker of comp.markers ?? []) { marker.id = fresh('m'); created.push(marker.id) }
      for (const clip of clipsIn(comp.tracks)) remapClip(clip, ids, fresh, links)
      p.comps[comp.id] = comp; created.push(comp.id)
      for (const clip of clipsIn(comp.tracks)) created.push(clip.id)
    }
    let clip = body.clip
    if (clip) remapClip(clip, ids, fresh, links)
    else {
      const comp = p.comps[ids.get(body.composition)]
      clip = { id: fresh('c'), kind: 'comp', comp: comp.id, start: 0, in: 0, dur: duration, label: item.name }
    }
    clip.start = ctx.snapToFrame(start, p.fps)
    track.clips.push(clip); track.clips.sort((a, b) => a.start - b.start); created.push(clip.id)
  } else {
    const c = find(p, op.id, op.comp).clip
    if (item.category === 'effect') created.push(...applyEffect(c, item.body.settings, fresh))
    else if (item.category === 'motion') {
      c.anim ??= {}
      for (const [prop, keys] of Object.entries(item.body.settings.anim)) c.anim[prop] = retimeFrames(keys, item.body.settings.dur, c.dur, ctx.round)
    } else c.transitionIn = clone(item.body.settings.transitionIn)
  }
  log.push(`applied library item "${item.name}"${op.id ? ` to ${op.id}` : ''}`)
  return true
}

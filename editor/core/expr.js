// Reel expressions: a small, deterministic language for driving a property from time
// and other values, in the spirit of After Effects expressions. It is parsed, never
// evaluated as JavaScript, so a project file cannot run code. Numbers only.
//
//   value + wiggle(2, 30)            sin(time * 2) * 100 + 960
//   linear(time, 0, 1, 0, 360)       loopOut("cycle")
//   layer("Logo").x + 200            time > 2 ? 1 : 0
//
// Grammar (precedence low → high):
//   expr    := cond
//   cond    := or ('?' expr ':' expr)?
//   or      := and ('||' and)*          and := cmp ('&&' cmp)*
//   cmp     := add (('<'|'<='|'>'|'>='|'=='|'!=') add)?
//   add     := mul (('+'|'-') mul)*      mul := unary (('*'|'/'|'%') unary)*
//   unary   := ('-'|'!'|'+') unary | pow   pow := call ('^' unary)?
//   call    := primary ('(' args ')')? ('.' ident)*
//   primary := number | string | ident | '(' expr ')'

const MAX_LEN = 2000
const MAX_STEPS = 20000

function tokenize(src) {
  const out = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(src.slice(i))
      if (!m) throw new Error(`bad number at ${i}`)
      out.push({ t: 'num', v: Number(m[0]) })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
      out.push({ t: 'id', v: m[0] })
      i += m[0].length
      continue
    }
    if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1)
      if (end < 0) throw new Error('unterminated string')
      out.push({ t: 'str', v: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    const two = src.slice(i, i + 2)
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if ('+-*/%^()<>!?:,.'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    throw new Error(`unexpected "${c}" at ${i}`)
  }

  return out
}

/** Parses an expression into a tree; throws a readable error. Results are cached. */
const cache = new Map()
export function parse(src) {
  if (typeof src !== 'string' || src.length > MAX_LEN) throw new Error('expression too long')
  if (cache.has(src)) return cache.get(src)
  const toks = tokenize(src)
  let p = 0
  const peek = v => toks[p] && toks[p].t === 'op' && toks[p].v === v
  const eat = v => {
    if (!peek(v)) throw new Error(`expected "${v}"`)
    p++
  }
  const expr = () => cond()
  const cond = () => {
    const test = or()
    if (peek('?')) {
      p++
      const a = expr()
      eat(':')
      const b = expr()

      return { k: 'cond', test, a, b }
    }

    return test
  }
  const bin = (next, ops) => () => {
    let left = next()
    while (toks[p] && toks[p].t === 'op' && ops.includes(toks[p].v)) {
      const op = toks[p++].v
      left = { k: 'bin', op, left, right: next() }
    }

    return left
  }
  const unary = () => {
    if (peek('-') || peek('!') || peek('+')) {
      const op = toks[p++].v

      return { k: 'un', op, arg: unary() }
    }

    return pow()
  }
  const mul = bin(unary, ['*', '/', '%'])
  const add = bin(mul, ['+', '-'])
  const cmp = bin(add, ['<', '<=', '>', '>=', '==', '!='])
  const and = bin(cmp, ['&&'])
  const or = bin(and, ['||'])
  function pow() {
    const base = call()
    if (peek('^')) {
      p++

      return { k: 'bin', op: '^', left: base, right: unary() }
    }

    return base
  }
  function call() {
    let node = primary()
    if (peek('(')) {
      if (node.k !== 'id') throw new Error('only named functions can be called')
      p++
      const args = []
      if (!peek(')')) {
        args.push(expr())
        while (peek(',')) {
          p++
          args.push(expr())
        }
      }
      eat(')')
      node = { k: 'call', name: node.v, args }
    }
    while (peek('.')) {
      p++
      const t = toks[p++]
      if (!t || t.t !== 'id') throw new Error('expected a property name after "."')
      node = { k: 'member', obj: node, name: t.v }
    }

    return node
  }
  function primary() {
    const t = toks[p++]
    if (!t) throw new Error('unexpected end')
    if (t.t === 'num') return { k: 'num', v: t.v }
    if (t.t === 'str') return { k: 'str', v: t.v }
    if (t.t === 'id') return { k: 'id', v: t.v }
    if (t.t === 'op' && t.v === '(') {
      const e = expr()
      eat(')')

      return e
    }
    throw new Error(`unexpected "${t.v}"`)
  }
  const tree = expr()
  if (p !== toks.length) throw new Error(`unexpected "${toks[p].v}"`)
  if (cache.size > 2000) cache.clear()
  cache.set(src, tree)

  return tree
}

// Deterministic noise: smooth 1D value noise from a hashed lattice.
function hash(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453

  return x - Math.floor(x)
}
function noise1(x) {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)

  return (hash(i) * (1 - u) + hash(i + 1) * u) * 2 - 1
}

/**
 * Evaluates an expression. `ctx` provides:
 *   time, value, fps, frame, index, width, height (numbers)
 *   valueAtTime(t) → number                    (this property's keyed value)
 *   keys → [[t, v], ...]                        (this property's keyframes, for loopOut)
 *   layer(name) → { x, y, scale, rotation, opacity, ... } (another layer's values now)
 *   seed (number, per layer)
 */
export function evaluate(src, ctx) {
  const tree = parse(src)
  let steps = 0
  const num = v => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return 0

    return v
  }
  const fns = Object.assign(Object.create(null), {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
    abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil, round: Math.round, sqrt: Math.sqrt,
    pow: Math.pow, exp: Math.exp, log: Math.log, sign: Math.sign,
    clamp: (x, a, b) => Math.min(Math.max(x, Math.min(a, b)), Math.max(a, b)),
    degreesToRadians: d => (d * Math.PI) / 180,
    radiansToDegrees: r => (r * 180) / Math.PI,
    linear: (t, t0, t1, v0, v1) => (t1 === t0 ? v1 : v0 + (v1 - v0) * Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))),
    ease: (t, t0, t1, v0, v1) => {
      const x = t1 === t0 ? 1 : Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))

      return v0 + (v1 - v0) * x * x * (3 - 2 * x)
    },
    easeIn: (t, t0, t1, v0, v1) => {
      const x = t1 === t0 ? 1 : Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))

      return v0 + (v1 - v0) * x * x
    },
    easeOut: (t, t0, t1, v0, v1) => {
      const x = t1 === t0 ? 1 : Math.min(1, Math.max(0, (t - t0) / (t1 - t0)))

      return v0 + (v1 - v0) * (1 - (1 - x) * (1 - x))
    },
    noise: x => noise1(x),
    random: (a = 0, b = 1) => a + (b - a) * hash((ctx.seed ?? 0) * 13.37 + Math.floor((ctx.time ?? 0) * (ctx.fps ?? 30))),
    wiggle: (freq, amp, octaves = 1) => {
      let v = 0
      let a = 1
      let f = freq
      let norm = 0
      for (let o = 0; o < Math.min(6, Math.max(1, octaves)); o++) {
        v += noise1((ctx.time ?? 0) * f + (ctx.seed ?? 0) * 17.17 + o * 31.7) * a
        norm += a
        a *= 0.5
        f *= 2
      }

      return num(ctx.value) + (v / norm) * amp
    },
    valueAtTime: t => num(ctx.valueAtTime?.(t) ?? ctx.value),
    loopOut: (kind = 'cycle') => {
      const keys = ctx.keys ?? []
      if (keys.length < 2) return num(ctx.value)
      const t0 = keys[0][0]
      const t1 = keys[keys.length - 1][0]
      const span = t1 - t0
      const t = ctx.time ?? 0
      if (t <= t1 || span <= 0) return num(ctx.value)
      const k = (t - t0) / span
      const cycles = Math.floor(k)
      let local = (t - t0) % span
      if (kind === 'pingpong' && cycles % 2 === 1) local = span - local
      if (kind === 'continue') return num(ctx.valueAtTime?.(t1)) + (num(ctx.valueAtTime?.(t1)) - num(ctx.valueAtTime?.(t1 - 1 / (ctx.fps ?? 30)))) * (t - t1) * (ctx.fps ?? 30)

      return num(ctx.valueAtTime?.(t0 + local))
    },
  })
  const strings = Object.assign(Object.create(null), { cycle: 'cycle', pingpong: 'pingpong', continue: 'continue' })
  const ev = n => {
    if (++steps > MAX_STEPS) throw new Error('expression too complex')
    switch (n.k) {
      case 'num':
        return n.v
      case 'str':
        return n.v
      case 'id': {
        if (n.v === 'PI') return Math.PI
        if (n.v === 'true') return 1
        if (n.v === 'false') return 0
        if (n.v in strings) return strings[n.v]
        const names = { time: ctx.time, value: ctx.value, fps: ctx.fps, frame: Math.round((ctx.time ?? 0) * (ctx.fps ?? 30)), index: ctx.index, width: ctx.width, height: ctx.height }
        const v = Object.hasOwn(names, n.v) ? names[n.v] : undefined
        if (v === undefined) throw new Error(`unknown name "${n.v}"`)

        return v
      }
      case 'un': {
        const a = ev(n.arg)

        return n.op === '-' ? -num(a) : n.op === '!' ? (num(a) ? 0 : 1) : num(a)
      }
      case 'bin': {
        if (n.op === '&&') return num(ev(n.left)) && num(ev(n.right)) ? 1 : 0
        if (n.op === '||') return num(ev(n.left)) || num(ev(n.right)) ? 1 : 0
        const a = num(ev(n.left))
        const b = num(ev(n.right))
        switch (n.op) {
          case '+': return a + b
          case '-': return a - b
          case '*': return a * b
          case '/': return b === 0 ? 0 : a / b
          case '%': return b === 0 ? 0 : a % b
          case '^': return Math.pow(a, b)
          case '<': return a < b ? 1 : 0
          case '<=': return a <= b ? 1 : 0
          case '>': return a > b ? 1 : 0
          case '>=': return a >= b ? 1 : 0
          case '==': return a === b ? 1 : 0
          case '!=': return a !== b ? 1 : 0
        }

        return 0
      }
      case 'cond':
        return num(ev(n.test)) ? ev(n.a) : ev(n.b)
      case 'call': {
        if (n.name === 'layer') {
          const name = ev(n.args[0])

          return ctx.layer?.(String(name)) ?? {}
        }
        const fn = Object.hasOwn(fns, n.name) ? fns[n.name] : undefined
        if (!fn) throw new Error(`unknown function "${n.name}"`)

        return fn(...n.args.map(a => {
          const v = ev(a)

          return typeof v === 'string' ? v : num(v)
        }))
      }
      case 'member': {
        const obj = ev(n.obj)
        if (obj && typeof obj === 'object' && Object.hasOwn(obj, n.name) && typeof obj[n.name] === 'number') return obj[n.name]
        throw new Error(`no property "${n.name}"`)
      }
    }

    return 0
  }

  return num(ev(tree))
}

/** Checks an expression without running it against a layer; returns an error message or null. */
export function check(src) {
  try {
    parse(src)
    evaluate(src, { time: 1, value: 0, fps: 30, index: 1, width: 1920, height: 1080, layer: () => ({ x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1, anchorX: 0, anchorY: 0 }), valueAtTime: () => 0, keys: [], seed: 1 })

    return null
  } catch (error) {
    return error.message
  }
}

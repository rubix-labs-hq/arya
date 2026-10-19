// Motion tracking and stabilization: grayscale pyramids, normalized cross-correlation
// template matching refined to sub-pixel by Lucas-Kanade, a point tracker with template
// update and drift correction, global motion from a grid of tracked points, camera path
// smoothing, and the keyframe math that turns tracks into transforms. The functions are
// pure (no DOM), so the worker and Node tests import them; TrackerClient runs the worker.
//
// Coordinates: pixel index convention (pixel i's center is at i). "Centered" coordinates
// put the origin at the image center ((w - 1) / 2, (h - 1) / 2), which is also where a
// clip's layer origin sits, and they scale exactly when an image is resized.

// ---------------------------------------------------------------- images and pyramids

export const image = (w, h, data = new Float32Array(w * h)) => ({ w, h, data })

/** Rec. 601 luma of RGBA pixels. */
export function grayFromRGBA(rgba, w, h) {
  const out = new Float32Array(w * h)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2]

  return image(w, h, out)
}

/** Binomial 5-tap blur, then every second pixel: level L+1 pixel j sits at level L pixel 2j. */
export function downsample(img) {
  const { w, h, data } = img
  const tmp = new Float32Array(w * h)
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16]
  const cx = x => (x < 0 ? 0 : x >= w ? w - 1 : x)
  const cy = y => (y < 0 ? 0 : y >= h ? h - 1 : y)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      tmp[row + x] = k[0] * data[row + cx(x - 2)] + k[1] * data[row + cx(x - 1)] + k[2] * data[row + x] + k[3] * data[row + cx(x + 1)] + k[4] * data[row + cx(x + 2)]
    }
  }
  const W = Math.max(1, Math.ceil(w / 2))
  const H = Math.max(1, Math.ceil(h / 2))
  const out = new Float32Array(W * H)
  for (let Y = 0; Y < H; Y++) {
    const y = 2 * Y
    for (let X = 0; X < W; X++) {
      const x = 2 * X
      out[Y * W + X] = k[0] * tmp[cy(y - 2) * w + x] + k[1] * tmp[cy(y - 1) * w + x] + k[2] * tmp[y * w + x] + k[3] * tmp[cy(y + 1) * w + x] + k[4] * tmp[cy(y + 2) * w + x]
    }
  }

  return image(W, H, out)
}

export function buildPyramid(img, levels) {
  const out = [img]
  for (let i = 1; i < levels; i++) out.push(downsample(out[i - 1]))

  return out
}

/** Bilinear sample, clamped at the edges. */
export function sample(img, x, y) {
  const { w, h, data } = img
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x
  y = y < 0 ? 0 : y > h - 1 ? h - 1 : y
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = x0 + 1 < w ? x0 + 1 : x0
  const y1 = y0 + 1 < h ? y0 + 1 : y0
  const fx = x - x0
  const fy = y - y0
  const a = data[y0 * w + x0]
  const b = data[y0 * w + x1]
  const c = data[y1 * w + x0]
  const d = data[y1 * w + x1]

  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy
}

/** A tw×th patch centered on (cx, cy), sampled bilinearly. */
export function patch(img, cx, cy, tw, th, out = new Float32Array(tw * th)) {
  const ox = cx - (tw - 1) / 2
  const oy = cy - (th - 1) / 2
  for (let j = 0; j < th; j++) for (let i = 0; i < tw; i++) out[j * tw + i] = sample(img, ox + i, oy + j)

  return out
}

function stats(a) {
  let s = 0
  let s2 = 0
  for (let i = 0; i < a.length; i++) {
    s += a[i]
    s2 += a[i] * a[i]
  }
  const mean = s / a.length

  return { mean, std: Math.sqrt(Math.max(0, s2 / a.length - mean * mean)) }
}

/** Normalized cross-correlation of two equal-size patches (−1…1). */
export function ncc(a, b) {
  const sa = stats(a)
  const sb = stats(b)
  if (sa.std < 1e-6 || sb.std < 1e-6) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] - sa.mean) * (b[i] - sb.mean)

  return s / (a.length * sa.std * sb.std)
}

/**
 * Exhaustive NCC search of template tpl (tw×th) for centers at integer positions within
 * ±r of (cx, cy). Returns the best center, refined to sub-pixel by a parabola through the
 * neighboring scores, and its score.
 */
export function nccSearch(img, tpl, tw, th, cx, cy, r) {
  const { w, h, data } = img
  const n = tw * th
  const ts = stats(tpl)
  if (ts.std < 1e-6) return { x: cx, y: cy, score: 0 }
  const tz = new Float32Array(n)
  for (let i = 0; i < n; i++) tz[i] = tpl[i] - ts.mean
  const tnorm = Math.sqrt(n) * ts.std
  const x0 = Math.round(cx)
  const y0 = Math.round(cy)
  const side = 2 * r + 1
  const scores = new Float32Array(side * side).fill(-2)
  const hx = (tw - 1) >> 1
  const hy = (th - 1) >> 1
  let best = -2
  let bi = 0
  let bj = 0
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const px = x0 + i - hx
      const py = y0 + j - hy
      let sIT = 0
      let sI = 0
      let sII = 0
      const inside = px >= 0 && py >= 0 && px + tw <= w && py + th <= h
      for (let v = 0; v < th; v++) {
        const yy = inside ? py + v : Math.min(h - 1, Math.max(0, py + v))
        const row = yy * w
        for (let u = 0; u < tw; u++) {
          const xx = inside ? px + u : Math.min(w - 1, Math.max(0, px + u))
          const I = data[row + xx]
          sIT += I * tz[v * tw + u]
          sI += I
          sII += I * I
        }
      }
      const varI = sII - (sI * sI) / n
      const score = varI > 1e-6 ? sIT / (Math.sqrt(varI) * tnorm) : 0
      scores[(j + r) * side + (i + r)] = score
      if (score > best) {
        best = score
        bi = i
        bj = j
      }
    }
  }
  const at = (i, j) => scores[(j + r) * side + (i + r)]
  const para = (a, b, c) => {
    const den = a - 2 * b + c

    return Math.abs(den) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0
  }
  const dx = bi > -r && bi < r ? para(at(bi - 1, bj), best, at(bi + 1, bj)) : 0
  const dy = bj > -r && bj < r ? para(at(bi, bj - 1), best, at(bi, bj + 1)) : 0

  return { x: x0 + bi + dx, y: y0 + bj + dy, score: best }
}

/** Gradients and the inverse Hessian of a template, for Lucas-Kanade refinement. */
export function lkPrepare(tpl, tw, th) {
  const gx = new Float32Array(tw * th)
  const gy = new Float32Array(tw * th)
  let hxx = 0
  let hxy = 0
  let hyy = 0
  for (let j = 1; j < th - 1; j++) {
    for (let i = 1; i < tw - 1; i++) {
      const k = j * tw + i
      gx[k] = (tpl[k + 1] - tpl[k - 1]) / 2
      gy[k] = (tpl[k + tw] - tpl[k - tw]) / 2
      hxx += gx[k] * gx[k]
      hxy += gx[k] * gy[k]
      hyy += gy[k] * gy[k]
    }
  }
  const det = hxx * hyy - hxy * hxy
  const st = stats(tpl)

  return { tpl, tw, th, gx, gy, det, ixx: hyy / det, ixy: -hxy / det, iyy: hxx / det, mean: st.mean, std: st.std, ok: det > 1e-6 * (tw * th) ** 2 }
}

/**
 * Inverse-compositional Lucas-Kanade (translation, with gain and bias matched to the
 * template): moves (x, y) to where the template fits best. Returns the refined center.
 */
export function lkRefine(img, lk, x, y, iterations = 12) {
  if (!lk.ok) return { x, y, converged: false }
  const { tw, th, gx, gy, tpl } = lk
  const buf = new Float32Array(tw * th)
  let converged = false
  for (let it = 0; it < iterations; it++) {
    patch(img, x, y, tw, th, buf)
    const s = stats(buf)
    const gain = s.std > 1e-6 ? lk.std / s.std : 1
    let bx = 0
    let by = 0
    for (let j = 1; j < th - 1; j++) {
      for (let i = 1; i < tw - 1; i++) {
        const k = j * tw + i
        const e = (buf[k] - s.mean) * gain + lk.mean - tpl[k]
        bx += gx[k] * e
        by += gy[k] * e
      }
    }
    const dx = lk.ixx * bx + lk.ixy * by
    const dy = lk.ixy * bx + lk.iyy * by
    x -= Math.max(-2, Math.min(2, dx))
    y -= Math.max(-2, Math.min(2, dy))
    if (dx * dx + dy * dy < 1e-6) {
      converged = true
      break
    }
  }

  return { x, y, converged }
}

const odd = n => Math.max(5, Math.round(n) | 1)

/** Pyramid depth that keeps the coarsest template at least `minSize` px. */
export function levelsFor(tw, th, minSize = 9, max = 4) {
  let L = 1
  while (L < max && Math.min(tw, th) / 2 ** L >= minSize) L++

  return L
}

/**
 * Templates for a point at every pyramid level (level-0 coordinates x, y).
 * Returns [{ tpl, tw, th }] from level 0 up.
 */
export function templatesAt(pyr, x, y, tw, th, levels) {
  const out = []
  for (let L = 0; L < levels; L++) {
    const s = 2 ** L
    const w = L === 0 ? tw : odd(tw / s)
    const h = L === 0 ? th : odd(th / s)
    out.push({ tpl: patch(pyr[L], x / s, y / s, w, h), tw: w, th: h })
  }

  return out
}

/** Coarse-to-fine NCC match of per-level templates around a level-0 guess, then LK at level 0. */
export function matchCoarseToFine(pyr, tpls, gx, gy, radius) {
  const top = tpls.length - 1
  let x = gx / 2 ** top
  let y = gy / 2 ** top
  let score = 0
  for (let L = top; L >= 0; L--) {
    const t = tpls[L]
    const r = L === top ? Math.max(2, Math.ceil(radius / 2 ** L)) : 2
    const m = nccSearch(pyr[L], t.tpl, t.tw, t.th, x, y, r)
    score = m.score
    x = m.x
    y = m.y
    if (L > 0) {
      x *= 2
      y *= 2
    }
  }

  return { x, y, score }
}

// ---------------------------------------------------------------- point tracking

/**
 * Tracks one point (the center of a w×h box) from frame to frame. step(pyr) takes the
 * next frame's pyramid and returns { x, y, score, lost }.
 * - The current template follows appearance changes (blended in at `update`).
 * - The first frame's template pulls the point back when it still matches (no drift).
 */
export class PointTracker {
  constructor(pyr, x, y, w, h, options = {}) {
    this.tw = odd(w)
    this.th = odd(h)
    this.levels = Math.min(pyr.length, options.levels ?? levelsFor(this.tw, this.th))
    this.radius = options.radius ?? Math.max(16, Math.round(Math.max(this.tw, this.th) * 0.75))
    this.minScore = options.minScore ?? 0.5
    this.update = options.update ?? 0.35
    this.x = x
    this.y = y
    this.vx = 0
    this.vy = 0
    this.ref = templatesAt(pyr, x, y, this.tw, this.th, this.levels)
    this.cur = this.ref.map(t => ({ ...t, tpl: Float32Array.from(t.tpl) }))
    this.refLk = lkPrepare(this.ref[0].tpl, this.tw, this.th)
    this.lost = false
  }

  step(pyr) {
    const px = this.x + this.vx
    const py = this.y + this.vy
    const m = matchCoarseToFine(pyr, this.cur, px, py, this.radius)
    let { x, y } = m
    // Sub-pixel: refine against the current template, then try the original one.
    const curLk = lkPrepare(this.cur[0].tpl, this.tw, this.th)
    const a = lkRefine(pyr[0], curLk, x, y)
    if (Math.hypot(a.x - x, a.y - y) < 2) ({ x, y } = a)
    const buf = patch(pyr[0], x, y, this.tw, this.th)
    let score = ncc(this.cur[0].tpl, buf)
    const b = lkRefine(pyr[0], this.refLk, x, y)
    if (Math.hypot(b.x - x, b.y - y) < 3) {
      const refScore = ncc(this.ref[0].tpl, patch(pyr[0], b.x, b.y, this.tw, this.th))
      if (refScore > 0.8 && refScore >= score - 0.1) {
        x = b.x
        y = b.y
        score = Math.max(score, refScore)
      }
    }
    if (score < this.minScore) {
      this.lost = true

      return { x, y, score, lost: true }
    }
    this.vx = 0.7 * (x - this.x) + 0.3 * this.vx
    this.vy = 0.7 * (y - this.y) + 0.3 * this.vy
    this.x = x
    this.y = y
    if (this.update > 0) {
      const now = templatesAt(pyr, x, y, this.tw, this.th, this.levels)
      for (let L = 0; L < this.levels; L++) {
        const c = this.cur[L].tpl
        const n = now[L].tpl
        for (let i = 0; i < c.length; i++) c[i] = (1 - this.update) * c[i] + this.update * n[i]
      }
    }

    return { x, y, score, lost: false }
  }
}

/** Scale and rotation (radians, clockwise on screen) of a point pair against a reference pair. */
export function pairTransform(p1, p2, r1, r2) {
  const d0x = r2[0] - r1[0]
  const d0y = r2[1] - r1[1]
  const dx = p2[0] - p1[0]
  const dy = p2[1] - p1[1]
  const len0 = Math.hypot(d0x, d0y) || 1e-9

  return { rho: Math.hypot(dx, dy) / len0, theta: Math.atan2(dy, dx) - Math.atan2(d0y, d0x) }
}

/**
 * How the region around (cx, cy) of a reference image looks after the object turned by
 * theta and scaled by rho: samples the reference at center + R(−θ)·offset / ρ.
 */
export function warpedPatch(img, cx, cy, tw, th, rho, theta, out = new Float32Array(tw * th)) {
  const c = Math.cos(-theta) / rho
  const s = Math.sin(-theta) / rho
  for (let j = 0; j < th; j++) {
    const oy = j - (th - 1) / 2
    for (let i = 0; i < tw; i++) {
      const ox = i - (tw - 1) / 2
      out[j * tw + i] = sample(img, cx + c * ox - s * oy, cy + s * ox + c * oy)
    }
  }

  return out
}

/**
 * Two points on one object, for scale and rotation. Each point tracks on its own; then
 * both are pulled onto the first frame's templates warped by the pair's current scale and
 * rotation, which keeps a turning or growing object from drifting.
 */
export class PairTracker {
  constructor(pyr, p1, p2, w, h, options = {}) {
    this.a = new PointTracker(pyr, p1[0], p1[1], w, h, options)
    this.b = new PointTracker(pyr, p2[0], p2[1], w, h, options)
    this.ref = pyr[0]
    this.r1 = [p1[0], p1[1]]
    this.r2 = [p2[0], p2[1]]
  }

  step(pyr) {
    const ra = this.a.step(pyr)
    const rb = this.b.step(pyr)
    if (ra.lost || rb.lost) return { points: [ra, rb], lost: true, ...pairTransform([ra.x, ra.y], [rb.x, rb.y], this.r1, this.r2) }
    let pa = [ra.x, ra.y]
    let pb = [rb.x, rb.y]
    for (let pass = 0; pass < 2; pass++) {
      const { rho, theta } = pairTransform(pa, pb, this.r1, this.r2)
      const next = [[this.a, this.r1, pa], [this.b, this.r2, pb]].map(([t, r, p]) => {
        const tpl = warpedPatch(this.ref, r[0], r[1], t.tw, t.th, rho, theta)
        const lk = lkPrepare(tpl, t.tw, t.th)
        const q = lkRefine(pyr[0], lk, p[0], p[1])
        if (Math.hypot(q.x - p[0], q.y - p[1]) > 3) return p
        const score = ncc(tpl, patch(pyr[0], q.x, q.y, t.tw, t.th))

        return score > 0.8 ? [q.x, q.y] : p
      })
      pa = next[0]
      pb = next[1]
    }
    ;[this.a.x, this.a.y] = pa
    ;[this.b.x, this.b.y] = pb
    const tr = pairTransform(pa, pb, this.r1, this.r2)

    return { points: [{ ...ra, x: pa[0], y: pa[1] }, { ...rb, x: pb[0], y: pb[1] }], lost: false, ...tr }
  }
}

/** Unwraps a sequence of angles (radians) so consecutive values never jump by more than π. */
export function unwrap(angles) {
  const out = []
  let offset = 0
  for (let i = 0; i < angles.length; i++) {
    if (i > 0) {
      const d = angles[i] + offset - out[i - 1]
      if (d > Math.PI) offset -= 2 * Math.PI
      else if (d < -Math.PI) offset += 2 * Math.PI
    }
    out.push(angles[i] + offset)
  }

  return out
}

// ---------------------------------------------------------------- similarity transforms
// A similarity in centered coordinates: p → [[a, −b], [b, a]]·p + (tx, ty).

export const IDENTITY = { a: 1, b: 0, tx: 0, ty: 0 }

export const applySim = (s, x, y) => [s.a * x - s.b * y + s.tx, s.b * x + s.a * y + s.ty]

/** (A ∘ B)(p) = A(B(p)). */
export function composeSim(A, B) {
  return { a: A.a * B.a - A.b * B.b, b: A.a * B.b + A.b * B.a, tx: A.a * B.tx - A.b * B.ty + A.tx, ty: A.b * B.tx + A.a * B.ty + A.ty }
}

export function invertSim(s) {
  const d = s.a * s.a + s.b * s.b || 1e-12
  const a = s.a / d
  const b = -s.b / d

  return { a, b, tx: -(a * s.tx - b * s.ty), ty: -(b * s.tx + a * s.ty) }
}

export const simParams = s => ({ rho: Math.hypot(s.a, s.b), theta: Math.atan2(s.b, s.a), tx: s.tx, ty: s.ty })
export const simFrom = (rho, theta, tx, ty) => ({ a: rho * Math.cos(theta), b: rho * Math.sin(theta), tx, ty })

/** Least-squares similarity taking points P to Q (arrays of [x, y]). */
export function fitSimilarity(P, Q) {
  const n = P.length
  let px = 0
  let py = 0
  let qx = 0
  let qy = 0
  for (let i = 0; i < n; i++) {
    px += P[i][0]
    py += P[i][1]
    qx += Q[i][0]
    qy += Q[i][1]
  }
  px /= n
  py /= n
  qx /= n
  qy /= n
  let num1 = 0
  let num2 = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    const ax = P[i][0] - px
    const ay = P[i][1] - py
    const bx = Q[i][0] - qx
    const by = Q[i][1] - qy
    num1 += ax * bx + ay * by
    num2 += ax * by - ay * bx
    den += ax * ax + ay * ay
  }
  const a = den > 1e-12 ? num1 / den : 1
  const b = den > 1e-12 ? num2 / den : 0

  return { a, b, tx: qx - (a * px - b * py), ty: qy - (b * px + a * py) }
}

/** RANSAC over point pairs, then a least-squares refit on the inliers. */
export function robustSimilarity(P, Q, threshold = 1, iterations = 120, seed = 1) {
  const n = P.length
  if (n < 2) return { sim: n === 1 ? { a: 1, b: 0, tx: Q[0][0] - P[0][0], ty: Q[0][1] - P[0][1] } : { ...IDENTITY }, inliers: n }
  let s = seed >>> 0
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  let bestCount = -1
  let bestSet = null
  const t2 = threshold * threshold
  for (let it = 0; it < iterations; it++) {
    const i = Math.floor(rand() * n)
    let j = Math.floor(rand() * n)
    if (j === i) j = (i + 1) % n
    if (Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]) < 8) continue
    const sim = fitSimilarity([P[i], P[j]], [Q[i], Q[j]])
    const set = []
    for (let k = 0; k < n; k++) {
      const [x, y] = applySim(sim, P[k][0], P[k][1])
      if ((x - Q[k][0]) ** 2 + (y - Q[k][1]) ** 2 <= t2) set.push(k)
    }
    if (set.length > bestCount) {
      bestCount = set.length
      bestSet = set
    }
  }
  if (!bestSet || bestSet.length < 2) return { sim: fitSimilarity(P, Q), inliers: n }
  // Refit, then once more with the inliers of the refit.
  let sim = fitSimilarity(bestSet.map(k => P[k]), bestSet.map(k => Q[k]))
  const set = []
  for (let k = 0; k < n; k++) {
    const [x, y] = applySim(sim, P[k][0], P[k][1])
    if ((x - Q[k][0]) ** 2 + (y - Q[k][1]) ** 2 <= t2) set.push(k)
  }
  if (set.length >= 2) sim = fitSimilarity(set.map(k => P[k]), set.map(k => Q[k]))

  return { sim, inliers: set.length }
}

// ---------------------------------------------------------------- global motion

/** Grid points with enough texture (structure tensor's smaller eigenvalue) for matching. */
export function featureGrid(img, cols = 12, rows = 8, tsize = 21, margin = 0.08) {
  const pts = []
  const half = tsize >> 1
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.round(img.w * (margin + ((1 - 2 * margin) * (c + 0.5)) / cols))
      const y = Math.round(img.h * (margin + ((1 - 2 * margin) * (r + 0.5)) / rows))
      let sxx = 0
      let sxy = 0
      let syy = 0
      for (let j = -half; j <= half; j += 2) {
        for (let i = -half; i <= half; i += 2) {
          const gx = sample(img, x + i + 1, y + j) - sample(img, x + i - 1, y + j)
          const gy = sample(img, x + i, y + j + 1) - sample(img, x + i, y + j - 1)
          sxx += gx * gx
          sxy += gx * gy
          syy += gy * gy
        }
      }
      const tr = sxx + syy
      const minEig = tr / 2 - Math.sqrt(Math.max(0, (tr * tr) / 4 - (sxx * syy - sxy * sxy)))
      pts.push({ x, y, strength: minEig })
    }
  }
  const sorted = pts.map(p => p.strength).sort((a, b) => a - b)
  const floor = Math.max(1e-3, sorted[Math.floor(sorted.length * 0.25)] * 0.2)

  return pts.filter(p => p.strength > floor)
}

/**
 * The similarity taking frame A to frame B (centered coordinates of the level-0 image):
 * a grid of points matched coarse-to-fine with NCC and LK, then a robust fit.
 */
export function estimateMotion(pyrA, pyrB, options = {}) {
  const img = pyrA[0]
  const tsize = options.template ?? 21
  const radius = options.radius ?? Math.round(img.w * 0.06)
  const levels = Math.min(pyrA.length, options.levels ?? 3)
  const pts = featureGrid(img, options.cols ?? 12, options.rows ?? 8, tsize)
  const cx = (img.w - 1) / 2
  const cy = (img.h - 1) / 2
  const guess = options.guess ?? IDENTITY
  const P = []
  const Q = []
  for (const pt of pts) {
    const tpls = templatesAt(pyrA, pt.x, pt.y, tsize, tsize, levels)
    const [gx, gy] = applySim(guess, pt.x - cx, pt.y - cy)
    const m = matchCoarseToFine(pyrB, tpls, gx + cx, gy + cy, radius)
    if (m.score < (options.minScore ?? 0.7)) continue
    const lk = lkRefine(pyrB[0], lkPrepare(tpls[0].tpl, tsize, tsize), m.x, m.y)
    const x = Math.hypot(lk.x - m.x, lk.y - m.y) < 2 ? lk.x : m.x
    const y = Math.hypot(lk.x - m.x, lk.y - m.y) < 2 ? lk.y : m.y
    P.push([pt.x - cx, pt.y - cy])
    Q.push([x - cx, y - cy])
  }
  const { sim, inliers } = robustSimilarity(P, Q, options.threshold ?? 1)

  return { ...sim, inliers, matched: P.length, points: pts.length }
}

/** Cumulative path: path[k] maps frame-0 coordinates to frame-k coordinates. */
export function accumulate(steps) {
  const out = [{ ...IDENTITY }]
  for (let k = 1; k < steps.length; k++) out.push(composeSim(steps[k], out[k - 1]))

  return out
}

// ---------------------------------------------------------------- smoothing

/**
 * Gaussian smoothing with odd reflection at the ends (a straight line stays straight).
 * sigma is in samples; 0 returns a copy.
 */
export function gaussianSmooth(values, sigma) {
  const n = values.length
  if (!(sigma > 0) || n < 3) return [...values]
  const radius = Math.ceil(sigma * 3)
  const kernel = []
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    kernel.push(v)
    sum += v
  }
  const at = i => {
    if (i < 0) return 2 * values[0] - values[Math.min(n - 1, -i)]
    if (i >= n) return 2 * values[n - 1] - values[Math.max(0, 2 * (n - 1) - i)]

    return values[i]
  }
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = -radius; j <= radius; j++) s += kernel[j + radius] * at(i + j)
    out[i] = s / sum
  }

  return out
}

/**
 * Smooths a camera path (similarities) parameter by parameter. lock: hold the camera at
 * path[lockIndex] instead. Returns the smooth path.
 */
export function smoothPath(path, sigma, options = {}) {
  if (options.lock) {
    const ref = path[options.lockIndex ?? 0]

    return path.map(() => ({ ...ref }))
  }
  const ps = path.map(simParams)
  const theta = gaussianSmooth(unwrap(ps.map(p => p.theta)), sigma)
  const logRho = gaussianSmooth(ps.map(p => Math.log(p.rho)), sigma)
  const tx = gaussianSmooth(ps.map(p => p.tx), sigma)
  const ty = gaussianSmooth(ps.map(p => p.ty), sigma)

  return path.map((_, k) => simFrom(Math.exp(logRho[k]), theta[k], tx[k], ty[k]))
}

/** Corrections that move each frame from its raw path onto the smooth one: S_k ∘ A_k⁻¹. */
export function corrections(path, smooth) {
  return path.map((A, k) => composeSim(smooth[k], invertSim(A)))
}

/**
 * The zoom (≥ 1, about the image center) that hides every frame's moved edges: for each
 * correction C (centered px), the zoomed, corrected image must still cover the w×h frame.
 */
export function coverZoom(corrs, w, h, maxZoom = 2) {
  const hw = (w - 1) / 2
  const hh = (h - 1) / 2
  const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
  const covers = (C, z) => {
    const inv = invertSim({ a: C.a * z, b: C.b * z, tx: C.tx * z, ty: C.ty * z })
    for (const [x, y] of corners) {
      const [u, v] = applySim(inv, x, y)
      if (Math.abs(u) > hw + 1e-6 || Math.abs(v) > hh + 1e-6) return false
    }

    return true
  }
  let zoom = 1
  for (const C of corrs) {
    if (covers(C, zoom)) continue
    let lo = zoom
    let hi = maxZoom
    if (!covers(C, hi)) {
      zoom = maxZoom
      continue
    }
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (covers(C, mid)) hi = mid
      else lo = mid
    }
    zoom = hi
  }

  return zoom
}

// ---------------------------------------------------------------- clip transforms and keyframes

/** A clip's layer → parent matrix [a, b, c, d, e, f] (same as engine/frame.js localMatrix). */
export function localMatrix(v) {
  const r = ((v.rotation ?? 0) * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const sx = (v.scale ?? 1) * (v.scaleX ?? 1)
  const sy = (v.scale ?? 1) * (v.scaleY ?? 1)
  const a = cos * sx
  const b = sin * sx
  const c = -sin * sy
  const d = cos * sy
  const ax = v.anchorX ?? 0
  const ay = v.anchorY ?? 0

  return [a, b, c, d, v.x - (a * ax + c * ay), v.y - (b * ax + d * ay)]
}

export const applyMatrix = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]]

export function invertMatrix(M) {
  const det = M[0] * M[3] - M[1] * M[2] || 1e-12

  return [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det, (M[2] * M[5] - M[3] * M[4]) / det, (M[1] * M[4] - M[0] * M[5]) / det]
}

/** Contain-fit factor of a w×h source in a W×H frame (how video, images and comps are placed). */
export const fitScale = (w, h, W, H) => Math.min(W / w, H / h)

/** Source pixel (index convention) → layer px (origin at the layer center). */
export const sourceToLayer = (u, v, w, h, fit) => [(u - (w - 1) / 2) * fit, (v - (h - 1) / 2) * fit]
export const layerToSource = (x, y, w, h, fit) => [x / fit + (w - 1) / 2, y / fit + (h - 1) / 2]

/**
 * Keyframe values that apply corrections C_k (centered source px) and a cover zoom to a
 * clip whose own transform at frame k is base(k) ({ x, y, rotation, scale, scaleX,
 * scaleY, anchorX, anchorY }). fit maps source px to layer px. Exact for uniform scale.
 */
export function stabilizeValues(corrs, base, fit, zoom = 1) {
  return corrs.map((C, k) => {
    const v = base(k)
    const { rho, theta, tx, ty } = simParams(C)
    const r0 = ((v.rotation ?? 0) * Math.PI) / 180
    const s = v.scale ?? 1
    const sx = s * (v.scaleX ?? 1)
    const sy = s * (v.scaleY ?? 1)
    // M_base · G with G(l) = z·ρR(φ)·l + z·fit·t, kept in the form R'S'(l − anchor) + X'.
    const lx = zoom * fit * tx - (v.anchorX ?? 0)
    const ly = zoom * fit * ty - (v.anchorY ?? 0)
    const c0 = Math.cos(r0)
    const s0 = Math.sin(r0)
    const X = v.x + c0 * sx * lx - s0 * sy * ly
    const Y = v.y + s0 * sx * lx + c0 * sy * ly
    const r1 = r0 + theta
    const k1 = zoom * rho
    const ax = v.anchorX ?? 0
    const ay = v.anchorY ?? 0
    const c1 = Math.cos(r1)
    const s1 = Math.sin(r1)

    return {
      x: X + c1 * sx * k1 * ax - s1 * sy * k1 * ay,
      y: Y + s1 * sx * k1 * ax + c1 * sy * k1 * ay,
      rotation: (r1 * 180) / Math.PI,
      scale: s * k1,
    }
  })
}

/**
 * Match move: the target layer follows a tracked point P_k (canvas px) with its offset
 * from the point at the reference frame preserved. With a point pair, rho and theta
 * (radians) also scale and turn the offset, and add to the target's scale and rotation.
 * base(k) is the target's own { x, y, rotation, scale } at frame k.
 */
export function matchMoveValues(points, refIndex, base, pair = null) {
  const ref = points[refIndex]

  return points.map((P, k) => {
    const v = base(k)
    const rho = pair ? pair[k].rho : 1
    const theta = pair ? pair[k].theta : 0
    const ox = v.x - ref[0]
    const oy = v.y - ref[1]
    const c = Math.cos(theta) * rho
    const s = Math.sin(theta) * rho
    const out = { x: P[0] + c * ox - s * oy, y: P[1] + s * ox + c * oy }
    if (pair) {
      out.rotation = (v.rotation ?? 0) + (theta * 180) / Math.PI
      out.scale = (v.scale ?? 1) * rho
    }

    return out
  })
}

/**
 * Keeps the fewest keys such that linear interpolation between kept keys stays within
 * `tolerance` of every sample (Ramer–Douglas–Peucker on value error). Returns indices.
 */
export function decimate(times, values, tolerance) {
  const n = times.length
  if (n <= 2) return [...Array(n).keys()]
  const keep = new Uint8Array(n)
  keep[0] = keep[n - 1] = 1
  const stack = [[0, n - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    let worst = -1
    let err = tolerance
    for (let i = a + 1; i < b; i++) {
      const f = (times[i] - times[a]) / (times[b] - times[a] || 1)
      const e = Math.abs(values[a] + (values[b] - values[a]) * f - values[i])
      if (e > err) {
        err = e
        worst = i
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([a, worst], [worst, b])
    }
  }
  const out = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)

  return out
}

/**
 * keyframe ops for clip `id` from samples [{ local, values: { prop: v } }]: clears each
 * prop, then adds the decimated keys (clip-local seconds). tolerance is per prop.
 */
export function keyframeOps(id, samples, tolerance = {}) {
  const props = Object.keys(samples[0]?.values ?? {})
  const ops = []
  for (const prop of props) {
    const times = samples.map(s => s.local)
    const values = samples.map(s => s.values[prop])
    const keep = decimate(times, values, tolerance[prop] ?? 0.05)
    ops.push({ op: 'clear_keyframes', id, prop })
    for (const i of keep) ops.push({ op: 'keyframe', id, prop, at: Math.round(times[i] * 1e5) / 1e5, value: Math.round(values[i] * 1e4) / 1e4, local: true })
  }

  return ops
}

// ---------------------------------------------------------------- worker client

/** Runs tracker-worker.js jobs: run(message, onProgress) → Promise of all results; cancel(id). */
export class TrackerClient {
  constructor() {
    this.worker = null
    this.jobs = new Map()
    this.seq = 0
  }

  ensure() {
    if (this.worker) return this.worker
    this.worker = new Worker(new URL('./tracker-worker.js', import.meta.url), { type: 'module' })
    this.worker.onmessage = e => {
      const m = e.data
      const job = this.jobs.get(m.id)
      if (!job) return
      if (m.results) job.results.push(...m.results)
      if (m.type === 'progress') job.onProgress?.(m.done, m.total, m.results ?? [])
      else if (m.type === 'done') {
        this.jobs.delete(m.id)
        job.resolve({ ...m, results: job.results })
      } else if (m.type === 'error') {
        this.jobs.delete(m.id)
        job.reject(new Error(m.error))
      }
    }
    this.worker.onerror = e => {
      for (const job of this.jobs.values()) job.reject(new Error(e.message || 'tracker worker failed'))
      this.jobs.clear()
      this.worker = null
    }

    return this.worker
  }

  run(message, onProgress) {
    const id = `t${++this.seq}`
    const worker = this.ensure()
    const promise = new Promise((resolve, reject) => this.jobs.set(id, { resolve, reject, onProgress, results: [] }))
    worker.postMessage({ ...message, id })

    return { id, promise }
  }

  cancel(id) {
    this.worker?.postMessage({ type: 'cancel', id })
  }
}

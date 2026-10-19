// node --test editor/test
// Tracking and stabilization math on synthetic frames with known motion.
import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOps, findClip, newProject, valueAt } from '../core/project.js'
import {
  accumulate, applyMatrix, applySim, buildPyramid, composeSim, corrections, coverZoom, decimate, estimateMotion, fitScale,
  gaussianSmooth, image, invertSim, keyframeOps, localMatrix, matchMoveValues, PairTracker, PointTracker, simFrom,
  simParams, smoothPath, stabilizeValues,
} from '../web/engine/tracker.js'

// Smooth, non-periodic value noise (cubic-interpolated lattice), so matches are unambiguous.
function noise(seed, cell) {
  const hash = (i, j) => {
    let h = (i * 374761393 + j * 668265263 + seed * 2246822519) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)

    return ((h ^ (h >>> 16)) >>> 0) / 4294967296
  }
  const s = t => t * t * (3 - 2 * t)

  return (x, y) => {
    const gx = x / cell
    const gy = y / cell
    const i = Math.floor(gx)
    const j = Math.floor(gy)
    const fx = s(gx - i)
    const fy = s(gy - j)
    const a = hash(i, j)
    const b = hash(i + 1, j)
    const c = hash(i, j + 1)
    const d = hash(i + 1, j + 1)

    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy
  }
}

/** Renders f(x, y) (pixel-center coordinates) with ss×ss supersampling. */
function render(w, h, f, ss = 3) {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) s += f(x - 0.5 + (i + 0.5) / ss, y - 0.5 + (j + 0.5) / ss)
      out[y * w + x] = s / (ss * ss)
    }
  }

  return image(w, h, out)
}

const bgTex = (() => {
  const a = noise(1, 9)
  const b = noise(2, 3)

  return (x, y) => 60 + 90 * a(x, y) + 40 * b(x, y)
})()
const objTex = (() => {
  const a = noise(7, 6)
  const b = noise(8, 2.5)

  return (x, y) => 40 + 150 * a(x, y) + 50 * b(x, y)
})()

test('point tracker follows a moving textured square to within 0.5 px', t => {
  const W = 240
  const H = 180
  const S = 48
  const path = k => [60 + 2.37 * k + 4 * Math.sin(k / 5), 50 + 1.13 * k + 3 * Math.cos(k / 7)]
  const frame = k => {
    const [cx, cy] = path(k)

    return render(W, H, (x, y) => (Math.abs(x - cx) < S / 2 && Math.abs(y - cy) < S / 2 ? objTex(x - cx, y - cy) : bgTex(x, y)))
  }
  const [x0, y0] = path(0)
  const tracker = new PointTracker(buildPyramid(frame(0), 3), x0, y0, S, S)
  let worst = 0
  for (let k = 1; k <= 40; k++) {
    const r = tracker.step(buildPyramid(frame(k), 3))
    const [gx, gy] = path(k)
    assert.equal(r.lost, false, `lost at frame ${k}`)
    worst = Math.max(worst, Math.hypot(r.x - gx, r.y - gy))
  }
  t.diagnostic(`worst error ${worst.toFixed(3)} px over 40 frames`)
  assert.ok(worst < 0.5, `worst error ${worst.toFixed(3)} px`)
})

test('two-point tracking recovers scale and rotation of a turning, growing object', t => {
  const W = 260
  const H = 200
  const pose = k => ({ cx: 110 + 1.5 * k, cy: 95 + 0.6 * k, theta: (0.5 * k * Math.PI) / 180, rho: 1 + 0.004 * k })
  const frame = k => {
    const { cx, cy, theta, rho } = pose(k)
    const c = Math.cos(-theta)
    const s = Math.sin(-theta)

    return render(W, H, (x, y) => {
      const dx = (x - cx) / rho
      const dy = (y - cy) / rho
      const lx = c * dx - s * dy
      const ly = s * dx + c * dy

      return Math.abs(lx) < 60 && Math.abs(ly) < 42 ? objTex(lx, ly) : bgTex(x, y)
    })
  }
  const world = (k, [lx, ly]) => {
    const { cx, cy, theta, rho } = pose(k)

    return [cx + rho * (Math.cos(theta) * lx - Math.sin(theta) * ly), cy + rho * (Math.sin(theta) * lx + Math.cos(theta) * ly)]
  }
  const L1 = [-32, -18]
  const L2 = [32, 18]
  const pair = new PairTracker(buildPyramid(frame(0), 3), world(0, L1), world(0, L2), 25, 25)
  let rotErr = 0
  let scaleErr = 0
  let posErr = 0
  for (let k = 1; k <= 30; k++) {
    const r = pair.step(buildPyramid(frame(k), 3))
    assert.equal(r.lost, false, `lost at ${k}`)
    rotErr = Math.max(rotErr, Math.abs((r.theta * 180) / Math.PI - 0.5 * k))
    scaleErr = Math.max(scaleErr, Math.abs(r.rho - pose(k).rho))
    const g1 = world(k, L1)
    posErr = Math.max(posErr, Math.hypot(r.points[0].x - g1[0], r.points[0].y - g1[1]))
  }
  t.diagnostic(`worst point error ${posErr.toFixed(3)} px`)
  t.diagnostic(`worst rotation error ${rotErr.toFixed(3)}°, scale error ${scaleErr.toFixed(4)}`)
  assert.ok(posErr < 0.5, `point error ${posErr.toFixed(3)} px`)
  assert.ok(rotErr < 0.2, `rotation error ${rotErr.toFixed(3)}°`)
  assert.ok(scaleErr < 0.005, `scale error ${scaleErr.toFixed(4)}`)
})

test('global motion from a grid of points recovers camera shake (translation and roll)', t => {
  const W = 320
  const H = 240
  const cx = (W - 1) / 2
  const cy = (H - 1) / 2
  // A_k maps the scene (frame 0) to frame k: jitter plus a slow pan and a little roll.
  const A = k => simFrom(1, ((0.4 * Math.sin(k * 1.3)) * Math.PI) / 180, 3 * k + 6 * Math.sin(k * 2.1), -1.5 * k + 5 * Math.cos(k * 1.7))
  const frame = k => {
    const inv = invertSim(A(k))

    return render(W, H, (x, y) => {
      const [u, v] = applySim(inv, x - cx, y - cy)

      return bgTex(u + cx, v + cy)
    }, 2)
  }
  const steps = [{ a: 1, b: 0, tx: 0, ty: 0 }]
  let prev = buildPyramid(frame(0), 3)
  for (let k = 1; k <= 12; k++) {
    const cur = buildPyramid(frame(k), 3)
    const m = estimateMotion(prev, cur)
    assert.ok(m.inliers >= 20, `inliers ${m.inliers}`)
    steps.push(m)
    prev = cur
  }
  const path = accumulate(steps)
  let worstT = 0
  let worstR = 0
  for (let k = 1; k <= 12; k++) {
    const got = simParams(path[k])
    const want = simParams(composeSim(A(k), invertSim(A(0))))
    assert.ok(Math.hypot(got.tx - want.tx, got.ty - want.ty) < 0.5, `frame ${k}: (${got.tx.toFixed(2)}, ${got.ty.toFixed(2)}) vs (${want.tx.toFixed(2)}, ${want.ty.toFixed(2)})`)
    assert.ok(Math.abs(((got.theta - want.theta) * 180) / Math.PI) < 0.05, `frame ${k} roll`)
    worstT = Math.max(worstT, Math.hypot(got.tx - want.tx, got.ty - want.ty))
    worstR = Math.max(worstR, Math.abs(((got.theta - want.theta) * 180) / Math.PI))
  }
  t.diagnostic(`cumulative path error after 12 frames: ${worstT.toFixed(3)} px, ${worstR.toFixed(4)}°`)
})

test('path smoothing keeps a pan, removes jitter, and corrections land frames on the smooth path', () => {
  const n = 120
  const line = Array.from({ length: n }, (_, i) => 3 + 2 * i)
  gaussianSmooth(line, 8).forEach((v, i) => assert.ok(Math.abs(v - line[i]) < 1e-9))
  const jitter = i => 6 * Math.sin(i * 2.7) + 4 * Math.sin(i * 1.9 + 1)
  const shaky = line.map((v, i) => v + jitter(i))
  const sm = gaussianSmooth(shaky, 6)
  const rms = arr => Math.sqrt(arr.reduce((s, v) => s + v * v, 0) / arr.length)
  const before = rms(shaky.map((v, i) => v - line[i]))
  const after = rms(sm.slice(10, -10).map((v, i) => v - line[i + 10]))
  assert.ok(after < before / 5, `jitter rms ${before.toFixed(2)} → ${after.toFixed(2)}`)

  const path = Array.from({ length: n }, (_, i) => simFrom(1 + 0.01 * Math.sin(i), 0.01 * Math.sin(i * 1.3), 2 * i + jitter(i), -i + jitter(i + 5)))
  const smooth = smoothPath(path, 6)
  const corrs = corrections(path, smooth)
  for (const k of [0, 17, 60, 119]) {
    const both = composeSim(corrs[k], path[k])
    for (const key of ['a', 'b', 'tx', 'ty']) assert.ok(Math.abs(both[key] - smooth[k][key]) < 1e-9)
  }
  const locked = smoothPath(path, 6, { lock: true, lockIndex: 10 })
  assert.deepEqual(locked[99], path[10])

  // The cover zoom hides every edge: each zoomed, corrected frame contains the whole frame.
  const w = 1280
  const h = 720
  const zoom = coverZoom(corrs, w, h)
  assert.ok(zoom > 1 && zoom < 1.2, `zoom ${zoom}`)
  for (const C of corrs) {
    const inv = invertSim({ a: C.a * zoom, b: C.b * zoom, tx: C.tx * zoom, ty: C.ty * zoom })
    for (const [x, y] of [[-639.5, -359.5], [639.5, 359.5], [639.5, -359.5], [-639.5, 359.5]]) {
      const [u, v] = applySim(inv, x, y)
      assert.ok(Math.abs(u) <= 639.5 + 1e-6 && Math.abs(v) <= 359.5 + 1e-6)
    }
  }
})

test('stabilization keyframes put each raw frame where the smooth path wants it', () => {
  const srcW = 1280
  const srcH = 720
  const fit = fitScale(srcW, srcH, 1920, 1080)
  const base = { x: 900, y: 560, rotation: 3, scale: 1.1, anchorX: 12, anchorY: -7 }
  const path = Array.from({ length: 30 }, (_, i) => simFrom(1 + 0.003 * Math.sin(i), 0.004 * Math.cos(i * 1.7), 2 * i + 5 * Math.sin(i * 2.3), 4 * Math.cos(i * 1.1)))
  const smooth = smoothPath(path, 5)
  const corrs = corrections(path, smooth)
  const zoom = coverZoom(corrs, srcW, srcH)
  const values = stabilizeValues(corrs, () => base, fit, zoom)
  const M0 = localMatrix(base)
  for (const k of [0, 9, 29]) {
    const M = localMatrix({ ...base, ...values[k] })
    for (const u0 of [[0, 0], [300, -200], [-500, 310]]) {
      // A scene point at u0 (frame-0 centered source px) is at path[k](u0) in raw frame k.
      const [ux, uy] = applySim(path[k], ...u0)
      const got = applyMatrix(M, ux * fit, uy * fit)
      const [sx, sy] = applySim(smooth[k], ...u0)
      const want = applyMatrix(M0, sx * fit * zoom, sy * fit * zoom)
      assert.ok(Math.hypot(got[0] - want[0], got[1] - want[1]) < 1e-6, `frame ${k}`)
    }
  }
})

test('match move keeps the offset, and keyframe ops reproduce the track within tolerance', () => {
  const pts = Array.from({ length: 60 }, (_, k) => [400 + 5 * k + 20 * Math.sin(k / 4), 300 + 2 * k])
  const base = () => ({ x: 450, y: 250, rotation: 0, scale: 1 })
  const vals = matchMoveValues(pts, 10, base)
  for (const k of [0, 10, 59]) {
    assert.ok(Math.abs(vals[k].x - (450 + pts[k][0] - pts[10][0])) < 1e-9)
    assert.ok(Math.abs(vals[k].y - (250 + pts[k][1] - pts[10][1])) < 1e-9)
  }
  // A point pair: the offset turns and scales with the pair.
  const pair = pts.map((_, k) => ({ rho: 1 + 0.01 * (k - 10), theta: 0.02 * (k - 10) }))
  const v2 = matchMoveValues(pts, 10, base, pair)
  const k = 40
  const off = [450 - pts[10][0], 250 - pts[10][1]]
  const c = Math.cos(pair[k].theta) * pair[k].rho
  const s = Math.sin(pair[k].theta) * pair[k].rho
  assert.ok(Math.abs(v2[k].x - (pts[k][0] + c * off[0] - s * off[1])) < 1e-9)
  assert.ok(Math.abs(v2[k].rotation - (pair[k].theta * 180) / Math.PI) < 1e-9)
  assert.ok(Math.abs(v2[k].scale - pair[k].rho) < 1e-12)

  // Through the real keyframe op: decimated keys interpolate back to every sample.
  const p = newProject('t')
  p.assets['a.mp4'] = { duration: 10, width: 1920, height: 1080, hasVideo: true }
  let proj = applyOps(p, [{ op: 'add_shape', track: 'V1', start: 1, dur: 5 }]).project
  const fps = 30
  const samples = vals.map((v, i) => ({ local: i / fps, values: { x: v.x, y: v.y } }))
  const ops = keyframeOps('c1', samples, { x: 0.1, y: 0.1 })
  assert.ok(ops.length < samples.length * 2 + 2, `${ops.length} ops`)
  proj = applyOps(proj, ops).project
  const clip = findClip(proj, 'c1').clip
  for (const sm of samples) {
    assert.ok(Math.abs(valueAt(proj, clip, 'x', sm.local) - sm.values.x) < 0.1 + 1e-3)
    assert.ok(Math.abs(valueAt(proj, clip, 'y', sm.local) - sm.values.y) < 0.1 + 1e-3)
  }
  // A straight line needs only its end keys.
  assert.deepEqual(decimate([0, 1, 2, 3, 4], [0, 2, 4, 6, 8], 0.01), [0, 4])
})

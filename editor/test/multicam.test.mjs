// node --test editor/test
// Multicam: FFT cross-correlation, lag finding, and the sync route on ffmpeg-generated angles
// that share one soundtrack at known offsets.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import analysisRoutes, { crossCorrelate, fft, findLag, offsetsFromLags } from '../routes/analysis.mjs'
import { applyOps, findClip, newProject } from '../core/project.js'

// The angle a multicam clip shows at multicam time mt (same rule as engine/frame.js angleAt).
function angleAt(c, mt) {
  let angle = c.cuts?.[0]?.angle ?? 0
  for (const cut of c.cuts ?? []) if (cut.t <= mt + 1e-6) angle = cut.angle

  return angle
}

function rng(seed) {
  let s = seed >>> 0

  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1
}

test('fft matches a direct DFT and inverts', () => {
  const n = 64
  const r = rng(3)
  const x = Array.from({ length: n }, () => r())
  const re = Float64Array.from(x)
  const im = new Float64Array(n)
  fft(re, im)
  for (const k of [0, 1, 5, 31, 63]) {
    let sr = 0
    let si = 0
    for (let t = 0; t < n; t++) {
      sr += x[t] * Math.cos((-2 * Math.PI * k * t) / n)
      si += x[t] * Math.sin((-2 * Math.PI * k * t) / n)
    }
    assert.ok(Math.abs(sr - re[k]) < 1e-9 && Math.abs(si - im[k]) < 1e-9, `bin ${k}`)
  }
  fft(re, im, true)
  for (let t = 0; t < n; t++) assert.ok(Math.abs(re[t] - x[t]) < 1e-12)
})

test('crossCorrelate equals the direct sum at every lag', () => {
  const r = rng(11)
  const a = Float64Array.from({ length: 50 }, () => r())
  const b = Float64Array.from({ length: 37 }, () => r())
  const maxLag = 20
  const out = crossCorrelate(a, b, maxLag)
  for (let L = -maxLag; L <= maxLag; L++) {
    let s = 0
    for (let i = 0; i < a.length; i++) if (i + L >= 0 && i + L < b.length) s += a[i] * b[i + L]
    assert.ok(Math.abs(out[L + maxLag] - s) < 1e-9, `lag ${L}`)
  }
})

test('findLag recovers a known delay of noise, with sub-sample precision', () => {
  const rate = 8000
  const r = rng(5)
  const master = Float64Array.from({ length: rate * 12 }, () => r())
  // b starts 1.2345 s into the master; a starts 0.5 s in, so a's moment t sounds at t − 0.7345 in b.
  const cut = (from, len) => master.slice(Math.round(from * rate), Math.round(from * rate) + len)
  const a = cut(0.5, rate * 8)
  const b = cut(1.2345, rate * 8)
  const res = findLag(a, b, rate, 5)
  assert.ok(Math.abs(res.lag - -0.7345) < 1 / rate, `lag ${res.lag}`)
  assert.ok(res.confidence > 0.9, `confidence ${res.confidence}`)
  assert.ok(res.sharpness > 0.5, `sharpness ${res.sharpness}`)
  assert.deepEqual(offsetsFromLags([0, -0.7345, 1.1]), [0.7345, 0, 1.8345])
})

function ff(args) {
  return new Promise((resolve, reject) => execFile('ffmpeg', ['-nostdin', '-y', '-loglevel', 'error', ...args], { maxBuffer: 256e6, encoding: 'buffer' }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr))) : resolve({ stdout }))))
}

test('POST /api/multicam/sync: offsets within one frame for angles cut from one soundtrack', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reel-multicam-'))
  try {
    // A 24 s soundtrack: pink noise with a tremolo and periodic beeps (room tone plus events).
    await ff([
      '-f', 'lavfi', '-i', 'anoisesrc=d=24:c=pink:r=48000:a=0.3:seed=3', '-f', 'lavfi', '-i', 'sine=f=550:d=24:r=48000',
      '-filter_complex', "[0]volume='0.6+0.4*sin(2*PI*0.4*t)':eval=frame[n];[1]volume='0.3*gt(mod(t,1.6),1.35)':eval=frame[s];[n][s]amix=inputs=2:normalize=0[a]",
      '-map', '[a]', '-c:a', 'pcm_s16le', path.join(dir, 'master.wav'),
    ])
    // Three cameras that started rolling 1.5 s, 4.25 s and 0.4 s into the soundtrack, with a tiny picture each.
    const starts = [1.5, 4.25, 0.4]
    const srcs = []
    for (const [i, s] of starts.entries()) {
      const out = path.join(dir, `cam${i}.mp4`)
      await ff(['-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=30:d=16', '-ss', String(s), '-t', '16', '-i', path.join(dir, 'master.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', out])
      srcs.push(`cam${i}.mp4`)
    }
    const ctx = {
      resolveMedia: rel => path.join(dir, rel),
      run: (cmd, argv, options = {}) => new Promise((resolve, reject) => execFile(cmd, argv, { maxBuffer: 512e6, encoding: options.encoding ?? 'utf8' }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr))) : resolve({ stdout, stderr })))),
      broadcast: () => {},
      pushActivity: () => {},
    }
    const { routes } = analysisRoutes(ctx)
    const res = await routes['POST /api/multicam/sync']({ srcs })
    // Angle a reads its source at multicam time + offset: the camera that rolled last (4.25 s) is 0.
    const expected = starts.map(s => 4.25 - s)
    const frame = 1 / 30
    res.offsets.forEach((o, i) => assert.ok(Math.abs(o - expected[i]) < frame, `angle ${i}: ${o} vs ${expected[i]}`))
    assert.ok(Math.abs(res.lags[1] - -2.75) < frame && Math.abs(res.lags[2] - 1.1) < frame, `lags ${res.lags}`)
    for (const c of res.confidence) assert.ok(c > 0.8, `confidence ${res.confidence}`)
    assert.deepEqual(res.warnings, [])

    // The offsets drive make_multicam: at any multicam time every angle shows the same soundtrack moment.
    const p = newProject('m')
    for (const s of srcs) p.assets[s] = { duration: 16, width: 64, height: 36, fps: 30, hasVideo: true, hasAudio: true }
    const made = applyOps(p, [{ op: 'make_multicam', srcs, offsets: res.offsets, track: 'V1', start: 0 }])
    const mc = findClip(made.project, made.created[0]).clip
    assert.ok(mc.dur <= 16 - Math.max(...res.offsets) + 1 / 30 + 1e-6, `dur ${mc.dur}`)
    for (const mt of [0, 3.7, 9]) {
      const moments = mc.angles.map((a, i) => mt + a.offset + starts[i])
      for (const m of moments) assert.ok(Math.abs(m - moments[0]) < frame)
    }
    const cut = applyOps(made.project, [{ op: 'multicam_cut', id: mc.id, at: 2, angle: 2 }]).project
    assert.equal(angleAt(findClip(cut, mc.id).clip, 2.5), 2)
    assert.equal(angleAt(findClip(cut, mc.id).clip, 1.9), 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

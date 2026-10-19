// Tracking worker: decodes a clip's frames with Mediabunny (WebCodecs) at analysis size
// and runs point or pair tracking, or global motion estimation, over them.
//
// Messages in:
//   { type: 'track', id, url, frames: [{ k, s }], width, height, srcWidth, srcHeight,
//     points: [{ x, y, w, h }], options: { radius?, minScore?, update? } }
//       frames in processing order (backward tracking lists them descending); points are the
//       boxes at frames[0] in source px. Results: { k, pts: [[x, y, score]], rho?, theta? }.
//   { type: 'motion', id, url, frames, width, height, srcWidth, srcHeight }
//       Results: { k, a, b, tx, ty, inliers, matched }: the similarity taking frame k − 1 to
//       frame k in centered source px (identity for the first frame).
//   { type: 'cancel', id }
// Messages out: { type: 'progress', id, done, total, results }, { type: 'done', id, results,
// lostAt?, cancelled? }, { type: 'error', id, error }.

import { ALL_FORMATS, CanvasSink, Input, UrlSource } from '/vendor/mediabunny/dist/bundles/mediabunny.min.mjs'
import { buildPyramid, estimateMotion, grayFromRGBA, levelsFor, PairTracker, PointTracker } from './tracker.js'

const cancelled = new Set()
const CHUNK = 24

self.onmessage = async e => {
  const m = e.data
  if (m.type === 'cancel') {
    cancelled.add(m.id)

    return
  }
  try {
    if (m.type === 'track') await track(m)
    else if (m.type === 'motion') await motion(m)
    else throw new Error(`unknown tracker job ${m.type}`)
  } catch (error) {
    self.postMessage({ type: 'error', id: m.id, error: String(error?.message ?? error) })
  } finally {
    cancelled.delete(m.id)
  }
}

async function openSink(url, width, height) {
  const input = new Input({ source: new UrlSource(new URL(url, self.location.href).href), formats: ALL_FORMATS })
  const video = await input.getPrimaryVideoTrack()
  if (!video) throw new Error('no video track')
  if (!(await video.canDecode())) throw new Error('this browser cannot decode the video')

  return new CanvasSink(video, { width, height, fit: 'fill', poolSize: 2 })
}

function toGray(wrapped, w, h) {
  const ctx = wrapped.canvas.getContext('2d', { willReadFrequently: true })

  return grayFromRGBA(ctx.getImageData(0, 0, w, h).data, w, h)
}

/**
 * Yields { f, img } for frames in the given order. An ascending list streams through one
 * decoder pass; any other order decodes ascending chunks and replays each chunk in order.
 * Repeated source times (slow clips) decode once.
 */
async function* decodeFrames(sink, frames, w, h) {
  const ascending = frames.every((f, i) => i === 0 || f.s >= frames[i - 1].s - 1e-9)
  const groups = ascending ? [frames.slice()] : Array.from({ length: Math.ceil(frames.length / CHUNK) }, (_, i) => frames.slice(i * CHUNK, (i + 1) * CHUNK))
  for (const group of groups) {
    const times = [...new Set(group.map(f => f.s))].sort((a, b) => a - b)
    if (ascending) {
      let last = null
      let lastS = null
      const iter = sink.canvasesAtTimestamps(times)
      let i = 0
      for await (const wrapped of iter) {
        const s = times[i++]
        last = wrapped ? toGray(wrapped, w, h) : last
        lastS = s
        while (group.length && group[0].s <= lastS + 1e-9) {
          const f = group.shift()
          if (last) yield { f, img: last }
        }
      }
      for (const f of group) if (last) yield { f, img: last }
    } else {
      const decoded = new Map()
      let i = 0
      let last = null
      for await (const wrapped of sink.canvasesAtTimestamps(times)) {
        last = wrapped ? toGray(wrapped, w, h) : last
        if (last) decoded.set(times[i], last)
        i++
      }
      for (const f of group) {
        const img = decoded.get(f.s)
        if (img) yield { f, img }
      }
    }
  }
}

function progress(m, done, results) {
  self.postMessage({ type: 'progress', id: m.id, done, total: m.frames.length, results: results.splice(0) })
}

async function track(m) {
  const { width: w, height: h, srcWidth, srcHeight } = m
  const sx = w / srcWidth
  const sy = h / srcHeight
  // Source px ↔ analysis px (pixel centers).
  const toA = (x, y) => [(x + 0.5) * sx - 0.5, (y + 0.5) * sy - 0.5]
  const toS = (x, y) => [(x + 0.5) / sx - 0.5, (y + 0.5) / sy - 0.5]
  const boxes = m.points.map(p => ({ c: toA(p.x, p.y), w: Math.max(7, p.w * sx), h: Math.max(7, p.h * sy) }))
  const levels = Math.max(...boxes.map(b => levelsFor(Math.round(b.w) | 1, Math.round(b.h) | 1)))
  const options = { ...(m.options ?? {}), radius: m.options?.radius ? m.options.radius * sx : undefined }
  const sink = await openSink(m.url, w, h)
  const pending = []
  let tracker = null
  let done = 0
  let lostAt = null
  let lastPost = Date.now()
  for await (const { f, img } of decodeFrames(sink, m.frames, w, h)) {
    if (cancelled.has(m.id)) {
      self.postMessage({ type: 'done', id: m.id, results: pending, cancelled: true })

      return
    }
    const pyr = buildPyramid(img, levels)
    if (!tracker) {
      tracker = boxes.length === 2
        ? new PairTracker(pyr, boxes[0].c, boxes[1].c, boxes[0].w, boxes[0].h, options)
        : new PointTracker(pyr, boxes[0].c[0], boxes[0].c[1], boxes[0].w, boxes[0].h, options)
      pending.push({ k: f.k, pts: m.points.map(p => [p.x, p.y, 1]), ...(boxes.length === 2 ? { rho: 1, theta: 0 } : {}) })
    } else if (boxes.length === 2) {
      const r = tracker.step(pyr)
      if (r.lost) {
        lostAt = f.k
        break
      }
      pending.push({ k: f.k, pts: r.points.map(p => [...toS(p.x, p.y), Math.round(p.score * 1000) / 1000]), rho: r.rho, theta: r.theta })
    } else {
      const r = tracker.step(pyr)
      if (r.lost) {
        lostAt = f.k
        break
      }
      pending.push({ k: f.k, pts: [[...toS(r.x, r.y), Math.round(r.score * 1000) / 1000]] })
    }
    done++
    if (Date.now() - lastPost > 120) {
      lastPost = Date.now()
      progress(m, done, pending)
    }
  }
  self.postMessage({ type: 'done', id: m.id, results: pending, lostAt })
}

async function motion(m) {
  const { width: w, height: h, srcWidth } = m
  const s = w / srcWidth
  const sink = await openSink(m.url, w, h)
  const pending = []
  let prev = null
  let done = 0
  let lastPost = Date.now()
  for await (const { f, img } of decodeFrames(sink, m.frames, w, h)) {
    if (cancelled.has(m.id)) {
      self.postMessage({ type: 'done', id: m.id, results: pending, cancelled: true })

      return
    }
    const pyr = buildPyramid(img, 3)
    if (!prev) pending.push({ k: f.k, a: 1, b: 0, tx: 0, ty: 0, inliers: 0, matched: 0 })
    else {
      const r = estimateMotion(prev, pyr, { radius: Math.round(w * 0.08) })
      pending.push({ k: f.k, a: r.a, b: r.b, tx: r.tx / s, ty: r.ty / s, inliers: r.inliers, matched: r.matched })
    }
    prev = pyr
    done++
    if (Date.now() - lastPost > 120) {
      lastPost = Date.now()
      progress(m, done, pending)
    }
  }
  self.postMessage({ type: 'done', id: m.id, results: pending })
}

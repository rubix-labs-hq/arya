// Media sources for the compositor: one <video> per clip (so a transition between two
// cuts of one file works), shared images, and rasterized titles.

import { host } from '../host.js'

let interFontError
await Promise.all(['normal', 'italic'].map(async style => {
  const file = style === 'italic' ? 'InterVariable-Italic.woff2' : 'InterVariable.woff2'
  const font = new FontFace('Inter', `url("${new URL(`../fonts/${file}`, import.meta.url).href}")`, { style, weight: '100 900', variationSettings: '"opsz" 14' })
  await font.load()
  document.fonts.add(font)
})).catch(error => {
  interFontError = error
  console.warn('Bundled Inter font could not load', error)
})

let signatureFontError
try {
  const font = new FontFace('Mrs Saint Delafield', `url("${new URL('../fonts/MrsSaintDelafield-Regular.ttf', import.meta.url).href}")`, { style: 'normal', weight: '400' })
  await font.load()
  document.fonts.add(font)
} catch (error) {
  signatureFontError = error
  console.warn('Bundled Mrs Saint Delafield font could not load', error)
}

const holder = (() => {
  const div = document.createElement('div')
  div.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1'
  document.body.appendChild(div)

  return div
})()

export function mediaUrl(project, src) {
  const asset = project.assets[src]
  const path = asset?.proxy ?? src

  const revision = project.__aryaExportSourceRevision
  return host.url(`/media?path=${encodeURIComponent(path)}${revision ? `&sourceRevision=${encodeURIComponent(revision)}` : ''}`)
}

export class Media {
  constructor() {
    this.useDecoders = false // the render worker decodes with WebCodecs instead of seeking <video>
    this.readers = new Map() // clip id → { url, reader }
    this.decoderEpoch = 0
    this.frames = new Map() // clip id → { frame: VideoFrame, stamp }
    this.videos = new Map() // clip id → { el, url, ready }
    this.images = new Map() // url → { el, ready }
    this.titles = new Map() // clip id → { canvas, key }
    this.luts = new Map()
  }

  video(clipId, url) {
    let v = this.videos.get(clipId)
    if (v && v.url !== url) {
      this.dropVideo(clipId)
      v = null
    }
    if (!v) {
      const el = document.createElement('video')
      el.muted = true
      el.playsInline = true
      el.preload = 'auto'
      el.crossOrigin = 'anonymous'
      el.src = url
      holder.appendChild(el)
      v = { el, url, ready: false, failed: false, lastUsed: performance.now() }
      el.addEventListener('loadeddata', () => (v.ready = true))
      el.addEventListener('error', () => (v.failed = true))
      this.videos.set(clipId, v)
    }
    v.lastUsed = performance.now()

    return v
  }

  dropVideo(clipId) {
    const v = this.videos.get(clipId)
    if (!v) return
    v.cancelSeek?.()
    v.el.pause()
    v.el.removeAttribute('src')
    v.el.load()
    v.el.remove()
    this.videos.delete(clipId)
  }

  cancelSeeks() {
    for (const v of this.videos.values()) v.cancelSeek?.()
  }

  /** Releases videos not used for a while, so long timelines don't hold every decoder. */
  gc(keep) {
    const now = performance.now()
    const idle = [...this.videos].filter(([id]) => !keep.has(id)).sort((a, b) => b[1].lastUsed - a[1].lastUsed)
    for (const [index, [id, v]] of idle.entries()) if (index >= 4 || now - v.lastUsed > 8000) this.dropVideo(id)
  }

  image(url) {
    let im = this.images.get(url)
    if (!im) {
      const el = new Image()
      el.crossOrigin = 'anonymous'
      im = { el, ready: false, promise: null }
      im.promise = new Promise(resolve => {
        let settled = false
        const finish = ready => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          el.onload = el.onerror = null
          im.ready = ready
          im.failed = !ready
          im.cancel = null
          if (!ready) el.removeAttribute('src')
          resolve()
        }
        const timer = setTimeout(() => finish(false), 8000)
        im.cancel = () => finish(false)
        el.onload = () => finish(true)
        el.onerror = () => finish(false)
      })
      el.src = url
      this.images.set(url, im)
    }

    return im
  }

  /** Tells each clip's decoder the source times an export will ask for, in order. */
  async planDecoders(plans) {
    const epoch = this.decoderEpoch
    const { FrameReader } = await import('./decoder.js')
    if (epoch !== this.decoderEpoch) return
    for (const [clipId, { url, times }] of plans) {
      let r = this.readers.get(clipId)
      if (!r || r.url !== url) {
        r?.reader.close()
        r = { url, reader: new FrameReader(url), failed: false }
        r.reader.ready.catch(() => (r.failed = true))
        this.readers.set(clipId, r)
      }
      r.reader.setPlan(times)
    }
  }

  closeDecoders() {
    this.decoderEpoch++
    for (const r of this.readers.values()) r.reader.close()
    this.readers.clear()
    for (const f of this.frames.values()) f.frame.close()
    this.frames.clear()
  }

  /** Release a finished worker job's retained source resources before the next job. */
  reset() {
    this.closeDecoders()
    for (const id of this.videos.keys()) this.dropVideo(id)
    for (const im of this.images.values()) { im.cancel?.(); im.el.removeAttribute('src') }
    this.images.clear()
    for (const { canvas } of this.titles.values()) canvas.width = canvas.height = 0
    this.titles.clear()
    this.luts.clear()
  }

  /** Decodes the frame at srcTime for a clip (worker path); falls back to seeking. */
  async decodeFrame(clipId, url, srcTime, fps = 30) {
    const epoch = this.decoderEpoch
    let r = this.readers.get(clipId)
    if (r && r.url !== url) {
      r.reader.close()
      this.readers.delete(clipId)
      this.frames.get(clipId)?.frame.close()
      this.frames.delete(clipId)
      r = null
    }
    if (!r) {
      const { FrameReader } = await import('./decoder.js')
      if (epoch !== this.decoderEpoch) return
      r = this.readers.get(clipId)
      if (!r || r.url !== url) {
        r?.reader.close()
        r = { url, reader: new FrameReader(url), failed: false }
        r.reader.ready.catch(() => (r.failed = true))
        this.readers.set(clipId, r)
      }
    }
    const request = r.request = (r.request ?? 0) + 1
    const current = () => epoch === this.decoderEpoch && this.readers.get(clipId) === r && r.request === request
    try {
      if (r.failed) throw new Error('decoder unavailable')
      const target = frameCenter(srcTime, fps)
      const frame = await r.reader.frameAt(target)
      if (!current()) { frame?.close(); return }
      if (!frame) throw new Error('no frame')
      this.frames.get(clipId)?.frame.close()
      this.frames.set(clipId, { frame, stamp: target })
    } catch {
      if (!current()) return
      r.failed = true
      r.reader.close()
      this.frames.get(clipId)?.frame.close()
      this.frames.delete(clipId)
      await this.seek(clipId, url, srcTime, fps)
    }
  }

  /**
   * Seeks a clip's video to a source time and resolves once that frame is
   * decoded and presentable (frame-center seek, then a video frame callback).
   */
  async seek(clipId, url, srcTime, fps = 30) {
    const v = this.video(clipId, url)
    const el = v.el
    v.cancelSeek?.()
    const generation = v.seekGeneration = (v.seekGeneration ?? 0) + 1
    if (!v.ready) {
      await new Promise((resolve, reject) => {
        let cancel
        const done = error => {
          clearTimeout(timer)
          el.removeEventListener('loadeddata', loaded)
          el.removeEventListener('error', failed)
          if (v.cancelSeek === cancel) v.cancelSeek = null
          if (error) reject(error)
          else resolve()
        }
        const loaded = () => done(), failed = () => done(new Error('Video could not load'))
        cancel = () => { v.seekGeneration++; done() }
        el.addEventListener('loadeddata', loaded)
        el.addEventListener('error', failed)
        const timer = setTimeout(() => done(new Error('Video loading timed out')), 8000)
        v.cancelSeek = cancel
      })
    }
    if (v.seekGeneration !== generation) return v
    if (v.failed) return v
    const frame = Math.floor(srcTime * fps + 1e-3)
    const target = Math.min((frame + 0.5) / fps, Math.max(0, (el.duration || Infinity) - 0.5 / fps))
    if (!el.paused) el.pause()
    if (!el.seeking && Math.abs(el.currentTime - target) < 0.25 / fps && el.readyState >= 2) return v
    await new Promise((resolve, reject) => {
      let settled = false
      let callback, fallback, timer, cancel
      const finish = error => {
        if (!settled) {
          settled = true
          clearTimeout(fallback)
          clearTimeout(timer)
          if (callback !== undefined) el.cancelVideoFrameCallback?.(callback)
          el.removeEventListener('seeked', seeked)
          el.removeEventListener('error', failed)
          if (v.cancelSeek === cancel) v.cancelSeek = null
          if (error) reject(error)
          else resolve()
        }
      }
      const visibleCallback = el.requestVideoFrameCallback && document.visibilityState === 'visible' && !this.headless
      const failed = () => finish(new Error('Video seek failed'))
      const seeked = () => {
        if (!visibleCallback) finish()
        else fallback = setTimeout(finish, 34)
      }
      // Register before seeking, so the callback can observe the new decoded frame.
      if (visibleCallback) callback = el.requestVideoFrameCallback((_, metadata) => {
        if (!el.seeking && Math.abs(metadata.mediaTime - target) <= 1 / fps) finish()
      })
      el.addEventListener('seeked', seeked)
      el.addEventListener('error', failed)
      timer = setTimeout(() => finish(new Error('Video seek timed out')), 3000)
      cancel = () => { v.seekGeneration++; finish() }
      v.cancelSeek = cancel
      try { el.currentTime = target } catch (error) { finish(error) }
    })

    return v
  }

  /** A canvas holding the title text as drawn at `scale` (project px → canvas px). */
  title(clipId, title, scale, state) {
    const key = JSON.stringify([title, scale, state.chars ?? -1, state.tracking ?? 0])
    let entry = this.titles.get(clipId)
    if (entry?.key === key) return entry.canvas
    const canvas = entry?.canvas ?? document.createElement('canvas')
    drawTitle(canvas, title, scale, state)
    canvas.dirty = true
    this.titles.set(clipId, { canvas, key })

    return canvas
  }
}

export const frameCenter = (t, fps) => (Math.floor(t * fps + 1e-3) + 0.5) / fps

const FONT_FALLBACK = '-apple-system, "SF Pro Display", "Helvetica Neue", Helvetica, Arial, sans-serif'

/** Wraps within a declared text box using the font and tracking already set on the context. */
export function wrapTitleLines(ctx, text, width) {
  const lines = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    let spaces = ''
    for (const token of paragraph.match(/\S+|\s+/g) ?? []) {
      if (/^\s+$/.test(token)) { spaces += token; continue }
      const candidate = line + spaces + token
      if (line && ctx.measureText(candidate).width > width) {
        lines.push(line.trimEnd())
        line = ''
        spaces = ''
      }
      if (ctx.measureText(token).width > width) {
        for (const char of Array.from(token)) {
          const next = line + spaces + char
          if (line && ctx.measureText(next).width > width) { lines.push(line.trimEnd()); line = ''; spaces = '' }
          line += spaces + char
          spaces = ''
        }
      } else {
        line += spaces + token
        spaces = ''
      }
    }
    lines.push(line || spaces)
  }

  return lines
}

export function drawTitle(canvas, t, scale, state = {}) {
  if (t.font === 'Inter' && interFontError) throw new Error(`Inter could not load: ${interFontError.message ?? interFontError}`)
  if (t.font === 'Mrs Saint Delafield' && signatureFontError) throw new Error(`Mrs Saint Delafield could not load: ${signatureFontError.message ?? signatureFontError}`)
  const size = (t.size ?? 96) * scale
  const weight = t.weight ?? (t.bold ? 700 : 600)
  const font = `${t.italic ? 'italic ' : ''}${weight} ${size}px "${t.font ?? 'Avenir Next'}", ${FONT_FALLBACK}`
  const ctx = canvas.getContext('2d')
  ctx.font = font
  const tracking = ((t.tracking ?? 0) + (state.tracking ?? 0)) * scale
  let text = String(t.text ?? '')
  if (state.chars !== undefined && state.chars >= 0) text = text.slice(0, state.chars)
  const lineH = size * (t.lineHeight ?? 1.15)
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${tracking}px`
  const box = t.box
  const boxWidth = box ? Math.max(1, box.width * scale) : null
  const resolveLines = value => box?.wrap ? wrapTitleLines(ctx, value, boxWidth) : value.split('\n')
  const lines = resolveLines(text)
  const widths = lines.map(l => ctx.measureText(l).width)
  const complete = resolveLines(String(t.text ?? ''))
  // Whether wrapping added lines beyond the explicit breaks; caption placement reads it.
  canvas.titleWrapped = Boolean(box?.wrap) && complete.length > String(t.text ?? '').split('\n').length
  const full = complete.map(l => ctx.measureText(l).width)
  // A shrinking box (auto-wrapped captions) is as wide as its longest line, capped at the box width.
  const textW = box?.shrink ? Math.min(boxWidth, Math.max(1, ...full)) : boxWidth ?? Math.max(1, ...full)
  const pad = (t.padding ?? (t.plate ? 24 : 0)) * scale
  const stroke = (t.stroke?.width ?? 0) * scale
  const sh = t.shadow && typeof t.shadow === 'object' ? t.shadow : null
  const shadowRoom = sh ? (sh.blur ?? 12) * scale + Math.max(Math.abs(sh.x ?? 0), Math.abs(sh.y ?? 0)) * scale : 0
  const room = Math.ceil(pad + stroke + shadowRoom + 4)
  const align = t.align ?? 'center'
  const overflow = box ? Math.max(0, ...full.map(width => width - textW)) : 0
  // Keep the declared box centered on the layer while allowing auto-width glyphs to extend.
  const roomX = room + Math.ceil(overflow * (align === 'center' ? 0.5 : 1))
  const fullLines = complete.length
  const textH = box ? Math.max(1, box.height * scale, box.autoHeight ? fullLines * lineH : 0) : fullLines * lineH
  const w = Math.ceil(textW + roomX * 2)
  const h = Math.ceil(textH + room * 2)
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  } else ctx.clearRect(0, 0, w, h)
  ctx.font = font
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${tracking}px`
  if (t.plate) {
    ctx.fillStyle = t.plate
    const r = (t.radius ?? 10) * scale
    const x = roomX - pad
    const y = room - pad
    const pw = textW + pad * 2
    const ph = textH + pad * 2
    ctx.beginPath()
    ctx.roundRect(x, y, pw, ph, r)
    ctx.fill()
  }
  ctx.textBaseline = 'middle'
  ctx.textAlign = align
  const ax = align === 'left' ? roomX : align === 'right' ? w - roomX : w / 2
  const contentH = fullLines * lineH
  const dy = box?.alignY === 'bottom' ? textH - contentH : box?.alignY === 'center' ? (textH - contentH) / 2 : 0
  let textCursor = 0
  lines.forEach((line, i) => {
    const y = room + dy + lineH * (i + 0.5)
    const lx = align === 'center' ? ax - (full[i] - widths[i]) / 2 : align === 'right' ? ax - (full[i] - widths[i]) : ax
    if (sh) {
      ctx.save()
      ctx.shadowColor = sh.color ?? '#000000aa'
      ctx.shadowBlur = (sh.blur ?? 12) * scale
      ctx.shadowOffsetX = (sh.x ?? 0) * scale
      ctx.shadowOffsetY = (sh.y ?? 4) * scale
      ctx.fillStyle = t.color ?? '#ffffff'
      ctx.fillText(line, lx, y)
      ctx.restore()
    }
    if (stroke > 0) {
      ctx.lineJoin = 'round'
      ctx.lineWidth = stroke * 2
      ctx.strokeStyle = t.stroke.color ?? '#000000'
      ctx.strokeText(line, lx, y)
    }
    if (t.gradient) {
      const g = ctx.createLinearGradient(0, room, 0, h - room)
      g.addColorStop(0, t.gradient[0])
      g.addColorStop(1, t.gradient[1])
      ctx.fillStyle = g
    } else ctx.fillStyle = t.color ?? '#ffffff'
    ctx.fillText(line, lx, y)
    const lineStart = text.indexOf(line, textCursor)
    if (lineStart >= 0) textCursor = lineStart + line.length
    const highlight = t.highlight
    if (highlight && lineStart >= 0) {
      const from = Math.max(0, highlight.start - lineStart)
      const to = Math.min(line.length, highlight.end - lineStart)
      if (from < to) {
        const left = align === 'center' ? lx - widths[i] / 2 : align === 'right' ? lx - widths[i] : lx
        const x0 = left + ctx.measureText(line.slice(0, from)).width
        const x1 = left + ctx.measureText(line.slice(0, to)).width
        ctx.save()
        ctx.beginPath(); ctx.rect(x0, y - lineH / 2, Math.max(0, x1 - x0), lineH); ctx.clip()
        ctx.fillStyle = highlight.color ?? '#ffe600'; ctx.fillText(line, lx, y)
        ctx.restore()
      }
    }
  })
}

export { parseCube } from '/core/cube-lut.js'

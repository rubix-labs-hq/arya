// Transport: the AudioContext clock drives playback; videos follow it and are
// corrected on drift. Paused frames are drawn exactly (every video seeked first).

import { clipEnd, duration, sourceTime } from '/core/project.js'
import { drawFrame, neededImages, neededVideos, resolveTracks } from './frame.js'
import { mediaUrl } from './media.js'

export class Player {
  constructor({ comp, media, audio, getProject, getProjectIdentity = getProject, prepareFrame, onTime, onState }) {
    Object.assign(this, { comp, media, audio, getProject, getProjectIdentity, prepareFrame, onTime: onTime ?? (() => {}), onState: onState ?? (() => {}) })
    this.t = 0
    this.playing = false
    this.rate = 0
    this.loop = false
    this.exactToken = 0
    this.exactBusy = false
    this.exactPending = false
    this.renderRevision = 0
    this.frameEpoch = 0
    this.scrubbing = false
    this.displayedTime = null
    this.raf = 0
  }

  get project() {
    return this.getProject()
  }

  end() {
    const p = this.project

    return p ? duration(p) : 0
  }

  /** Draws time t exactly: seeks every needed video, waits for frames, then composites. */
  async renderExact(t = this.t, { preview = false } = {}) {
    const p = this.project
    if (!p) return
    const identity = this.getProjectIdentity()
    const revision = this.renderRevision, epoch = this.frameEpoch, transport = this.exactToken
    const prepared = this.prepareFrame ? await this.prepareFrame(p, t) : null
    const needs = neededVideos(p, t)
    // Only sources in this picture need decoding, including transition/matte inputs.
    const images = [...neededImages(p, t)].map(url => this.media.image(url).promise)
    const fetchFrame = n => (this.media.useDecoders ? this.media.decodeFrame(n.key, n.url, n.srcTime, n.fps) : this.media.seek(n.key, n.url, n.srcTime, n.fps))
    await Promise.all([...needs.map(fetchFrame), ...images])
    // Completed previews can paint while dragging. Release, playback and project changes
    // invalidate them, so a late decode cannot replace the final requested frame.
    if (identity !== this.getProjectIdentity() || p.compId !== this.project?.compId || epoch !== this.frameEpoch || transport !== this.exactToken || revision !== this.renderRevision && !(preview && this.scrubbing)) return false
    await prepared?.validate()
    if (identity !== this.getProjectIdentity() || p.compId !== this.project?.compId || epoch !== this.frameEpoch || transport !== this.exactToken || revision !== this.renderRevision && !(preview && this.scrubbing)) return false
    this.collectMedia(new Set(needs.map(n => n.key)))
    drawFrame(this.comp, this.media, p, t)
    this.displayedTime = t
    return true
  }

  /** Release idle decoder hosts and the GPU references left by their last frames. */
  collectMedia(keep) {
    this.media.gc?.(keep)
    if (!this.comp.textures || !this.comp.dropTexture) return
    for (const key of this.comp.textures.keys()) {
      if (!key.startsWith('vid:')) continue
      const id = key.slice(4)
      if (!this.media.videos.has(id) && !this.media.frames?.has(id)) this.comp.dropTexture(key)
    }
  }

  requestExact() {
    if (this.playing && this.rate > 0) return
    this.renderRevision++
    if (this.exactBusy) {
      this.exactPending = true

      return
    }
    this.exactBusy = true
    const t = this.t
    this.renderExact(t, { preview: this.scrubbing })
      .catch(e => console.warn('render', e))
      .finally(() => {
        this.exactBusy = false
        if (this.exactPending) {
          this.exactPending = false
          this.requestExact()
        }
      })
  }

  beginScrub() {
    this.scrubbing = true
    this.frameEpoch++
    if (this.playing) this.pause()
  }

  endScrub() {
    this.scrubbing = false
    this.frameEpoch++
    this.media.cancelSeeks?.()
    this.requestExact()
  }

  seek(t, options = {}) {
    const end = this.end()
    this.t = Math.max(0, Math.min(t, end || t))
    if (this.playing && this.rate > 0 && !options.keepPlaying) {
      this.play(this.rate)

      return
    }
    if (!this.playing) this.requestExact()
    this.onTime(this.t)
  }

  /** Called after the project changed. */
  refresh() {
    if (this.playing && this.rate > 0) this.play(this.rate)
    else this.requestExact()
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play(1)
  }

  async play(rate = 1) {
    const p = this.project
    if (!p) return
    this.scrubbing = false
    this.frameEpoch++
    this.exactPending = false
    this.media.cancelSeeks?.()
    cancelAnimationFrame(this.raf)
    const end = this.range()?.out ?? this.end()
    if (rate > 0 && this.t >= end - 1 / p.fps) this.t = this.range()?.in ?? 0
    this.playing = true
    this.rate = rate
    this.onState({ playing: true, rate })
    const token = ++this.exactToken
    const identity = this.getProjectIdentity()
    let prepared
    try { prepared = this.prepareFrame ? await this.prepareFrame(p, this.t, { playback: rate > 0, to: this.range()?.out ?? this.end() }) : null }
    catch (error) { if (token === this.exactToken) this.pause(); throw error }
    if (token !== this.exactToken || identity !== this.getProjectIdentity()) return
    for (const v of this.media.videos.values()) v.el.pause()
    if (rate > 0) {
      // Get the first frame's videos to the right place before the clock starts.
      await Promise.all(neededVideos(p, this.t).map(n => this.media.seek(n.key, n.url, n.srcTime, n.fps)))
      if (token !== this.exactToken) return
      try { await prepared?.validate() }
      catch (error) { if (token === this.exactToken) this.pause(); throw error }
      if (token !== this.exactToken || identity !== this.getProjectIdentity()) return
      const when = await this.audio.play(p, this.t, rate)
      if (token !== this.exactToken) return
      this.c0 = when
      this.t0 = this.t
    } else {
      this.audio.stop()
      this.c0 = performance.now() / 1000
      this.t0 = this.t
    }
    const loop = () => {
      if (!this.playing || token !== this.exactToken) return
      this.tick()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  range() {
    return this.loop ? this.project?.range : null
  }

  clock() {
    if (this.rate > 0) return this.t0 + Math.max(0, this.audio.ctx.currentTime - this.c0) * this.rate

    return this.t0 + (performance.now() / 1000 - this.c0) * this.rate
  }

  tick() {
    const p = this.project
    const end = this.range()?.out ?? this.end()
    const start = this.range()?.in ?? 0
    let t = this.clock()
    if (t >= end) {
      if (this.loop) {
        this.t = start
        this.play(this.rate)

        return
      }
      t = end
      this.t = t
      this.pause()

      return
    }
    if (t <= 0 && this.rate < 0) {
      this.t = 0
      this.pause()

      return
    }
    this.t = t
    if (this.rate < 0) {
      // Reverse: no native reverse decode, so draw exact frames as fast as they land.
      this.requestExact()
      this.onTime(t)

      return
    }
    const active = new Set()
    for (const n of neededVideos(p, t)) {
      active.add(n.key)
      const v = this.media.video(n.key, n.url)
      const el = v.el
      if (!v.ready) continue
      const speed = (n.clip.speed ?? 1) * this.rate
      const reverse = n.clip.reverse || n.clip.freeze !== undefined
      if (reverse) {
        // Reversed clips and freezes are drawn by seeking.
        if (!el.paused) el.pause()
        if (Math.abs(el.currentTime - n.srcTime) > 0.5 / n.fps && !el.seeking) el.currentTime = n.srcTime
        continue
      }
      if (Math.abs(el.playbackRate - speed) > 1e-3) el.playbackRate = Math.min(16, Math.max(0.0625, speed))
      const drift = el.currentTime - n.srcTime
      if (el.paused) {
        el.currentTime = n.srcTime
        el.play().catch(() => {})
      } else if (Math.abs(drift) > 0.12 && !el.seeking) el.currentTime = n.srcTime + 0.03
    }
    // Pre-roll clips that start soon so their first frame is ready.
    for (const track of p.tracks) {
      if (track.kind !== 'video') continue
      for (const c of track.clips) {
        if (c.kind !== 'video' || active.has(c.id)) continue
        const lead = c.start - (c.transitionIn ? c.transitionIn.dur / 2 : 0) - t
        if (lead > 0 && lead < 1.2) {
          active.add(c.id)
          const v = this.media.video(c.id, mediaUrl(p, c.src))
          const target = sourceTime(p, c, Math.max(t, c.start - (c.transitionIn?.dur ?? 0) / 2))
          if (v.ready && !v.el.seeking && Math.abs(v.el.currentTime - target) > 0.1) {
            v.el.pause()
            v.el.currentTime = target
          }
        } else if (clipEnd(c) < t || c.start > t + 2) {
          const v = this.media.videos.get(c.id)
          if (v && !v.el.paused) v.el.pause()
        }
      }
    }
    this.collectMedia(active)
    drawFrame(this.comp, this.media, p, t)
    this.onTime(t)
  }

  pause() {
    this.playing = false
    this.rate = 0
    this.exactToken++
    this.media.cancelSeeks?.()
    cancelAnimationFrame(this.raf)
    this.audio.stop()
    for (const v of this.media.videos.values()) v.el.pause()
    this.onState({ playing: false, rate: 0 })
    this.requestExact()
    this.onTime(this.t)
  }

  /** J/K/L: L speeds up forward, J reverse, K stops. */
  shuttle(dir) {
    if (dir === 0) return this.pause()
    const steps = [1, 2, 4, 8]
    const cur = this.playing ? this.rate : 0
    let next
    if (dir > 0) next = cur > 0 ? steps[Math.min(steps.length - 1, steps.indexOf(cur) + 1)] ?? 1 : 1
    else next = cur < 0 ? -steps[Math.min(steps.length - 1, steps.indexOf(-cur) + 1)] : -1
    this.play(next)
  }

  step(frames) {
    const p = this.project
    if (!p) return
    if (this.playing) this.pause()
    this.seek(Math.round((this.t + frames / p.fps) * p.fps) / p.fps)
  }
}

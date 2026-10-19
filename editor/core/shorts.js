import { applyOps, findClip, round } from './project.js'
import { wordsToCaptions } from './interchange.js'

export const CAPTION_STYLES = {
  plain: { font: 'Inter', size: 52, weight: 700, color: '#ffffff', plate: 'transparent', y: 0.86, preset: 'plain' },
  boxed: { font: 'Inter', size: 52, weight: 700, color: '#ffffff', plate: '#000000bb', y: 0.86, preset: 'boxed' },
  karaoke: { font: 'Inter', size: 58, weight: 800, color: '#ffffff', highlightColor: '#ffe600', plate: '#00000088', y: 0.82, preset: 'karaoke' },
  word: { font: 'Inter', size: 68, weight: 800, color: '#ffffff', plate: '#00000099', y: 0.82, preset: 'word' },
}

export function validateWords(words, duration = Infinity) {
  if (!Array.isArray(words) || words.length > 100000) throw new Error('A transcript must contain at most 100000 words')
  let previous = -1
  return words.map(w => {
    const t = Number(w?.t), end = Number(w?.end), text = String(w?.text ?? '').trim()
    if (!Number.isFinite(t) || !Number.isFinite(end) || t < 0 || end <= t || t < previous || end > duration + 0.02 || !text || text.length > 1000) throw new Error('Transcript words need ordered, finite source timings and nonempty text')
    previous = t
    return { t: round(t, 4), end: round(end, 4), text, ...(Number.isFinite(w.confidence) ? { confidence: Math.max(0, Math.min(1, w.confidence)) } : {}) }
  })
}

export function captionStyle(style = 'boxed') {
  const preset = typeof style === 'string' ? style : style?.preset ?? 'boxed'
  if (!CAPTION_STYLES[preset]) throw new Error(`Unknown caption style ${preset}`)
  return { ...CAPTION_STYLES[preset], ...(typeof style === 'object' ? structuredClone(style) : {}) }
}

function groupWords(words, options) {
  if (options.style?.preset === 'word') return words.map(w => ({ t: w.t, end: w.end, text: w.text, words: [w] }))
  return wordsToCaptions(words, { ...options, includeWords: true })
}

export function captionItems(project, src, inputWords, options = {}) {
  const words = validateWords(inputWords, project.assets?.[src]?.duration ?? Infinity)
  const style = captionStyle(options.style)
  const found = options.id ? findClip(project, options.id) : null
  const scope = options.comp ?? found?.comp ?? null
  const view = scope ? project.comps?.[scope] : project
  if (!view) throw new Error(`No composition ${scope}`)
  if (found && options.comp && found.comp !== options.comp) throw new Error('The selected clip is outside this composition')
  const seen = new Set(), warnings = []
  const uses = (view.tracks ?? []).filter(t => ['video', 'audio'].includes(t.kind)).flatMap(t => t.clips).filter(c => c.src === src && (!options.id || c.id === options.id)).filter(c => {
    if (c.reverse || c.freeze !== undefined || c.timeMap || !Number.isFinite(c.speed ?? 1) || (c.speed ?? 1) <= 0) {
      if (options.id) throw new Error('Captions require a forward clip with a positive scalar speed')
      warnings.push(`Skipped retimed clip ${c.id}`)
      return false
    }
    const key = c.link ? `${c.link}@${c.start}` : c.id
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (options.id && !uses.length) throw new Error(`Clip ${options.id} does not play ${src}`)
  const items = []
  const maxChars = Math.min(options.maxChars ?? 42, Math.max(8, Math.floor(view.width * 1080 / view.height * 0.9 / Math.max(1, style.size * 0.62))))
  for (const c of uses) {
    const speed = c.speed ?? 1, from = c.in ?? 0, to = from + c.dur * speed
    const mapped = words.filter(w => (w.t + w.end) / 2 >= from && (w.t + w.end) / 2 < to).map(w => ({
      ...w, sourceT: w.t, sourceEnd: w.end,
      t: round(c.start + (Math.max(w.t, from) - from) / speed, 4),
      end: round(c.start + (Math.min(w.end, to) - from) / speed, 4),
    }))
    for (const cue of groupWords(mapped, { ...options, maxChars, style })) items.push({ ...cue, end: Math.min(cue.end, c.start + c.dur), source: { src, clip: c.id } })
  }
  items.sort((a, b) => a.t - b.t)
  return { items, placed: uses.length > 0, clips: uses.map(c => c.id), comp: scope, style, warnings }
}

export function proposeShorts(inputWords, options = {}) {
  const words = validateWords(inputWords)
  const minDur = Number(options.minDur ?? 15), maxDur = Number(options.maxDur ?? 60), count = Number(options.count ?? 5)
  if (!Number.isFinite(minDur) || !Number.isFinite(maxDur) || minDur < 1 || maxDur < minDur || maxDur > 600 || !Number.isInteger(count) || count < 1 || count > 20) throw new Error('Choose 1 to 20 clips lasting 1 to 600 seconds')
  const terms = String(options.query ?? '').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  const candidates = [], boundaries = words.map((w, i) => i).filter(i => i === words.length - 1 || /[.!?]$/.test(words[i].text) || words[i + 1].t - words[i].end >= 0.5)
  const allStarts = words.map((w, i) => i).filter(i => i === 0 || words[i].t - words[i - 1].end >= 0.5 || /[.!?]$/.test(words[i - 1].text))
  const stride = Math.max(1, Math.ceil(allStarts.length / 2000)), starts = allStarts.filter((_, i) => i % stride === 0)
  const offsets = [], prefixMatches = [0]
  let transcript = ''
  for (const w of words) {
    offsets.push(transcript.length)
    transcript += `${w.text} `
    prefixMatches.push(prefixMatches.at(-1) + terms.filter(t => w.text.toLocaleLowerCase().includes(t)).length)
  }
  const collect = (candidateStarts, candidateEnds, wordBoundaries = false) => {
    function lower(time) {
      let a = 0, b = candidateEnds.length
      while (a < b) { const m = (a + b) >> 1; if (words[candidateEnds[m]].t < time) a = m + 1; else b = m }
      return a
    }
    for (const start of candidateStarts) {
      const choices = new Set()
      for (const target of [minDur, (minDur + maxDur) / 2, maxDur]) {
        const index = lower(words[start].t + target)
        for (let delta = -2; delta <= 2; delta++) if (candidateEnds[index + delta] !== undefined) choices.add(candidateEnds[index + delta])
      }
      let best = null
      for (const end of choices) {
        const dur = words[end].end - words[start].t
        if (end < start || dur < minDur || dur > maxDur) continue
        const matches = prefixMatches[end + 1] - prefixMatches[start]
        if (terms.length && !matches) continue
        const score = 2 + Math.min(terms.length, matches) * 3 + Math.min(1, (end - start + 1) / Math.max(1, dur) / 2) - Math.abs(dur - (minDur + maxDur) / 2) / maxDur
        const text = transcript.slice(offsets[start], offsets[end] + words[end].text.length)
        const reason = wordBoundaries ? matches ? 'Matches the query within a word-aligned range; review the phrase boundaries' : 'Uses word boundaries; review whether the passage is complete' : matches ? 'Matches the query and ends at a speech boundary' : 'Starts and ends at speech boundaries'
        const c = { from: words[start].t, to: words[end].end, score: round(score, 3), reason, evidence: text.slice(0, 6000), ...(text.length > 6000 ? { evidenceTruncated: true } : {}) }
        if (!best || c.score > best.score) best = c
      }
      if (best) candidates.push(best)
    }
  }
  collect(starts, boundaries)
  const fallbackWarnings = []
  if (!candidates.length && words.length) {
    const wordEnds = words.map((_, index) => index)
    const startBudget = terms.length && words.length > 2000 ? 500 : 2000
    const fallbackStride = Math.max(1, Math.ceil(wordEnds.length / startBudget))
    const fallbackStarts = new Set(wordEnds.filter((_, index) => index % fallbackStride === 0))
    if (terms.length) {
      const matches = wordEnds.filter(index => prefixMatches[index + 1] > prefixMatches[index])
      const matchStride = Math.max(1, Math.ceil(matches.length / 500))
      for (const match of matches.filter((_, index) => index % matchStride === 0)) {
        for (const before of [0, minDur, (minDur + maxDur) / 2]) {
          const time = Math.max(0, words[match].t - before)
          let a = 0, b = match + 1
          while (a < b) { const middle = (a + b) >> 1; if (words[middle].t < time) a = middle + 1; else b = middle }
          fallbackStarts.add(a)
        }
      }
    }
    collect([...fallbackStarts].sort((a, b) => a - b), wordEnds, true)
    if (candidates.length) fallbackWarnings.push('No sentence or pause range matched. Suggestions use word boundaries; review their opening and closing phrases.')
    if (fallbackStride > 1) fallbackWarnings.push(terms.length ? 'Word-boundary starts were sampled across the long transcript, including starts around query matches' : 'Word-boundary starts were sampled across the long transcript')
  }
  candidates.sort((a, b) => b.score - a.score || a.from - b.from)
  const selected = []
  for (const c of candidates) {
    if (selected.every(s => Math.max(0, Math.min(c.to, s.to) - Math.max(c.from, s.from)) < Math.min(c.to - c.from, s.to - s.from) * 0.25)) selected.push(c)
    if (selected.length >= count) break
  }
  return { candidates: selected, scoring: 'transcript-structure', warnings: [...(stride > 1 ? ['Candidate starts were sampled across the long transcript'] : []), ...fallbackWarnings, ...(selected.length ? [] : ['No speech range matches the requested duration and query'])] }
}

/**
 * Where the subject sits across a source range, from sampled grayscale frames (`frames`: one
 * Uint8Array of width*height luma per sample). Each column scores motion against the previous
 * sample plus a little horizontal detail, so a speaker in front of a still background scores
 * highest. For each sample the window as wide as the visible crop (`visible`, 0..1 of the source
 * width) with the most energy gives the center; centers are smoothed and only move when the
 * change is clear. Returns { centers: [0..1], confident } with 0.5 (the middle) where the energy
 * is spread evenly.
 */
export function subjectCenters(frames, width, height, visible) {
  const count = frames.length
  if (!count || !(visible > 0) || visible >= 1) return { centers: frames.map(() => 0.5), confident: false }
  const span = Math.max(1, Math.round(visible * width))
  const energy = frames.map((frame, i) => {
    const previous = frames[Math.max(0, i - 1)] === frame ? frames[Math.min(count - 1, i + 1)] : frames[Math.max(0, i - 1)]
    const columns = new Float64Array(width)
    for (let y = 0; y < height; y++) {
      const row = y * width
      for (let x = 0; x < width; x++) {
        const v = frame[row + x]
        columns[x] += Math.abs(v - previous[row + x]) + 0.25 * (x > 0 ? Math.abs(v - frame[row + x - 1]) : 0)
      }
    }
    return columns
  })
  // Steadier windows: each sample also counts its neighbours.
  const steady = energy.map((_, i) => {
    const out = new Float64Array(width)
    for (let j = Math.max(0, i - 2); j <= Math.min(count - 1, i + 2); j++) for (let x = 0; x < width; x++) out[x] += energy[j][x]
    return out
  })
  let clear = 0
  const raw = steady.map(columns => {
    const total = columns.reduce((a, b) => a + b, 0)
    let sum = 0
    for (let x = 0; x < span; x++) sum += columns[x]
    let best = sum, at = 0
    for (let x = span; x < width; x++) {
      sum += columns[x] - columns[x - span]
      if (sum > best) { best = sum; at = x - span + 1 }
    }
    // Only a window clearly richer than an even spread moves the frame.
    if (!(total > 0) || best / total < visible * 1.2) return 0.5
    clear++
    return (at + span / 2) / width
  })
  // Median of five, then a dead zone of a tenth of the crop so the frame does not drift.
  const median = raw.map((_, i) => { const near = raw.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b); return near[near.length >> 1] })
  const centers = []
  for (const c of median) centers.push(centers.length && Math.abs(c - centers.at(-1)) < visible * 0.1 ? centers.at(-1) : c)
  return { centers, confident: clear >= count / 2 }
}

/**
 * Position keys that keep `centers` (0..1 of the source width at `times`, clip seconds) in the
 * middle of a `cover`-fit crop, clamped so the frame stays covered. One center gives one x.
 */
export function framingKeys(centers, times, source, canvas) {
  const layerW = source.width * (canvas.height / source.height)
  const limit = Math.max(0, (layerW - canvas.width) / 2)
  const xs = centers.map(u => Math.round((canvas.width / 2 + Math.max(-limit, Math.min(limit, layerW * (0.5 - u)))) * 100) / 100)
  const keys = []
  xs.forEach((x, i) => { if (!keys.length || Math.abs(keys.at(-1)[1] - x) > 0.5 || i === xs.length - 1) keys.push([Math.round(times[i] * 1000) / 1000, x]) })
  const distinct = new Set(keys.map(k => k[1]))
  return distinct.size === 1 ? { x: keys[0][1] } : { keys }
}

export function buildShortsOps(project, options = {}) {
  const src = String(options.src ?? ''), asset = project.assets?.[src]
  if (!asset || !Number.isFinite(asset.duration) || asset.duration <= 0) throw new Error('Import a finite-duration audio or video source first')
  const ranges = options.ranges
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 20) throw new Error('Choose 1 to 20 source ranges')
  const width = Number(options.width ?? 1080), height = Number(options.height ?? 1920)
  if (![width, height].every(n => Number.isInteger(n) && n >= 64 && n <= 7680)) throw new Error('Composition dimensions must be 64 to 7680 pixels')
  const words = validateWords(options.words ?? [], asset.duration), style = captionStyle(options.captionStyle)
  let current = structuredClone(project)
  const ops = [], comps = []
  const add = op => { const result = applyOps(current, [op]); current = result.project; ops.push(op); return result }
  for (const range of ranges) {
    const from = Number(range.from), to = Number(range.to)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > 600 || to > asset.duration + 0.0001) throw new Error('Short clip ranges must stay inside the source and last at most 600 seconds')
    const duration = to - from, name = String(range.name ?? `Clip ${comps.length + 1}`).slice(0, 200)
    const comp = add({ op: 'add_comp', name, width, height, duration, background: '#000000' }).created[0]
    const framed = options.framing?.[comps.length]
    const framing = framed?.x !== undefined ? { x: framed.x } : framed?.keys?.length ? { anim: { x: framed.keys.map(([t, x]) => [t, x, 'smooth']) } } : {}
    add({ op: 'add_clip', comp, src, in: from, dur: duration, start: 0, track: !asset.hasVideo ? 'A1' : 'V1', kind: !asset.hasVideo ? 'audio' : 'video', set: { fit: 'cover', ...framing }, audio: true })
    if (options.captions !== false && words.length) {
      const result = captionItems(current, src, words, { comp, style })
      if (result.items.length) add({ op: 'captions', comp, items: result.items, style, burnIn: true })
    }
    comps.push({ id: comp, name, from, to, duration })
  }
  return { ops, comps }
}

export function transcriptDeleteOps(project, options = {}) {
  const found = findClip(project, options.id)
  if (!found || !['video', 'audio'].includes(found.clip.kind)) throw new Error('Select a media clip for transcript editing')
  const c = found.clip, comp = options.comp ?? found.comp ?? null
  if (comp !== (found.comp ?? null)) throw new Error('The selected clip is outside this composition')
  if (c.reverse || c.freeze !== undefined || c.timeMap || (c.speed ?? 1) <= 0) throw new Error('Transcript cuts require a forward clip with a positive scalar speed')
  const ranges = options.ranges
  if (!Array.isArray(ranges) || !ranges.length || ranges.length > 1000) throw new Error('Choose 1 to 1000 source ranges')
  const from = c.in ?? 0, to = from + c.dur * (c.speed ?? 1)
  const mapped = ranges.map(r => {
    const a = Math.max(from, Number(r.from)), b = Math.min(to, Number(r.to))
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) throw new Error('The transcript cut must overlap the selected clip source range')
    return { from: c.start + (a - from) / (c.speed ?? 1), to: c.start + (b - from) / (c.speed ?? 1) }
  }).sort((a, b) => a.from - b.from)
  const merged = []
  for (const r of mapped) { const last = merged[merged.length - 1]; if (last && r.from <= last.to) last.to = Math.max(last.to, r.to); else merged.push({ ...r }) }
  const ops = [], descendants = new Set([c.id])
  let current = structuredClone(project)
  const add = op => {
    const result = applyOps(current, [op])
    current = result.project
    ops.push(op)
    for (const id of result.created) descendants.add(id)
  }
  for (const r of [...merged].reverse()) {
    const head = findClip(current, c.id)
    if (!head) throw new Error('The selected clip changed while planning transcript cuts')
    for (const at of [r.to, r.from]) if (at > head.clip.start + 1e-6 && at < head.clip.start + head.clip.dur - 1e-6) add({ op: 'blade', id: c.id, at, ...(comp ? { comp } : {}) })
    const view = comp ? current.comps[comp] : current
    const track = view.tracks.find(t => t.id === found.track.id)
    const target = track.clips.find(x => descendants.has(x.id) && x.src === c.src && Math.abs(x.start - r.from) < 1 / (view.fps ?? project.fps) && x.start + x.dur <= r.to + 1 / (view.fps ?? project.fps))
    if (!target) throw new Error('The transcript passage does not cover a selected clip segment')
    add({ op: options.ripple === true ? 'ripple_delete' : 'delete', id: target.id, ...(comp ? { comp } : {}) })
  }
  return { ops, ranges: merged, comp }
}

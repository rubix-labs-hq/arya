// Corrections to the word timings a speech recognizer returns, made before a transcript is saved.
//
// whisper.cpp times each word from the end of the word before it, so a pause is charged to a word
// beside it, and a run of words can land wholly inside a pause in which nobody speaks. A cut that
// removes the pause then removes those words from the captions. Two corrections, both in source
// seconds:
//   - clampWordsToDuration: no word ends after the file does;
//   - keepWordsInSpeech: every word sits in sound, not in a measured pause.
// Neither invents or rewrites text. Moved timings are estimates.

const r4 = value => Math.round(value * 10000) / 10000
const MIN_WORD = 0.02
// A word counts as spoken in a speech range when at least this much of it, or half of it, is there.
const MIN_OVERLAP = 0.06
// Sound shorter than this between two pauses is a click or a breath, not a place for words.
const MIN_SPEECH = 0.15
// Words moved out of a pause take their room from this many times their own length of neighbours.
const WINDOW = 1.5
const SENTENCE_END = /[.!?…]["'”’)\]]*$/

/**
 * Words whose end runs past the file are cut at its end, and words that start at or after its end
 * are left out. Returns { words, dropped } where dropped counts the words left out.
 */
export function clampWordsToDuration(words, duration) {
  if (!Array.isArray(words) || !(duration > 0) || !Number.isFinite(duration)) return { words: Array.isArray(words) ? words : [], dropped: 0 }
  const kept = []
  for (const word of words) {
    if (!(word.t < duration)) continue
    const end = Math.min(word.end, duration)
    if (!(end - word.t >= 0.001)) continue
    kept.push(end === word.end ? word : { ...word, end })
  }
  return { words: kept, dropped: words.length - kept.length }
}

/** The parts of [0, duration] outside `pauses`, without the ones too short to hold a word. */
export function speechRanges(pauses, duration) {
  const ranges = []
  let at = 0
  for (const [from, to] of [...pauses].sort((a, b) => a[0] - b[0])) {
    if (from - at >= MIN_SPEECH) ranges.push([at, Math.min(from, duration)])
    at = Math.max(at, to)
  }
  if (duration - at >= MIN_SPEECH) ranges.push([at, duration])
  return ranges
}

/** Maps [s0, s1] onto [t0, t1] in a straight line. */
const line = (s0, s1, t0, t1) => x => s1 > s0 ? t0 + (Math.min(s1, Math.max(s0, x)) - s0) * (t1 - t0) / (s1 - s0) : t0

// A word timed in a pause has a length that is mostly pause. It gets at most the time its letters
// take to say at an ordinary pace.
const spoken = word => Math.min(word.end - word.t, 0.1 + 0.07 * [...String(word.text)].length)

/** Lays the words of one speech range out inside it. Returns null when they cannot fit. */
function fitRange(group, [a, b]) {
  const lead = group.findIndex(item => item.inside), last = group.findLastIndex(item => item.inside)
  // Every word already in the range is trimmed to it.
  const out = group.map(item => item.inside ? { t: Math.max(item.word.t, a), end: Math.min(item.word.end, b) } : { t: item.word.t, end: item.word.end })
  /** Puts the words from..to one after another from `at`, each as long as it takes to say. */
  const chain = (from, to, at) => { for (let index = from; index <= to; index++) { out[index].t = at; at += spoken(group[index].word); out[index].end = at } return at }
  if (lead < 0) {
    // Nothing was timed in this range. The words go to the end of it when they came from the
    // pause after it, else to its start.
    const length = chain(0, out.length - 1, 0), room = Math.min(b - a, length), start = group[0].side === 'before' ? b - room : a
    const map = line(0, length, start, start + room)
    for (const time of out) { time.t = map(time.t); time.end = map(time.end) }
  } else {
    if (last + 1 < out.length) {
      // Words after the last spoken one follow it. When they run past the end of the range, they
      // and the spoken words just before them are squeezed evenly to end with it.
      const edge = Math.min(b, out[last].end), length = chain(last + 1, out.length - 1, edge) - edge
      if (edge + length > b) {
        let first = last
        while (first > lead && edge - out[first].t < length * WINDOW) first--
        const map = line(out[first].t, edge + length, out[first].t, b)
        for (const time of out.slice(first)) { time.t = map(time.t); time.end = map(time.end) }
      }
    }
    if (lead > 0) {
      // Words before the first spoken one lead up to it, squeezed the same way when they start too early.
      const edge = Math.max(a, out[lead].t), length = chain(0, lead - 1, 0)
      for (const time of out.slice(0, lead)) { time.t += edge - length; time.end += edge - length }
      if (edge - length < a) {
        let final = lead
        while (final < last && out[final].end - edge < length * WINDOW) final++
        const map = line(edge - length, out[final].end, a, out[final].end)
        for (const time of out.slice(0, final + 1)) { time.t = map(time.t); time.end = map(time.end) }
      }
    }
  }
  let previous = a
  for (const time of out) {
    time.t = r4(time.t); time.end = r4(time.end)
    if (!(time.t >= previous - 1e-4) || !(time.end - time.t >= MIN_WORD) || time.end > b + 1e-4) return null
    previous = time.t
  }
  return out
}

/**
 * Moves word timings out of pauses. `pauses` are [start, end] pairs in source seconds, in order.
 * A word that runs into a pause is cut at the edge of the speech. Words timed wholly inside a
 * pause move to the speech beside it: before the pause when they end a sentence or the pause is
 * the last thing in the file, after it when the sentence ended before them, else the nearer side.
 * The nearest spoken words are squeezed evenly to make room. Order and text never change. When the
 * words of a range cannot be fitted, that range keeps the timings it had.
 * Returns { words, moved, trimmed }.
 */
export function keepWordsInSpeech(words, pauses, duration) {
  const same = { words, moved: 0, trimmed: 0 }
  try {
    if (!Array.isArray(words) || !words.length || !Array.isArray(pauses) || !pauses.length || !(duration > 0)) return same
    const ranges = speechRanges(pauses.filter(pause => Array.isArray(pause) && pause[1] > pause[0]), duration)
    if (!ranges.length) return same
    const overlap = (word, [a, b]) => Math.min(word.end, b) - Math.max(word.t, a)
    const items = words.map(word => {
      let best = -1, most = 0
      ranges.forEach((range, index) => { const shared = overlap(word, range); if (shared > most) { most = shared; best = index } })
      const inside = best >= 0 && (most >= MIN_OVERLAP || most >= (word.end - word.t) / 2)
      // A word that only touches a range belongs to it, but is too short there to be trimmed to it.
      return { word, inside, range: inside ? best : -1, touches: !inside && best >= 0 ? best : null }
    })
    // A run of words in one gap between two speech ranges is split between those ranges.
    for (let start = 0; start < items.length;) {
      if (items[start].inside) { start++; continue }
      let end = start
      while (end + 1 < items.length && !items[end + 1].inside) end++
      const before = start > 0 ? items[start - 1].range : -1
      const after = end + 1 < items.length ? items[end + 1].range : ranges.length
      const middle = word => (word.t + word.end) / 2
      for (let low = before; low < after; low++) {
        // The gap between range `low` and range `low + 1`. -1 and ranges.length are the file's ends.
        const from = low >= 0 ? ranges[low][1] : -Infinity, to = low + 1 < ranges.length ? ranges[low + 1][0] : Infinity
        const here = []
        for (let index = start; index <= end; index++) if (middle(items[index].word) >= from && middle(items[index].word) < to) here.push(index)
        if (!here.length) continue
        let toPrevious = 0
        if (low < 0) toPrevious = 0
        else if (low + 1 >= ranges.length) toPrevious = here.length
        else {
          const ends = here.findLastIndex(index => SENTENCE_END.test(items[index].word.text))
          if (ends >= 0) toPrevious = ends + 1
          else if (here[0] > 0 && SENTENCE_END.test(items[here[0] - 1].word.text)) toPrevious = 0
          else toPrevious = here.filter(index => middle(items[index].word) - from <= to - middle(items[index].word)).length
        }
        // Words that touch a range stay with it, whatever the rule above says.
        while (toPrevious < here.length && items[here[toPrevious]].touches === low) toPrevious++
        while (toPrevious > 0 && low + 1 < ranges.length && items[here[toPrevious - 1]].touches === low + 1) toPrevious--
        here.forEach((index, order) => { items[index].range = order < toPrevious ? low : low + 1; items[index].side = order < toPrevious ? 'before' : 'after' })
      }
      for (let index = start; index <= end; index++) if (items[index].range < 0 || items[index].range >= ranges.length) items[index].range = Math.max(0, Math.min(ranges.length - 1, items[index].range < 0 ? after : before))
      start = end + 1
    }
    // Ranges never go backwards along the transcript.
    for (let index = 1; index < items.length; index++) if (items[index].range < items[index - 1].range) { items[index].range = items[index - 1].range; items[index].inside = false }
    const out = []
    let moved = 0, trimmed = 0
    for (let start = 0; start < items.length;) {
      let end = start
      while (end + 1 < items.length && items[end + 1].range === items[start].range) end++
      const group = items.slice(start, end + 1), fitted = fitRange(group, ranges[items[start].range])
      group.forEach((item, order) => {
        const time = fitted?.[order]
        if (!time || time.t === r4(item.word.t) && time.end === r4(item.word.end)) { out.push(item.word); return }
        if (item.inside && time.t >= r4(item.word.t) - 1e-4 && time.end <= r4(item.word.end) + 1e-4) trimmed++
        else moved++
        out.push({ ...item.word, t: time.t, end: time.end })
      })
      start = end + 1
    }
    // The result must still be an ordered transcript, or nothing is changed.
    for (let index = 0; index < out.length; index++) if (!(out[index].end > out[index].t) || index && out[index].t < out[index - 1].t) return same
    return { words: out, moved, trimmed }
  } catch {
    return same
  }
}

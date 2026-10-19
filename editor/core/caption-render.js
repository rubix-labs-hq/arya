// Shared caption appearance and active-word ranges, using clip-local word timings.

const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Matches timed words across layout whitespace, retaining original UTF-16 offsets. */
export function captionWordRanges(clip) {
  const text = String(clip.text ?? ''), ranges = []
  let cursor = 0
  for (const word of clip.words ?? []) {
    const pieces = String(word.text ?? '').trim().split(/\s+/u).filter(Boolean)
    if (!pieces.length) { ranges.push(null); continue }
    const pattern = new RegExp(pieces.map(escaped).join('\\s+'), 'gu')
    pattern.lastIndex = cursor
    const match = pattern.exec(text)
    if (!match) { ranges.push(null); continue }
    const range = { start: match.index, end: match.index + match[0].length }
    cursor = range.end
    ranges.push(range)
  }
  return ranges
}

export function captionTitle(clip, style = {}, local = 0, canvas = {}) {
  style = { ...style, ...(clip.style ?? {}) }
  const text = String(clip.text ?? '')
  const title = {
    text, font: style.font ?? 'Helvetica Neue', size: style.size ?? 52,
    weight: style.weight ?? 600, color: style.color ?? '#ffffff',
    plate: style.plate ?? '#000000aa', padding: style.padding ?? 14,
    radius: style.radius ?? 6, align: style.align ?? 'center', lineHeight: style.lineHeight ?? 1.2,
  }
  const sized = Number.isFinite(canvas.width) && Number.isFinite(canvas.height) && canvas.height > 0
  // Title units are 1080p pixels scaled to the frame height, so a 9:16 frame is 607 units wide.
  const available = sized ? Math.max(1, canvas.width * 1080 / canvas.height * 0.9) : 0
  if (style.preset && sized) {
    title.box = { width: available, height: title.size * title.lineHeight * (style.preset === 'word' ? 1 : style.maxLines ?? 2), wrap: true, autoHeight: true, alignY: 'center' }
  } else if (sized) {
    // Captions without a preset wrap when a line could run off the frame. The estimate is generous
    // (0.6 em per character), so a caption that fits keeps its single-line layout and tight plate.
    const longest = Math.max(0, ...text.split('\n').map(line => [...line].length))
    // shrink: the plate stays as wide as the longest line, so a caption that fits on one line
    // renders exactly as it did before wrapping existed.
    if (longest * title.size * 0.6 > available * 0.85) title.box = { width: available, height: title.size * title.lineHeight, wrap: true, autoHeight: true, alignY: 'center', shrink: true }
  }
  if (style.preset === 'word' && clip.words?.length) {
    title.text = (clip.words.find(word => word.t <= local && local < word.end)?.text ?? '').trim()
    return title
  }
  if (style.preset !== 'karaoke') return title
  const ranges = captionWordRanges(clip)
  for (const [index, word] of (clip.words ?? []).entries()) {
    const range = ranges[index]
    if (!range) continue
    if (word.t <= local && local < word.end) {
      title.highlight = { ...range, color: style.highlightColor ?? '#ffe600' }
      break
    }
  }
  return title
}

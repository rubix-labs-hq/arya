import { captionWordRanges } from '../../core/caption-render.js'

/** Edit a timeline cue while retaining its source transcript timings. */
export function captionWordUpdate(clip, index, patch, comp = null, fps = 30) {
  if (clip?.kind !== 'caption' || !Number.isFinite(clip.dur) || clip.dur <= 0 || !Array.isArray(clip.words) || !Number.isInteger(index) || !clip.words[index]) throw new Error('Select a timed caption word first')
  const prior = clip.words[index], next = { ...prior, ...patch }
  if (Object.keys(patch).some(key => !['text', 't', 'end'].includes(key))) throw new Error('Only the word text and cue timing can change')
  const tolerance = Number.isFinite(fps) && fps > 0 ? 1 / fps + 1e-6 : 1 / 30 + 1e-6
  if (!Object.hasOwn(patch, 't') && next.t < 0 && next.t >= -tolerance) next.t = 0
  if (!Object.hasOwn(patch, 'end') && next.end > clip.dur && next.end <= clip.dur + tolerance) next.end = clip.dur
  next.text = String(next.text ?? '').trim()
  if (!next.text || next.text.length > 1000) throw new Error('A caption word needs 1 to 1000 characters')
  if (!Number.isFinite(next.t) || !Number.isFinite(next.end) || next.t < 0 || next.end <= next.t || next.end > clip.dur) throw new Error('Word timing must stay inside this caption cue, with its end after its start')
  if (index > 0 && next.t < clip.words[index - 1].t || index + 1 < clip.words.length && next.t > clip.words[index + 1].t) throw new Error('Word starts must stay in transcript order')
  let text = String(clip.text ?? '')
  if (next.text !== prior.text) {
    const range = captionWordRanges(clip)[index]
    if (!range) throw new Error('This word no longer matches the caption text. Correct the cue text before editing its words')
    text = text.slice(0, range.start) + next.text + text.slice(range.end)
  }
  const words = clip.words.map((word, i) => i === index ? next : { ...word })
  return { op: 'update', id: clip.id, comp, set: { text, words } }
}

export function captionPlate(plate) {
  if (plate === 'transparent') return { color: '#000000', alpha: 0 }
  const value = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(plate ?? '') ? plate : '#000000aa'
  return { color: value.slice(0, 7), alpha: value.length === 9 ? parseInt(value.slice(7), 16) / 255 : 1 }
}

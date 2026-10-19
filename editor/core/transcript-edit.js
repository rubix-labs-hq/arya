import { parseSRT, parseVTT } from './interchange.js'
import { validateWords } from './shorts.js'

export const MAX_TIMED_TRANSCRIPT_BYTES = 16 * 1024 * 1024

const seconds = value => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value.trim()))) throw new Error('Use a finite time in seconds')
  const result = Number(value)
  if (!Number.isFinite(result)) throw new Error('Use a finite time in seconds')
  return result
}

function checkedWords(input, duration) {
  const words = validateWords(input, duration)
  if (words.some(word => word.end <= word.t || word.end > duration)) throw new Error('Word times must fit the source and have a positive duration after rounding')
  return words
}

/** Updates source seconds without moving neighboring words. Overlapping speech is retained. */
export function updateTranscriptTiming(words, index, changes, duration) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= words.length) throw new Error('Select one transcript word to edit its timing')
  const next = words.map((word, i) => i === index ? { ...word, ...Object.fromEntries(['t', 'end'].filter(key => key in changes).map(key => [key, seconds(changes[key])])) } : word)
  return checkedWords(next, duration)
}

const CUE_TIME = '(?:(?:\\d{2,}):)?[0-5]\\d:[0-5]\\d[.,]\\d{1,3}'
const TIMING = new RegExp(`^\\s*(${CUE_TIME})\\s*-->\\s*(${CUE_TIME})(?:[ \\t]+[^\\r\\n]*)?$`)

function subtitleCues(text, vtt) {
  if (vtt && !/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text)) throw new Error('A WebVTT transcript must begin with WEBVTT')
  const blocks = text.trim().split(/\n[ \t]*\n/), cues = []
  for (const block of blocks) {
    const lines = block.split('\n')
    if (vtt && /^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/.test(lines[0])) {
      if (/^WEBVTT(?:[ \t]|$)/.test(lines[0]) && lines.some(line => line.includes('-->'))) throw new Error('Separate the WebVTT header and the first cue with a blank line')
      continue
    }
    const at = TIMING.test(lines[0]) ? 0 : TIMING.test(lines[1] ?? '') ? 1 : -1
    if (at < 0 || (!vtt && at === 1 && !/^\d+$/.test(lines[0].trim()))) throw new Error('Each subtitle cue needs a valid start and end time')
    if (lines.slice(at + 1).some(line => /^\s*\d.*-->/.test(line))) throw new Error('Separate subtitle cues with blank lines')
    const parsed = (vtt ? parseVTT : parseSRT)(lines.slice(at).join('\n'))
    if (parsed.length !== 1) throw new Error('Each subtitle cue needs text and a positive duration')
    cues.push(parsed[0])
  }
  return cues
}

/** Reads exact timed JSON words, or estimates word times inside subtitle cues. */
export function parseTimedTranscript(text, filename, duration) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > MAX_TIMED_TRANSCRIPT_BYTES) throw new Error('Choose a timed transcript smaller than 16 MB')
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Choose a finite-duration source with audio first')
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  const format = String(filename ?? '').split('.').at(-1).toLowerCase()
  let input, warnings = []
  if (format === 'json') {
    const parsed = JSON.parse(text)
    input = Array.isArray(parsed) ? parsed : parsed?.words
    if (!Array.isArray(input) || input.some(word => typeof word?.t !== 'number' || typeof word?.end !== 'number' || typeof word?.text !== 'string')) throw new Error('Timed JSON needs words with numeric t and end in source seconds and a text string')
  } else if (format === 'srt' || format === 'vtt') {
    const cues = subtitleCues(text, format === 'vtt')
    input = []
    for (const cue of cues) {
      const tokens = cue.text.trim().split(/\s+/u)
      if (input.length + tokens.length > 100000) throw new Error('A transcript must contain at most 100000 words')
      tokens.forEach((token, i) => input.push({ t: cue.t + (cue.end - cue.t) * i / tokens.length, end: cue.t + (cue.end - cue.t) * (i + 1) / tokens.length, text: token }))
    }
    input.sort((a, b) => a.t - b.t)
    warnings = ['Subtitle files contain cue timing. Word times are estimated evenly within each cue. Review them before captions or shorts.']
  } else throw new Error('Choose an SRT, WebVTT .vtt, or timed JSON transcript')
  if (!input.length) throw new Error('The file has no timed transcript words')
  const words = checkedWords(input, duration)
  return { words, from: words[0].t, to: words.reduce((end, word) => Math.max(end, word.end), 0), format, warnings }
}

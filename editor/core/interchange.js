// Reel interchange: captions (SRT, WebVTT), Final Cut Pro XML (FCPXML 1.11) and
// OpenTimelineIO JSON. Pure functions with no Node, DOM or structuredClone, so the native
// app can run this file in JavaScriptCore next to project.js.
//
// Times inside this file are counted in whole frames of the project rate wherever they
// reach a file, so a round trip lands every start, duration and in point on the same frame.
//
// Reel-only data (grades, keyframes, styling, ids, compositions) travels in each format's
// metadata: FCPXML <md key="reel.*"> and OTIO metadata.reel. Importers take timing, sources
// and text from the file's structure and use the metadata only for what the structure
// cannot say, so a file edited in another application still imports by its structure.

import { FORMAT_VERSION, MARKER_COLORS, TRANSITIONS, hasAudio, migrate, round } from './project.js'

// ---------------------------------------------------------------- small helpers

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))
const isNum = v => typeof v === 'number' && Number.isFinite(v)
const numOr = (v, fallback) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v))
const basename = p => String(p ?? '').split('/').filter(Boolean).pop() ?? ''
const stem = p => basename(p).replace(/\.[^.]+$/, '')
const MEDIA_KINDS = new Set(['video', 'image', 'audio'])

function omit(obj, keys) {
  const out = {}
  for (const [k, v] of Object.entries(obj ?? {})) if (!keys.includes(k)) out[k] = v

  return out
}

function defined(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj ?? {})) if (v !== undefined) out[k] = v

  return out
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b]

  return a || 1
}

// ---------------------------------------------------------------- frame rates and time

/** The frame duration of a rate as num/den seconds: 29.97 → 1001/30000, 25 → 100/2500. */
export function rateOf(fps) {
  const n = Math.round(fps)
  if (n > 0 && Math.abs(fps - n) < 1e-6) return { num: 100, den: n * 100 }
  const ntsc = Math.round(fps * 1.001)
  if (ntsc > 0 && Math.abs(fps - (ntsc * 1000) / 1001) < 0.005) return { num: 1001, den: ntsc * 1000 }

  return { num: 1000, den: Math.round(fps * 1000) }
}

/** The exact rate behind a Reel frame rate: 29.97 → 30000/1001. */
export const exactRate = fps => {
  const r = rateOf(fps)

  return r.den / r.num
}

/** A file's rate as Reel stores it: 29.97002997 → 29.97, 24000/1001 → 23.976. */
export const normalizeFps = rate => Math.round(rate * 1000) / 1000

function frameTime(f, r) {
  const n = f * r.num

  return n % r.den === 0 ? `${n / r.den}s` : `${n}/${r.den}s`
}

/** Seconds as an FCPXML time: on the frame grid when it lands there, else a fine rational. */
function secondsTime(s, r) {
  const f = (s * r.den) / r.num
  if (Math.abs(f - Math.round(f)) < 1e-6) return frameTime(Math.round(f), r)
  const den = r.den * 10000
  const n = Math.round(s * den)
  const g = gcd(Math.abs(n), den)

  return den / g === 1 ? `${n / g}s` : `${n / g}/${den / g}s`
}

/** Parses an FCPXML time ("1001/30000s", "5s", "2.5s") into seconds. */
export function parseTime(v) {
  if (v === undefined || v === null || v === '') return undefined
  const m = /^\s*(-?\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?s?\s*$/.exec(String(v))
  if (!m) return undefined
  const den = m[2] ? Number(m[2]) : 1

  return den ? Number(m[1]) / den : undefined
}

function parseRational(v) {
  const m = /^\s*(\d+)(?:\/(\d+))?s?\s*$/.exec(String(v ?? ''))
  if (!m) return null

  return { num: Number(m[1]), den: Number(m[2] ?? 1) }
}

// ---------------------------------------------------------------- colors and paths

function hexToRGBA(hex) {
  let h = String(hex ?? '').trim().replace(/^#/, '')
  if (!/^[0-9a-f]+$/i.test(h)) return null
  if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('')
  if (h.length !== 6 && h.length !== 8) return null

  return [0, 2, 4, 6].map(i => (i < h.length ? parseInt(h.slice(i, i + 2), 16) / 255 : 1))
}

const fcpColor = (hex, fallback = '#ffffff') => (hexToRGBA(hex) ?? hexToRGBA(fallback)).map(v => String(Math.round(v * 10000) / 10000)).join(' ')

function fromFcpColor(str) {
  const v = String(str ?? '').trim().split(/\s+/).map(Number)
  if (v.length < 3 || v.some(x => !Number.isFinite(x))) return undefined
  const h = n => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0')

  return `#${h(v[0])}${h(v[1])}${h(v[2])}${v.length > 3 && v[3] < 1 ? h(v[3]) : ''}`
}

function normalizePath(p) {
  const abs = p.startsWith('/')
  const out = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }

  return (abs ? '/' : '') + out.join('/')
}

/** A media path from the project (relative to the project folder, or absolute) as an absolute path. */
export function absolutePath(src, root) {
  const s = String(src ?? '')

  return s.startsWith('/') ? normalizePath(s) : normalizePath(`${String(root ?? '').replace(/\/+$/, '')}/${s}`)
}

/** file:// URL of an absolute path, each segment percent-encoded ("Mod Systems" → "Mod%20Systems"). */
export function fileURL(abs) {
  return `file://${String(abs).split('/').map(seg => encodeURIComponent(seg)).join('/')}`
}

/** The path inside a file:// URL (or a plain path, returned as is). */
export function pathFromURL(url) {
  let s = String(url ?? '')
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:(\/\/(localhost)?)?/i, '')
    try {
      s = decodeURIComponent(s)
    } catch {}
  }

  return s
}

/** An absolute path as the project names media: relative inside the project folder, else absolute. */
export function projectPath(abs, root) {
  const r = normalizePath(String(root ?? ''))
  if (r && r !== '/' && abs.startsWith(`${r}/`)) return abs.slice(r.length + 1)

  return abs
}

// ---------------------------------------------------------------- XML

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(t) {
  if (t.indexOf('&') < 0) return t

  return t.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (m, e) => {
    if (e[0] !== '#') return XML_ENTITIES[e] ?? m
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    try {
      return String.fromCodePoint(code)
    } catch {
      return m
    }
  })
}

const XML_NAME = /[A-Za-z_:][\w.:-]*/y
const XML_ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y
const isSpace = c => c === ' ' || c === '\n' || c === '\t' || c === '\r'

/**
 * A small, strict XML parser (JavaScriptCore has no DOMParser). Returns
 * { name: '#document', children } where elements are { name, attrs, children }
 * and text is { text }. Comments, processing instructions and the DOCTYPE are skipped.
 */
export function parseXML(src) {
  const s = String(src)
  const root = { name: '#document', attrs: {}, children: [] }
  const stack = [root]
  const top = () => stack[stack.length - 1]
  const text = t => {
    if (t) top().children.push({ text: t })
  }
  let i = s.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < s.length) {
    const lt = s.indexOf('<', i)
    if (lt < 0) {
      text(decodeEntities(s.slice(i)))
      break
    }
    if (lt > i) text(decodeEntities(s.slice(i, lt)))
    if (s.startsWith('<!--', lt)) {
      const e = s.indexOf('-->', lt + 4)
      if (e < 0) throw new Error('XML: a comment is not closed')
      i = e + 3
      continue
    }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9)
      if (e < 0) throw new Error('XML: a CDATA section is not closed')
      text(s.slice(lt + 9, e))
      i = e + 3
      continue
    }
    if (s.startsWith('<?', lt)) {
      const e = s.indexOf('?>', lt + 2)
      if (e < 0) throw new Error('XML: a processing instruction is not closed')
      i = e + 2
      continue
    }
    if (s.startsWith('<!', lt)) {
      // DOCTYPE, possibly with an internal subset in brackets.
      let j = lt + 2
      let depth = 0
      let quote = null
      for (; j < s.length; j++) {
        const ch = s[j]
        if (quote) {
          if (ch === quote) quote = null
        } else if (ch === '"' || ch === "'") quote = ch
        else if (ch === '[') depth++
        else if (ch === ']') depth--
        else if (ch === '>' && depth <= 0) break
      }
      i = j + 1
      continue
    }
    if (s[lt + 1] === '/') {
      const e = s.indexOf('>', lt)
      if (e < 0) throw new Error('XML: a closing tag is not finished')
      const name = s.slice(lt + 2, e).trim()
      const open = stack.pop()
      if (!open || open === root || open.name !== name) throw new Error(`XML: </${name}> does not close <${open?.name ?? 'nothing'}>`)
      i = e + 1
      continue
    }
    XML_NAME.lastIndex = lt + 1
    const m = XML_NAME.exec(s)
    if (!m) throw new Error(`XML: a tag at character ${lt} has no name`)
    const node = { name: m[0], attrs: {}, children: [] }
    let j = XML_NAME.lastIndex
    for (;;) {
      while (j < s.length && isSpace(s[j])) j++
      if (j >= s.length) throw new Error(`XML: <${node.name}> is not finished`)
      if (s[j] === '>') {
        top().children.push(node)
        stack.push(node)
        j++
        break
      }
      if (s[j] === '/' && s[j + 1] === '>') {
        top().children.push(node)
        j += 2
        break
      }
      XML_ATTR.lastIndex = j
      const a = XML_ATTR.exec(s)
      if (!a) throw new Error(`XML: a malformed attribute in <${node.name}>`)
      node.attrs[a[1]] = decodeEntities((a[2] ?? a[3]).replace(/[\t\n\r]/g, ' '))
      j = XML_ATTR.lastIndex
    }
    i = j
  }
  if (stack.length > 1) throw new Error(`XML: <${top().name}> is not closed`)

  return root
}

const elements = (n, name) => (n?.children ?? []).filter(c => c.name && (!name || c.name === name))
const child = (n, name) => (n?.children ?? []).find(c => c.name === name) ?? null

function textOf(n) {
  if (!n) return ''
  if (n.text !== undefined) return n.text

  return n.children.map(textOf).join('')
}

function findFirst(n, pred) {
  for (const c of n?.children ?? []) {
    if (!c.name) continue
    if (pred(c)) return c
    const r = findFirst(c, pred)
    if (r) return r
  }

  return null
}

const escText = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = s => escText(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')

function el(name, attrs = {}, children = []) {
  return { name, attrs, children: children.flat().filter(Boolean) }
}

const txt = t => ({ text: String(t) })
const INLINE = new Set(['text', 'text-style', 'note'])

function serialize(node, indent = '') {
  if (node.text !== undefined) return escText(node.text)
  const attrs = Object.entries(node.attrs)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${escAttr(v)}"`)
    .join('')
  if (!node.children.length) return `${indent}<${node.name}${attrs}/>`
  if (INLINE.has(node.name)) return `${indent}<${node.name}${attrs}>${node.children.map(c => serialize(c, '')).join('')}</${node.name}>`

  return `${indent}<${node.name}${attrs}>\n${node.children.map(c => serialize(c, `${indent}    `)).join('\n')}\n${indent}</${node.name}>`
}

// ---------------------------------------------------------------- captions: SRT and WebVTT

function clockTime(t, sep) {
  const ms = Math.max(0, Math.round(t * 1000))
  const pad = (n, w = 2) => String(n).padStart(w, '0')

  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${sep}${pad(ms % 1000, 3)}`
}

/** Caption items { t, end, text } of a caption track (the first one when trackId is not given). */
export function captionItems(project, trackId) {
  const track = (project?.tracks ?? []).find(t => t.kind === 'caption' && (!trackId || t.id === trackId))
  if (!track && trackId) throw new Error(`no caption track ${trackId}`)

  return (track?.clips ?? [])
    .filter(c => c.enabled !== false && String(c.text ?? '').trim())
    .map(c => ({ t: c.start, end: c.start + c.dur, text: String(c.text) }))
    .sort((a, b) => a.t - b.t)
}

const cueText = s => String(s).replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean).join('\n')

export function toSRT(project, trackId) {
  return captionItems(project, trackId)
    .map((c, i) => `${i + 1}\n${clockTime(c.t, ',')} --> ${clockTime(c.end, ',')}\n${cueText(c.text)}\n`)
    .join('\n')
}

export function toVTT(project, trackId) {
  const esc = s => cueText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/-->/g, '->')
  const cues = captionItems(project, trackId).map(c => `${clockTime(c.t, '.')} --> ${clockTime(c.end, '.')}\n${esc(c.text)}\n`)

  return `WEBVTT\n\n${cues.join('\n')}`
}

const CUE_TIME = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/
const TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})/

function cueSeconds(s) {
  const m = CUE_TIME.exec(s)
  if (!m) return NaN

  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000
}

function plainCueText(lines) {
  return decodeEntities(lines.join('\n').replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '').replace(/&nbsp;/g, ' '))
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
}

function parseCues(text, vtt) {
  const blocks = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)
  const out = []
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i, all) => l.trim() || (i > 0 && i < all.length - 1))
    if (!lines.length) continue
    if (vtt && /^(WEBVTT|NOTE|STYLE|REGION)\b/.test(lines[0].trim()) && !lines.some(l => TIMING.test(l))) continue
    const at = lines.findIndex(l => TIMING.test(l))
    if (at < 0) continue
    const [, a, b] = TIMING.exec(lines[at])
    const t = cueSeconds(a)
    const end = cueSeconds(b)
    const body = plainCueText(lines.slice(at + 1))
    if (!Number.isFinite(t) || !Number.isFinite(end) || end <= t || !body) continue
    out.push({ t: round(t, 3), end: round(end, 3), text: body })
  }

  return out.sort((x, y) => x.t - y.t)
}

/** Parses SubRip text into [{ t, end, text }] (seconds); styling tags are dropped. */
export const parseSRT = text => parseCues(text, false)

/** Parses WebVTT into [{ t, end, text }]; NOTE, STYLE and REGION blocks and cue settings are skipped. */
export const parseVTT = text => parseCues(text, true)

// ---------------------------------------------------------------- words → captions

const ATTACHES_LEFT = /^(?:[^\p{L}\p{N}([{“‘¿¡"]+|['’](?:s|t|re|ve|ll|d|m)|n['’]t)$/iu
const ATTACHES_RIGHT = /^[([{“‘¿¡"]+$/u

/** Splits words into at most maxLines lines of maxChars, balanced; null when they do not fit. */
function layoutLines(words, maxChars, maxLines) {
  const joined = words.join(' ')
  if (joined.length <= maxChars || words.length === 1) return [joined]
  if (maxLines < 2) return null
  if (maxLines === 2) {
    let best = null
    for (let k = 1; k < words.length; k++) {
      const a = words.slice(0, k).join(' ')
      const b = words.slice(k).join(' ')
      if (a.length > maxChars || b.length > maxChars) continue
      const cost = Math.abs(a.length - b.length) - (/[,.;:!?]$/.test(words[k - 1]) ? 6 : 0) + (a.length > b.length ? 1 : 0)
      if (!best || cost < best.cost) best = { cost, lines: [a, b] }
    }

    return best?.lines ?? null
  }
  const lines = []
  let line = ''
  for (const w of words) {
    if (!line) line = w
    else if (line.length + 1 + w.length <= maxChars) line += ` ${w}`
    else {
      lines.push(line)
      line = w
    }
  }
  if (line) lines.push(line)

  return lines.length <= maxLines && lines.every(l => l.length <= maxChars) ? lines : null
}

/**
 * Groups transcript words ({ t, end, text }, seconds) into caption items { t, end, text }.
 * A caption ends at sentence punctuation, at a pause, when it would pass maxDur seconds, or
 * when its text no longer fits maxLines lines of maxChars; a clause comma ends it once it is
 * half full. Lines are balanced. Consecutive captions keep at least minGap seconds apart.
 * Punctuation and contractions join the word before them. When the words keep whisper's
 * spacing (some start with a space), a token without one continues the previous word.
 */
export function wordsToCaptions(words, options = {}) {
  const { maxChars = 42, maxLines = 2, maxDur = 6, minGap = 0.08, pause = 0.6, minDur = 0.7 } = options
  const includeWords = options.includeWords === true
  const ws = []
  let carry = ''
  let carryWords = []
  const list = [...(words ?? [])].filter(x => x && isNum(Number(x.t)) && String(x.text ?? '').trim()).sort((a, b) => a.t - b.t)
  const spaced = list.some(w => /^\s/.test(String(w.text)))
  for (const w of list) {
    const text = String(w.text).trim()
    const t = Number(w.t)
    const end = Math.max(t, Number(w.end ?? t))
    const prev = ws[ws.length - 1]
    if (includeWords && ATTACHES_RIGHT.test(text)) {
      carry += text; carryWords.push(w)
      continue
    }
    if (includeWords && carryWords.length && !ATTACHES_RIGHT.test(text)) {
      ws.push({ t: Number(carryWords[0].t), end: carryWords.reduce((value, token) => Math.max(value, Number(token.end)), end), text: carry + text, sourceWords: carryWords.concat([w]) })
      carry = ''; carryWords = []
      continue
    }
    if (prev && (ATTACHES_LEFT.test(text) || (spaced && !/^\s/.test(String(w.text)))) && t - prev.end < pause) {
      prev.text += text
      prev.end = Math.max(prev.end, end)
      if (includeWords) prev.sourceWords.push(w)
      continue
    }
    if (ATTACHES_RIGHT.test(text)) {
      carry += text
      if (includeWords) carryWords.push(w)
      continue
    }
    ws.push({ t: includeWords && carryWords.length ? Number(carryWords[0].t) : t, end, text: carry + text, ...(includeWords ? { sourceWords: [...carryWords, w] } : {}) })
    carry = ''
    carryWords = []
  }
  if (includeWords && carryWords.length) {
    const prev = ws.at(-1)
    const end = carryWords.reduce((value, w) => Math.max(value, Number(w.end)), 0)
    if (prev) { prev.text += carry; prev.end = Math.max(prev.end, end); prev.sourceWords = prev.sourceWords.concat(carryWords) }
    else ws.push({ t: Number(carryWords[0].t), end, text: carry, sourceWords: carryWords })
  }
  const cues = []
  let cur = null
  for (const w of ws) {
    if (cur) {
      const last = cur.words[cur.words.length - 1]
      const len = cur.words.map(x => x.text).join(' ').length
      const sentence = /[.!?…]["'’”)\]]*$/.test(last.text)
      const clause = /[,;:—–]["'’”)\]]*$/.test(last.text) && len >= (maxChars * maxLines) / 2
      if (w.t - last.end >= pause || sentence || clause || w.end - cur.t > maxDur || !layoutLines([...cur.words, w].map(x => x.text), maxChars, maxLines)) {
        cues.push(cur)
        cur = null
      }
    }
    if (!cur) cur = { t: w.t, words: [] }
    cur.words.push(w)
  }
  if (cur) cues.push(cur)
  const out = cues.map(c => {
    const texts = c.words.map(x => x.text)

    return { t: c.t, end: includeWords ? c.words.reduce((value, w) => Math.max(value, w.end), c.t) : c.words[c.words.length - 1].end, text: (layoutLines(texts, maxChars, maxLines) ?? [texts.join(' ')]).join('\n'), ...(includeWords ? { words: c.words.flatMap(w => w.sourceWords) } : {}) }
  })
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    const next = out[i + 1]
    const limit = next ? next.t - minGap : Infinity
    if (c.end - c.t < minDur) c.end = Math.max(c.end, Math.min(c.t + minDur, limit))
    if (c.end > limit) c.end = Math.max(c.t + 0.04, limit)
    c.t = round(c.t, 3)
    c.end = round(c.end, 3)
    if (includeWords) c.words = c.words.map(word => {
      const t = round(Math.max(c.t, Math.min(c.end - 0.0001, Number(word.t))), 4)
      return { ...word, t, end: round(Math.max(t + 0.0001, Math.min(c.end, Number(word.end))), 4) }
    })
  }

  return out
}

/**
 * Places a source's transcript on the timeline: for every clip that plays `src` (or only
 * clip `id`), words whose middle falls inside the clip's source range move to timeline time
 * (start + (t - in) / speed) and become captions, so no caption spans a cut. Linked
 * video/audio pairs count once; reversed and frozen clips are skipped. Without a clip on the
 * timeline the words keep their source times (placed: false).
 */
export function transcriptToCaptions(project, src, words, options = {}) {
  const { id, ...opts } = options
  const seen = new Set()
  const uses = (project?.tracks ?? [])
    .filter(t => t.kind === 'video' || t.kind === 'audio')
    .flatMap(t => t.clips)
    .filter(c => c.src === src && (!id || c.id === id) && !c.reverse && c.freeze === undefined)
    .sort((a, b) => a.start - b.start)
    .filter(c => {
      const key = c.link ? `${c.link}@${round(c.start, 3)}` : c.id
      if (seen.has(key)) return false
      seen.add(key)

      return true
    })
  if (id && !uses.length) throw new Error(`clip ${id} does not play ${src}`)
  if (!uses.length) return { items: wordsToCaptions(words, opts), placed: false, clips: [] }
  const items = []
  for (const c of uses) {
    const speed = c.speed ?? 1
    const from = c.in ?? 0
    const to = from + c.dur * speed
    const mapped = (words ?? [])
      .filter(w => {
        const mid = (Number(w.t) + Number(w.end ?? w.t)) / 2

        return mid >= from && mid < to
      })
      .map(w => ({
        t: c.start + (Math.max(Number(w.t), from) - from) / speed,
        end: c.start + (Math.min(Number(w.end ?? w.t), to) - from) / speed,
        text: w.text,
      }))
    const end = c.start + c.dur
    for (const cue of wordsToCaptions(mapped, opts)) items.push({ ...cue, end: round(Math.min(cue.end, end), 3) })
  }
  items.sort((a, b) => a.t - b.t)
  const minGap = opts.minGap ?? 0.08
  for (let i = 0; i < items.length - 1; i++) if (items[i + 1].t - items[i].end < minGap) items[i].end = round(Math.max(items[i].t + 0.04, items[i + 1].t - minGap), 3)

  return { items, placed: true, clips: uses.map(c => c.id) }
}

// ---------------------------------------------------------------- shared pieces for timeline formats

const TITLE_DEFAULTS = { font: 'Avenir Next', weight: 800, size: 120, color: '#ffffff', align: 'center', anim: 'none' }
const CAPTION_STYLE = { font: 'Helvetica Neue', size: 52, color: '#ffffff', plate: '#000000aa', y: 0.88 }

function nameOf(c) {
  if (c.label) return c.label
  if (c.kind === 'title') return String(c.title?.text ?? 'Title').split('\n')[0].slice(0, 64) || 'Title'
  if (c.kind === 'caption') return String(c.text ?? '').split('\n')[0].slice(0, 64) || 'Caption'
  if (c.src) return stem(c.src)

  return c.kind.replace(/^./, ch => ch.toUpperCase())
}

/** The project-level data no timeline format can hold, carried as metadata. */
function projectMetadata(p) {
  return {
    format: 'reel',
    version: FORMAT_VERSION,
    name: p.name,
    width: p.width,
    height: p.height,
    fps: p.fps,
    sampleRate: p.sampleRate,
    ...(p.master !== undefined ? { master: clone(p.master) } : {}),
    background: p.background,
    colorSpace: p.colorSpace,
    range: p.range ?? null,
    comps: p.comps ?? {},
    tracks: p.tracks.map(t => omit(t, ['clips'])),
    markers: p.markers ?? [],
  }
}

function freshTrackId(tracks, kind) {
  const prefix = kind === 'audio' ? 'A' : kind === 'caption' ? 'C' : 'V'
  let n = 1
  while (tracks.some(t => t.id === `${prefix}${n}`)) n++

  return { id: `${prefix}${n}`, n }
}

function newTrack(tracks, kind, name) {
  const { id, n } = freshTrackId(tracks, kind)
  if (kind === 'audio') return { id, kind, name: name ?? `Audio ${n}`, volume: 0, pan: 0, clips: [] }
  if (kind === 'caption') return { id, kind, name: name ?? (n === 1 ? 'Captions' : `Captions ${n}`), burnIn: false, style: { ...CAPTION_STYLE }, clips: [] }

  return { id, kind, name: name ?? `Video ${n}`, clips: [] }
}

/**
 * Builds a Reel project from imported items. An item is
 *   { group: 'video'|'audio'|'caption', key, sort, f0, f1, s, json, mdTrack }
 * with f0/f1 in project frames, `s` the clip fields read from the file's structure and
 * `json` the clip saved in Reel metadata (or null). Items whose metadata names an existing
 * track go there; the rest are grouped by `key` and spread over as many tracks as their
 * overlaps need. Clips keep their saved ids; the others get c1, c2… in track order.
 */
function assemble(o) {
  const { fps, md, warn } = o
  const tracks = []
  const byId = new Map()
  for (const t of Array.isArray(md?.tracks) ? md.tracks : []) {
    if (!t || typeof t.id !== 'string' || byId.has(t.id) || !['video', 'audio', 'caption'].includes(t.kind)) continue
    const track = { ...clone(omit(t, ['clips'])), clips: [] }
    tracks.push(track)
    byId.set(t.id, track)
  }
  const groups = new Map()
  for (const it of o.items) {
    const target = it.mdTrack ? byId.get(it.mdTrack) : null
    if (target && target.kind === it.group) {
      target.clips.push(it)
      continue
    }
    const key = `${it.group}|${it.key}`
    if (!groups.has(key)) groups.set(key, { kind: it.group, sort: it.sort ?? 0, name: it.trackName, items: [] })
    groups.get(key).items.push(it)
  }
  const KIND_ORDER = ['video', 'audio', 'caption']
  for (const g of [...groups.values()].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.sort - b.sort)) {
    const lanes = []
    for (const it of g.items.sort((a, b) => a.f0 - b.f0)) {
      let lane = lanes.find(l => l.end <= it.f0)
      if (!lane) {
        lane = { end: -Infinity, items: [] }
        lanes.push(lane)
      }
      lane.items.push(it)
      lane.end = it.f1
    }
    lanes.forEach((lane, i) => {
      const t = newTrack(tracks, g.kind, g.name ? (i ? `${g.name} ${i + 1}` : g.name) : undefined)
      t.clips = lane.items
      tracks.push(t)
    })
  }
  if (!tracks.some(t => t.kind === 'video')) tracks.push(newTrack(tracks, 'video'))
  if (!tracks.some(t => t.kind === 'audio')) tracks.push(newTrack(tracks, 'audio'))
  tracks.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind))

  // Ids: saved ones first (unique), then fresh ones in track order.
  const used = new Set()
  for (const comp of Object.values(md?.comps ?? {})) for (const t of comp?.tracks ?? []) for (const c of t.clips ?? []) if (c?.id) used.add(c.id)
  for (const t of tracks) {
    t.clips.sort((a, b) => a.f0 - b.f0)
    for (const it of t.clips) {
      const id = it.json?.id
      if (typeof id === 'string' && /^[A-Za-z][\w-]*$/.test(id) && !used.has(id)) {
        used.add(id)
        it.id = id
      }
    }
  }
  let next = 0
  for (const id of used) if (/^c\d+$/.test(id)) next = Math.max(next, Number(id.slice(1)))
  for (const t of tracks) for (const it of t.clips) it.id ??= `c${++next}`
  for (const t of tracks) {
    t.clips = t.clips.map(it => {
      const s = defined(it.s)
      const merged = { ...(it.json ? omit(it.json, ['id', 'start', 'dur']) : {}), ...s }
      const { kind, src, ...rest } = merged

      return defined({ id: it.id, kind: kind ?? 'video', src, start: round(it.f0 / fps, 5), dur: round((it.f1 - it.f0) / fps, 5), ...rest })
    })
  }
  if (o.linkPairs) linkPairs(tracks)

  // Markers: saved ones (matched by frame and label) keep id, color and kind.
  const saved = Array.isArray(md?.markers) ? md.markers.filter(m => m && isNum(m.t)) : []
  const taken = new Set()
  const markerIds = new Set()
  let nextMarker = 0
  for (const m of saved) if (/^m\d+$/.test(m.id ?? '')) nextMarker = Math.max(nextMarker, Number(m.id.slice(1)))
  const markers = [...o.markers].sort((a, b) => a.f - b.f).map(m => {
    const k = saved.findIndex((x, i) => !taken.has(i) && Math.round(x.t * fps) === m.f && (x.label ?? '') === m.label)
    let out
    if (k >= 0) {
      taken.add(k)
      out = { ...clone(saved[k]), t: round(m.f / fps, 5) }
    } else {
      out = defined({ id: undefined, t: round(m.f / fps, 5), label: m.label, color: m.color ?? MARKER_COLORS[0], kind: m.kind ?? 'marker', note: m.note, dur: m.df > 1 ? round(m.df / fps, 5) : undefined })
    }
    if (!out.id || markerIds.has(out.id)) out.id = `m${++nextMarker}`
    markerIds.add(out.id)

    return out
  })

  return migrate({
    version: FORMAT_VERSION,
    name: md?.name ?? o.name ?? 'Imported',
    width: md?.width ?? o.width,
    height: md?.height ?? o.height,
    fps,
    sampleRate: md?.sampleRate ?? o.sampleRate ?? 48000,
    ...(md?.master !== undefined ? { master: clone(md.master) } : {}),
    background: md?.background ?? '#000000',
    colorSpace: md?.colorSpace ?? o.colorSpace ?? 'rec709',
    tracks,
    comps: clone(md?.comps) ?? {},
    markers,
    assets: o.assets,
    range: clone(md?.range) ?? null,
  })
}

/** Links a video clip and an audio clip that play the same source over the same span. */
function linkPairs(tracks) {
  const audio = tracks.filter(t => t.kind === 'audio').flatMap(t => t.clips)
  for (const t of tracks) {
    if (t.kind !== 'video') continue
    for (const v of t.clips) {
      if (v.kind !== 'video' || !v.src || v.link) continue
      const a = audio.find(x => !x.link && x.src === v.src && x.start === v.start && x.dur === v.dur && Math.abs((x.in ?? 0) - (v.in ?? 0)) < 1e-3 && (x.speed ?? 1) === (v.speed ?? 1))
      if (!a) continue
      v.link = a.link = `L${v.id}`
      v.audioDetached = true
    }
  }
}

// ---------------------------------------------------------------- FCPXML export

const BASIC_TITLE = '.../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti'
const CROSS_DISSOLVE = 'FxPlug:4731E73A-8DAC-4113-9A30-AE85B1761265'
export const CAPTION_ROLE = 'iTT?captionFormat=ITT.en'
const COLOR_SPACES = { rec709: '1-1-1 (Rec. 709)', 'rec2020-pq': '9-16-9 (Rec. 2020 PQ)', 'rec2020-hlg': '9-18-9 (Rec. 2020 HLG)' }

function fontFace(weight, italic) {
  const face = weight >= 700 ? 'Bold' : weight <= 300 ? 'Light' : 'Regular'
  if (!italic) return face

  return face === 'Regular' ? 'Italic' : `${face} Italic`
}

const mdNode = entries => {
  const list = Object.entries(entries).filter(([, v]) => v !== undefined && v !== null)

  return list.length ? el('metadata', {}, list.map(([key, value]) => el('md', { key, value: typeof value === 'string' ? value : JSON.stringify(value) }))) : null
}

/**
 * Exports the main timeline as FCPXML 1.11 (Final Cut Pro, DaVinci Resolve).
 * V1 is the primary storyline (gaps fill the holes); higher video tracks and the audio
 * tracks are connected clips on lanes 1, 2… and -1, -2…; caption tracks become <caption>
 * elements above them. Titles use Final Cut's Basic Title, every transition is a Cross
 * Dissolve, speed is a linear timeMap. Clip kinds FCPXML cannot draw (colors, shapes,
 * adjustment layers, nulls, compositions, multicam) are empty compound clips that hold
 * their Reel data. `root` is the project folder, for absolute media URLs.
 * options: { metadata: true (embed Reel data), warnings: [] (receives what did not fit) }
 */
export function toFCPXML(project, root = '', options = {}) {
  const p = migrate(clone(project))
  const warn = m => options.warnings && !options.warnings.includes(m) && options.warnings.push(m)
  const withMd = options.metadata !== false
  const fps = p.fps
  const rate = rateOf(fps)
  const F = t => Math.round((t ?? 0) * fps)
  const T = f => frameTime(f, rate)
  const ST = s => secondsTime(s, rate)
  const frameSec = f => (f * rate.num) / rate.den
  let resN = 0
  const rid = () => `r${++resN}`
  let styleN = 0

  // resources
  const formatNodes = []
  const formatIds = new Map()
  const formatFor = (w, h, rateFps, still, colorSpace) => {
    const key = `${w}x${h}@${still ? 'still' : rateFps}`
    if (formatIds.has(key)) return formatIds.get(key)
    const id = rid()
    formatIds.set(key, id)
    formatNodes.push(el('format', { id, frameDuration: still ? undefined : frameTime(1, rateOf(rateFps)), width: w, height: h, colorSpace }))

    return id
  }
  const seqFormat = formatFor(p.width, p.height, fps, false, COLOR_SPACES[p.colorSpace] ?? COLOR_SPACES.rec709)
  const assetNodes = []
  const assetIds = new Map()
  for (const [src, a] of Object.entries(p.assets ?? {})) {
    const id = rid()
    assetIds.set(src, id)
    const still = Boolean(a.hasVideo && (a.still || !a.duration))
    assetNodes.push(el('asset', {
      id,
      name: stem(src),
      start: '0s',
      duration: still || !a.duration ? '0s' : ST(a.duration),
      hasVideo: a.hasVideo ? '1' : undefined,
      format: a.hasVideo ? formatFor(a.width ?? p.width, a.height ?? p.height, a.fps || fps, still) : undefined,
      hasAudio: a.hasAudio ? '1' : undefined,
      videoSources: a.hasVideo ? '1' : undefined,
      audioSources: a.hasAudio ? '1' : undefined,
      audioChannels: a.hasAudio ? String(a.channels ?? 2) : undefined,
    }, [el('media-rep', { kind: 'original-media', src: fileURL(absolutePath(src, root)) }), withMd ? mdNode({ 'reel.asset': a }) : null]))
  }
  const effectNodes = []
  const effectIds = {}
  const effect = kind => {
    if (!effectIds[kind]) {
      effectIds[kind] = rid()
      effectNodes.push(kind === 'title'
        ? el('effect', { id: effectIds[kind], name: 'Basic Title', uid: BASIC_TITLE })
        : el('effect', { id: effectIds[kind], name: 'Cross Dissolve', uid: CROSS_DISSOLVE }))
    }

    return effectIds[kind]
  }

  // A video clip and its linked audio that play the same span export as one A/V clip.
  const placed = p.tracks.flatMap(t => t.clips.map(c => ({ t, c })))
  const pairOf = new Map()
  const inPair = new Set()
  for (const { t, c } of placed) {
    if (t.kind !== 'video' || c.kind !== 'video' || !c.link || !c.src) continue
    const mates = placed.filter(x => x.c !== c && x.c.link === c.link)
    if (mates.length !== 1 || mates[0].t.kind !== 'audio' || inPair.has(mates[0].c)) continue
    const a = mates[0].c
    const same = a.kind === 'audio' && a.src === c.src && F(a.start) === F(c.start) && F(a.dur) === F(c.dur) && Math.abs((a.in ?? 0) - (c.in ?? 0)) < 1e-3 &&
      (a.speed ?? 1) === (c.speed ?? 1) && Boolean(a.reverse) === Boolean(c.reverse) && a.freeze === c.freeze
    if (!same) continue
    pairOf.set(c, { clip: a, track: mates[0].t })
    inPair.add(a)
  }

  // Placements: V1 on the spine, everything else connected on a lane.
  const videoTracks = p.tracks.filter(t => t.kind === 'video')
  const audioTracks = p.tracks.filter(t => t.kind === 'audio')
  const captionTracks = p.tracks.filter(t => t.kind === 'caption')
  const span = c => {
    const f0 = F(c.start)

    return { f0, f1: f0 + Math.max(1, F(c.dur)) }
  }
  const spineClips = []
  const connected = []
  let overflow = false
  if (videoTracks[0]) {
    let end = -Infinity
    for (const c of [...videoTracks[0].clips].sort((a, b) => a.start - b.start)) {
      const s = span(c)
      if (s.f0 < end) {
        overflow = true
        connected.push({ clip: c, track: videoTracks[0], lane: videoTracks.length, ...s })
        warn(`${c.id} overlaps another clip on ${videoTracks[0].id}; it is exported as a connected clip`)
      } else {
        spineClips.push({ clip: c, track: videoTracks[0], ...s })
        end = s.f1
      }
    }
  }
  videoTracks.slice(1).forEach((t, i) => t.clips.forEach(c => connected.push({ clip: c, track: t, lane: i + 1, ...span(c) })))
  audioTracks.forEach((t, j) => t.clips.forEach(c => !inPair.has(c) && connected.push({ clip: c, track: t, lane: -(j + 1), ...span(c) })))
  const captionLane = Math.max(1, videoTracks.length + (overflow ? 1 : 0))
  captionTracks.forEach((t, k) => t.clips.forEach(c => connected.push({ clip: c, track: t, lane: captionLane + k, ...span(c) })))

  let total = 1
  for (const t of p.tracks) for (const c of t.clips) total = Math.max(total, span(c).f1)
  for (const m of p.markers) total = Math.max(total, F(m.t) + 1)

  // The spine: V1 clips with gaps, then a gap to the end so every connected clip has a parent.
  const entries = []
  let cursor = 0
  for (const s of spineClips) {
    if (s.f0 > cursor) entries.push({ gap: true, f0: cursor, f1: s.f0, extL: 0, extR: 0 })
    entries.push({ ...s, extL: 0, extR: 0 })
    cursor = s.f1
  }
  if (total > cursor) entries.push({ gap: true, f0: cursor, f1: total, extL: 0, extR: 0 })

  // Source frames available past a clip's edges, for transitions to overlap into.
  const handles = c => {
    const a = c.src ? p.assets[c.src] : null
    if (!MEDIA_KINDS.has(c.kind) || c.kind === 'image' || !a?.duration || c.freeze !== undefined) return { before: Infinity, after: Infinity }
    const speed = c.speed ?? 1
    const lo = c.in ?? 0
    const hi = a.duration - (lo + c.dur * speed)
    const before = ((c.reverse ? hi : lo) / speed) * fps
    const after = ((c.reverse ? lo : hi) / speed) * fps

    return { before: Math.max(0, Math.floor(before + 1e-6)), after: Math.max(0, Math.floor(after + 1e-6)) }
  }
  for (let i = 0; i < entries.length; i++) {
    const cur = entries[i]
    if (cur.gap || !cur.clip.transitionIn) continue
    const prev = entries[i - 1]
    if (!prev) {
      warn(`the transition into ${cur.clip.id} has nothing before it and is kept only in Reel metadata`)
      continue
    }
    const D = Math.max(2, F(cur.clip.transitionIn.dur))
    let left = Math.floor(D / 2)
    let right = D - left
    const hA = prev.gap ? Infinity : handles(prev.clip).after
    const hB = handles(cur.clip).before
    const room = Math.floor(Math.min(prev.f1 - prev.f0, cur.f1 - cur.f0) / 2)
    if (right > hA || left > hB || right > room || left > room) {
      const h = Math.min(left, hA, hB, room)
      if (h < 1) {
        warn(`the transition into ${cur.clip.id} has no media to overlap and is kept only in Reel metadata`)
        continue
      }
      warn(`the transition into ${cur.clip.id} is shortened to ${2 * h} frames to fit the available media`)
      left = right = h
    }
    prev.extR = right
    cur.extL = left
    cur.transition = { offset: cur.f0 - left, dur: left + right, type: cur.clip.transitionIn.type }
  }

  // Timing of one element: its local start (frames), duration and timeMap.
  const timingOf = pl => {
    const c = pl.clip
    const extL = pl.extL ?? 0
    const extR = pl.extR ?? 0
    const durF = pl.f1 - pl.f0 + extL + extR
    if (pl.gap || !MEDIA_KINDS.has(c.kind) || !c.src || !p.assets[c.src] || c.kind === 'image') return { startF: 0, durF }
    const speed = c.speed ?? 1
    const durSec = frameSec(durF)
    if (c.freeze !== undefined) return { startF: 0, durF, map: [[0, c.freeze], [durF, c.freeze]] }
    if (c.reverse) {
      const lo = Math.max(0, (c.in ?? 0) - frameSec(extR) * speed)

      return { startF: 0, durF, map: [[0, lo + durSec * speed], [durF, lo]] }
    }
    const lo = Math.max(0, (c.in ?? 0) - frameSec(extL) * speed)
    if (speed !== 1) return { startF: 0, durF, map: [[0, lo], [durF, lo + durSec * speed]] }

    return { startF: F(lo), durF }
  }

  const markerNode = (m, localF) => el(m.kind === 'chapter' ? 'chapter-marker' : 'marker', {
    start: T(localF),
    duration: T(Math.max(1, F(m.dur ?? 0))),
    value: m.label ?? '',
    completed: m.kind === 'todo' ? '0' : undefined,
    note: m.note || undefined,
  })

  // One story element. `inner` holds its anchored children and markers.
  const buildNode = (pl, offsetF, lane, tm, inner) => {
    const c = pl.clip
    const track = pl.track
    const a = c.src ? p.assets[c.src] : null
    const kind = track.kind === 'caption' || c.kind === 'caption' ? 'caption' : c.kind === 'title' ? 'title' : MEDIA_KINDS.has(c.kind) && a ? 'asset-clip' : 'placeholder'
    if (MEDIA_KINDS.has(c.kind) && !a) warn(`${c.id} has no media information for ${c.src ?? 'its source'}; it is exported as a placeholder`)
    const common = { lane: lane || undefined, offset: T(offsetF), name: nameOf(c), duration: T(tm.durF), enabled: c.enabled === false ? '0' : undefined }
    const note = c.note ? el('note', {}, [txt(c.note)]) : null
    const expressed = ['start', 'dur', 'note', 'enabled']
    if (pl.transition) expressed.push('transitionIn')
    const md = (json, extra = {}) => (withMd ? mdNode({ 'reel.clip': json, 'reel.track': track.id, ...extra }) : null)

    if (kind === 'caption') {
      const sid = `ts${++styleN}`
      const st = { ...CAPTION_STYLE, ...(track.style ?? {}) }

      return el('caption', { ...common, role: CAPTION_ROLE }, [
        el('text', { placement: (st.y ?? 0.88) < 0.5 ? 'top' : 'bottom' }, [el('text-style', { ref: sid }, [txt(c.text ?? '')])]),
        el('text-style-def', { id: sid }, [el('text-style', { fontColor: fcpColor(st.color), backgroundColor: fcpColor(st.plate, '#000000') })]),
        note,
      ])
    }
    const visual = c.kind !== 'audio'
    const adjust = []
    if (kind !== 'placeholder' && visual) {
      const sx = (c.scale ?? 1) * (c.scaleX ?? 1)
      const sy = (c.scale ?? 1) * (c.scaleY ?? 1)
      if (sx !== 1 || sy !== 1) adjust.push(el('adjust-transform', { scale: `${round(sx, 6)} ${round(sy, 6)}` }))
      if ((c.opacity ?? 1) !== 1) adjust.push(el('adjust-blend', { amount: String(round(c.opacity, 6)) }))
      expressed.push('opacity')
    }
    if (kind === 'title') {
      const t = { ...TITLE_DEFAULTS, ...(c.title ?? {}) }
      const sid = `ts${++styleN}`
      expressed.push('kind')

      return el('title', { ref: effect('title'), ...common }, [
        el('text', {}, [el('text-style', { ref: sid }, [txt(t.text ?? '')])]),
        el('text-style-def', { id: sid }, [el('text-style', {
          font: t.font,
          fontSize: String(round((t.size ?? 120) * (p.height / 1080), 2)),
          fontFace: fontFace(t.weight ?? 400, t.italic),
          fontColor: fcpColor(t.color ?? t.gradient?.[0]),
          bold: (t.weight ?? 400) >= 700 ? '1' : undefined,
          italic: t.italic ? '1' : undefined,
          alignment: ['left', 'center', 'right'].includes(t.align) ? t.align : 'center',
        })]),
        note,
        adjust,
        inner,
        md({ ...omit(c, expressed), title: omit(c.title ?? {}, ['text']) }),
      ])
    }
    if (kind === 'placeholder') {
      return el('clip', common, [note, el('gap', { offset: '0s', duration: T(tm.durF) }), inner, md(omit(c, expressed))])
    }
    // asset-clip
    const pair = pairOf.get(c)
    const carriesAudio = Boolean(pair) || c.kind === 'audio' || (c.kind === 'video' && hasAudio(p, c))
    const srcEnable = c.kind === 'audio' ? (a.hasVideo ? 'audio' : undefined) : a.hasAudio && !carriesAudio ? 'video' : undefined
    const volume = pair ? pair.clip.volume : carriesAudio ? c.volume : undefined
    if (carriesAudio && !pair) expressed.push('volume')
    // A freeze frame's timeMap holds only the frozen time; its in point and speed stay in metadata.
    expressed.push('kind', 'src', 'freeze', ...(c.freeze !== undefined ? [] : ['in', 'speed', 'reverse']))
    const timeMap = tm.map
      ? el('timeMap', {}, tm.map.map(([f, v]) => el('timept', { time: T(f), value: ST(v), interp: 'linear' })))
      : null

    return el('asset-clip', { ref: assetIds.get(c.src), ...common, start: c.kind === 'image' ? undefined : T(tm.startF), srcEnable }, [
      note,
      timeMap,
      adjust,
      volume ? el('adjust-volume', { amount: `${round(volume, 3)}dB` }) : null,
      inner,
      md(omit(c, expressed), pair ? { 'reel.audio': omit(pair.clip, ['kind', 'src', 'start', 'dur', 'freeze', 'volume', ...(c.freeze !== undefined ? [] : ['in', 'speed', 'reverse'])]), 'reel.audioTrack': pair.track.id } : {}),
    ])
  }

  // Lay out the spine: element offsets, local starts, then anchored children and markers.
  for (const e of entries) {
    e.tm = timingOf(e)
    e.offsetF = e.f0 - e.extL
    e.anchored = []
    e.markers = []
  }
  const holder = f => entries.find(e => f >= e.f0 && f < e.f1) ?? entries[entries.length - 1]
  for (const pl of connected.sort((a, b) => a.lane - b.lane || a.f0 - b.f0)) {
    const e = holder(pl.f0)
    const tm = timingOf(pl)
    e.anchored.push(buildNode(pl, e.tm.startF + (pl.f0 - e.offsetF), pl.lane, tm, []))
  }
  for (const m of p.markers ?? []) {
    const f = F(m.t)
    const e = holder(f)
    e.markers.push(markerNode(m, e.tm.startF + (f - e.offsetF)))
  }
  const spine = []
  for (const e of entries) {
    if (e.transition) {
      spine.push(el('transition', { name: 'Cross Dissolve', offset: T(e.transition.offset), duration: T(e.transition.dur) }, [
        el('filter-video', { ref: effect('dissolve'), name: 'Cross Dissolve' }),
        withMd ? mdNode({ 'reel.transition': { type: e.transition.type } }) : null,
      ]))
    }
    if (e.gap) spine.push(el('gap', { name: 'Gap', offset: T(e.offsetF), duration: T(e.tm.durF) }, [...e.anchored, ...e.markers]))
    else spine.push(buildNode(e, e.offsetF, 0, e.tm, [...e.anchored, ...e.markers]))
  }

  const audioRate = { 32000: '32k', 44100: '44.1k', 48000: '48k', 88200: '88.2k', 96000: '96k', 176400: '176.4k', 192000: '192k' }[p.sampleRate] ?? '48k'
  const doc = el('fcpxml', { version: '1.11' }, [
    el('resources', {}, [...formatNodes, ...assetNodes, ...effectNodes]),
    el('library', {}, [el('event', { name: p.name || 'Reel' }, [el('project', { name: p.name || 'Reel' }, [
      el('sequence', { format: seqFormat, duration: T(total), tcStart: '0s', tcFormat: 'NDF', audioLayout: 'stereo', audioRate }, [
        el('spine', {}, spine),
        withMd ? mdNode({ 'reel.project': { ...projectMetadata(p), captionIds: Object.fromEntries(captionTracks.map(t => [t.id, [...t.clips].sort((a, b) => a.start - b.start).map(c => c.id)])) } }) : null,
      ]),
    ])])]),
  ])

  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n\n${serialize(doc)}\n`
}

// ---------------------------------------------------------------- FCPXML import

const STORY = new Set(['asset-clip', 'video', 'audio', 'title', 'caption', 'gap', 'clip', 'sync-clip', 'ref-clip', 'mc-clip', 'audition', 'spine', 'live-drawing'])

function mdValue(node, key) {
  const m = child(node, 'metadata')

  return m ? elements(m, 'md').find(x => x.attrs.key === key)?.attrs.value : undefined
}

function readMd(node, key) {
  const v = mdValue(node, key)
  if (v === undefined) return null
  try {
    const j = JSON.parse(v)

    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

/** The text of a title or caption: its text-style runs, ignoring layout whitespace between them. */
function storyText(node) {
  return elements(node, 'text').map(t => {
    const runs = elements(t, 'text-style')

    return runs.length ? runs.map(textOf).join('') : textOf(t).trim()
  }).join('\n')
}

function storyStyle(node) {
  const ref = elements(node, 'text').flatMap(t => elements(t, 'text-style')).find(s => s.attrs.ref)?.attrs.ref
  const def = elements(node, 'text-style-def').find(d => d.attrs.id === ref) ?? elements(node, 'text-style-def')[0]

  return child(def, 'text-style')?.attrs ?? null
}

/**
 * Reads FCPXML (any version Final Cut Pro 10.4+ writes; DaVinci Resolve's too) into a Reel
 * v3 project. The first project's sequence becomes the main timeline: its primary storyline
 * goes to V1, connected clips to tracks by lane (overlaps spill onto extra tracks), compound
 * and referenced clips are flattened into the timeline, titles keep their text, captions go
 * to caption tracks, transitions become transitionIn, markers stay where they were.
 * Media paths inside `root` come back relative to it. options: { warnings: [] }
 */
export function fromFCPXML(xml, root = '', options = {}) {
  const warnings = options.warnings ?? []
  const warn = m => !warnings.includes(m) && warnings.push(m)
  const doc = parseXML(String(xml ?? ''))
  const fcp = child(doc, 'fcpxml')
  if (!fcp) throw new Error('not an FCPXML document (no <fcpxml> element)')
  const res = new Map()
  for (const r of elements(child(fcp, 'resources'))) if (r.attrs.id) res.set(r.attrs.id, r)
  const projectNode = findFirst(fcp, n => n.name === 'project')
  const seq = projectNode ? child(projectNode, 'sequence') : null
  if (!seq) throw new Error('this FCPXML has no project (it may hold only events or clips)')
  const projects = []
  const collect = n => {
    for (const c of elements(n)) {
      if (c.name === 'project') projects.push(c)
      else collect(c)
    }
  }
  collect(fcp)
  if (projects.length > 1) warn(`the file holds ${projects.length} projects; imported the first, "${projectNode.attrs.name ?? ''}"`)
  const md = readMd(seq, 'reel.project')
  const fmt = res.get(seq.attrs.format)
  const fd = parseRational(fmt?.attrs.frameDuration)
  const fps = isNum(md?.fps) ? md.fps : fd ? normalizeFps(fd.den / fd.num) : 30
  const exact = fd ? fd.den / fd.num : exactRate(fps)
  const toF = sec => Math.round(sec * exact)
  const width = numOr(fmt?.attrs.width, md?.width ?? 1920)
  const height = numOr(fmt?.attrs.height, md?.height ?? 1080)

  // assets
  const assets = {}
  const assetRes = new Map()
  for (const r of res.values()) {
    if (r.name !== 'asset') continue
    const reps = elements(r, 'media-rep')
    const rep = reps.find(x => (x.attrs.kind ?? 'original-media') === 'original-media') ?? reps[0]
    if (!rep?.attrs.src) {
      warn(`asset ${r.attrs.name ?? r.attrs.id} has no media location and was skipped`)
      continue
    }
    const key = projectPath(absolutePath(pathFromURL(rep.attrs.src), root), root)
    const af = res.get(r.attrs.format)
    const afd = parseRational(af?.attrs.frameDuration)
    const dur = parseTime(r.attrs.duration)
    const hasVideo = r.attrs.hasVideo === '1'
    const info = defined({
      duration: dur > 0 ? round(dur, 3) : undefined,
      width: numOr(af?.attrs.width, undefined),
      height: numOr(af?.attrs.height, undefined),
      fps: afd ? normalizeFps(afd.den / afd.num) : undefined,
      hasVideo,
      hasAudio: r.attrs.hasAudio === '1',
      channels: numOr(r.attrs.audioChannels, undefined),
      still: hasVideo && !(dur > 0) ? true : undefined,
    })
    assets[key] = readMd(r, 'reel.asset') ?? info
    assetRes.set(r.attrs.id, { key, start: parseTime(r.attrs.start) ?? 0, info: assets[key] })
  }

  const items = []
  const markers = []
  const trimStart = (s, k) => {
    if (s.in !== undefined && s.freeze === undefined && !s.reverse) s.in = round(s.in + (k / fps) * (s.speed ?? 1), 5)
  }
  const trimEnd = (s, k) => {
    if (s.in !== undefined && s.freeze === undefined && s.reverse) s.in = round(s.in + (k / fps) * (s.speed ?? 1), 5)
  }
  const push = (group, lane, g0, g1, s, json, mdTrack, win, extra = {}) => {
    let f0 = toF(g0)
    let f1 = toF(g1)
    const w0 = Number.isFinite(win[0]) ? toF(win[0]) : -Infinity
    const w1 = Number.isFinite(win[1]) ? toF(win[1]) : Infinity
    if (f1 <= w0 || f0 >= w1) return null
    if (f0 < w0) {
      trimStart(s, w0 - f0)
      f0 = w0
    }
    if (f1 > w1) {
      trimEnd(s, f1 - w1)
      f1 = w1
    }
    if (f1 - f0 < 1) return null
    const sort = group === 'audio' ? (lane < 0 ? -lane : lane === 0 ? 0 : 1000 + lane) : lane
    const it = { group, key: lane, sort, lane, f0, f1, s, json, mdTrack, ...extra }
    items.push(it)

    return it
  }
  const label = (name, fallback) => (name && name !== fallback ? name : undefined)
  const noteOf = c => textOf(child(c, 'note')).trim() || undefined
  const enabledOf = c => (c.attrs.enabled === '0' ? false : undefined)
  const scaleOf = c => {
    const v = String(child(c, 'adjust-transform')?.attrs.scale ?? '').trim().split(/\s+/).map(Number)
    if (v.length !== 2 || v.some(x => !Number.isFinite(x)) || (v[0] === 1 && v[1] === 1)) return {}

    return v[0] === v[1] ? { scale: v[0] } : { scaleX: v[0], scaleY: v[1] }
  }
  const opacityOf = c => {
    const a = numOr(child(c, 'adjust-blend')?.attrs.amount, 1)

    return a !== 1 ? a : undefined
  }
  const volumeOf = c => {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*dB\s*$/i.exec(child(c, 'adjust-volume')?.attrs.amount ?? '')

    return m && Number(m[1]) !== 0 ? Number(m[1]) : undefined
  }
  const markersOf = (c, map, win) => {
    for (const m of elements(c)) {
      if (m.name !== 'marker' && m.name !== 'chapter-marker') continue
      const g = map(parseTime(m.attrs.start) ?? 0)
      if (g < win[0] - 1e-9 || g >= win[1]) continue
      markers.push({ f: toF(g), df: toF(parseTime(m.attrs.duration) ?? 0), label: m.attrs.value ?? '', note: m.attrs.note || undefined, kind: m.name === 'chapter-marker' ? 'chapter' : m.attrs.completed !== undefined ? 'todo' : 'marker' })
    }
  }
  // Source timing from the element's local start S and duration D (both seconds).
  const timing = (c, S, D, assetStart) => {
    const pts = elements(child(c, 'timeMap'), 'timept')
      .map(x => [parseTime(x.attrs.time), parseTime(x.attrs.value)])
      .filter(([a, b]) => isNum(a) && isNum(b))
      .sort((a, b) => a[0] - b[0])
    if (pts.length < 2) return { in: Math.max(0, round((pts[0]?.[1] ?? S) - assetStart, 5)) }
    if (pts.length > 2) warn('variable-speed retiming is imported as one constant speed per clip')
    const at = a => {
      if (a <= pts[0][0]) return pts[0][1] + (a - pts[0][0]) * ((pts[1][1] - pts[0][1]) / (pts[1][0] - pts[0][0] || 1))
      for (let i = 0; i < pts.length - 1; i++) {
        const [t0, v0] = pts[i]
        const [t1, v1] = pts[i + 1]
        if (a <= t1) return t1 > t0 ? v0 + ((a - t0) / (t1 - t0)) * (v1 - v0) : v1
      }
      const [t0, v0] = pts[pts.length - 2]
      const [t1, v1] = pts[pts.length - 1]

      return v1 + (a - t1) * ((v1 - v0) / (t1 - t0 || 1))
    }
    const a = at(S) - assetStart
    const b = at(S + D) - assetStart
    if (Math.abs(b - a) < 1e-6) return { freeze: Math.max(0, round(a, 5)) }
    const speed = Math.round((Math.abs(b - a) / D) * 1e5) / 1e5
    if (b > a) return { in: Math.max(0, round(a, 5)), speed: speed === 1 ? undefined : speed }

    return { in: Math.max(0, round(b, 5)), speed, reverse: true }
  }

  const mediaItems = (c, ar, g0, S, D, lane, win) => {
    const srcEnable = c.name === 'video' ? 'video' : c.name === 'audio' ? 'audio' : c.attrs.srcEnable ?? 'all'
    const info = ar.info
    const hasV = Boolean(info.hasVideo) && srcEnable !== 'audio'
    const hasA = Boolean(info.hasAudio) && srcEnable !== 'video'
    const json = readMd(c, 'reel.clip')
    const mdTrack = mdValue(c, 'reel.track')
    const audioJson = readMd(c, 'reel.audio')
    const tm = timing(c, S, D, ar.start)
    // A freeze frame keeps its saved in point; without one, it reads from the frozen time.
    const base = { src: ar.key, in: tm.freeze !== undefined && json ? undefined : tm.in ?? tm.freeze, speed: tm.speed, reverse: tm.reverse, freeze: tm.freeze, enabled: enabledOf(c) }
    const volume = volumeOf(c)
    const out = []
    if (hasV) {
      const still = Boolean(info.still)
      const s = still ? { kind: 'image', src: ar.key, enabled: base.enabled } : { kind: 'video', ...base }
      Object.assign(s, { note: noteOf(c), opacity: opacityOf(c) })
      if (!json) Object.assign(s, scaleOf(c), { label: label(c.attrs.name, stem(ar.key)) })
      if (hasA && !audioJson) s.volume = volume
      if (srcEnable === 'video' && info.hasAudio && !json?.mute && !json?.audioDetached) s.mute = true
      out.push(push('video', lane, g0, g0 + D, s, json, mdTrack, win))
      if (hasA && audioJson) out.push(push('audio', lane, g0, g0 + D, { kind: 'audio', ...base, in: tm.freeze !== undefined ? undefined : base.in, enabled: undefined, volume }, audioJson, mdValue(c, 'reel.audioTrack'), win))
    } else if (hasA) {
      out.push(push('audio', lane, g0, g0 + D, { kind: 'audio', ...base, volume, note: noteOf(c), label: json ? undefined : label(c.attrs.name, stem(ar.key)) }, json, mdTrack, win))
    }

    return out.filter(Boolean)
  }

  // Visits one story element placed at timeline second g0 (O: its offset in the parent's
  // local time). Returns { dur, items } where items are the clips it put on its own lane.
  const visit = (c, g0, O, lane, win, depth) => {
    const S = parseTime(c.attrs.start)
    const D = parseTime(c.attrs.duration)
    const local = base => L => g0 + (L - base)
    switch (c.name) {
      case 'asset-clip':
      case 'video':
      case 'audio': {
        const ar = assetRes.get(c.attrs.ref)
        const start = S ?? ar?.start ?? 0
        const dur = D ?? Math.max(0, (ar?.info.duration ?? 0) + (ar?.start ?? 0) - start)
        let out = []
        if (ar) out = mediaItems(c, ar, g0, start, dur, lane, win)
        else if (c.name === 'video' && res.get(c.attrs.ref)?.name === 'effect') {
          warn(`generator "${c.attrs.name ?? res.get(c.attrs.ref).attrs.name}" is imported as a solid color`)
          out = [push('video', lane, g0, g0 + dur, { kind: 'color', color: '#202020', label: c.attrs.name, note: noteOf(c), enabled: enabledOf(c) }, null, null, win)].filter(Boolean)
        } else warn(`a clip refers to missing media ${c.attrs.ref} and was skipped`)
        walk(c, local(start), lane, win, depth + 1, start)
        markersOf(c, local(start), win)

        return { dur, items: out }
      }
      case 'title': {
        const json = readMd(c, 'reel.clip')
        const text = storyText(c)
        let title
        if (json) title = { ...(json.title ?? {}), text }
        else {
          const st = storyStyle(c) ?? {}
          title = { ...TITLE_DEFAULTS, ...defined({
            font: st.font,
            size: st.fontSize ? round((Number(st.fontSize) * 1080) / height, 2) : undefined,
            color: fromFcpColor(st.fontColor),
            weight: st.bold === '1' || /bold|black|heavy/i.test(st.fontFace ?? '') ? 700 : st.fontFace ? 400 : undefined,
            italic: st.italic === '1' || /italic|oblique/i.test(st.fontFace ?? '') ? true : undefined,
            align: ['left', 'center', 'right'].includes(st.alignment) ? st.alignment : undefined,
          }), text }
        }
        const s = { kind: 'title', title, note: noteOf(c), enabled: enabledOf(c), opacity: opacityOf(c), ...(json ? {} : { ...scaleOf(c), label: label(c.attrs.name, text.split('\n')[0]) }) }
        const it = push('video', lane, g0, g0 + (D ?? 0), s, json, mdValue(c, 'reel.track'), win)
        walk(c, local(S ?? 0), lane, win, depth + 1, S ?? 0)
        markersOf(c, local(S ?? 0), win)

        return { dur: D ?? 0, items: it ? [it] : [] }
      }
      case 'caption': {
        const role = c.attrs.role ?? 'captions'
        push('caption', lane, g0, g0 + (D ?? 0), { kind: 'caption', text: storyText(c), enabled: enabledOf(c) }, null, null, win, { role })

        return { dur: D ?? 0, items: [] }
      }
      case 'gap': {
        walk(c, local(S ?? 0), lane, win, depth + 1, S ?? 0)
        markersOf(c, local(S ?? 0), win)

        return { dur: D ?? 0, items: [] }
      }
      case 'clip':
      case 'sync-clip': {
        const json = readMd(c, 'reel.clip')
        if (json?.kind) {
          // A Reel clip FCPXML cannot draw, exported as an empty compound clip.
          const it = push(json.kind === 'audio' ? 'audio' : 'video', lane, g0, g0 + (D ?? 0), { note: noteOf(c), enabled: enabledOf(c) }, json, mdValue(c, 'reel.track'), win)
          // Only anchored children: the inner gap just holds the duration.
          walk({ children: elements(c).filter(x => numOr(x.attrs.lane, 0) !== 0) }, local(S ?? 0), lane, win, depth + 1, S ?? 0)
          markersOf(c, local(S ?? 0), win)

          return { dur: D ?? 0, items: it ? [it] : [] }
        }
        const start = S ?? 0
        const inner = [Math.max(win[0], g0), Math.min(win[1], D === undefined ? Infinity : g0 + D)]
        walk(c, local(start), lane, inner, depth + 1, start)
        markersOf(c, local(start), inner)

        return { dur: D ?? 0, items: [] }
      }
      case 'ref-clip': {
        const media = res.get(c.attrs.ref)
        const inner = child(media, 'sequence')
        const start = S ?? parseTime(inner?.attrs.tcStart) ?? 0
        const w = [Math.max(win[0], g0), Math.min(win[1], D === undefined ? Infinity : g0 + D)]
        if (inner) walk(child(inner, 'spine'), local(start), lane, w, depth + 1, start)
        else warn(`compound clip ${c.attrs.name ?? c.attrs.ref} has no contents in the file`)
        walk({ children: elements(c).filter(x => numOr(x.attrs.lane, 0) !== 0) }, local(start), lane, win, depth + 1, start)
        markersOf(c, local(start), w)

        return { dur: D ?? 0, items: [] }
      }
      case 'mc-clip': {
        const mc = child(res.get(c.attrs.ref), 'multicam')
        const pick = elements(c, 'mc-source').find(x => (x.attrs.srcEnable ?? 'all') === 'all' || x.attrs.srcEnable === 'video')
        const angle = elements(mc, 'mc-angle').find(x => x.attrs.angleID === pick?.attrs.angleID) ?? elements(mc, 'mc-angle')[0]
        warn('multicam clips are imported as their active video angle')
        const start = S ?? parseTime(mc?.attrs.tcStart) ?? 0
        const w = [Math.max(win[0], g0), Math.min(win[1], D === undefined ? Infinity : g0 + D)]
        if (angle) walk(angle, local(start), lane, w, depth + 1, start)
        walk({ children: elements(c).filter(x => numOr(x.attrs.lane, 0) !== 0) }, local(start), lane, win, depth + 1, start)
        markersOf(c, local(start), w)

        return { dur: D ?? 0, items: [] }
      }
      case 'audition': {
        const pick = elements(c).find(x => STORY.has(x.name))

        return pick ? visit(pick, g0, O, lane, win, depth + 1) : { dur: 0, items: [] }
      }
      case 'spine': {
        // A connected storyline. Its children's offsets are either in the parent's time
        // (the first one starts at the storyline's own offset) or in its own (from 0).
        const first = elements(c).find(x => STORY.has(x.name) && x.attrs.offset !== undefined)
        const fo = parseTime(first?.attrs.offset)
        const base = fo !== undefined && fo >= O ? O : 0
        const end = walk(c, local(base), lane, win, depth + 1, base)

        return { dur: Math.max(0, end - base), items: [] }
      }
      default:
        warn(`<${c.name}> elements are not imported`)

        return { dur: D ?? 0, items: [] }
    }
  }

  // Walks a container's story children; returns the end of its storyline (local time).
  function walk(node, map, lane, win, depth, localStart = 0) {
    if (!node) return localStart
    if (depth > 40) {
      warn('clips nested more than 40 deep were skipped')

      return localStart
    }
    const primaries = []
    const transitions = []
    let cursor = localStart
    for (const c of elements(node)) {
      if (c.name === 'transition') {
        const D = parseTime(c.attrs.duration) ?? 0
        const O = parseTime(c.attrs.offset) ?? cursor - D
        if (c.attrs.offset === undefined) cursor -= D
        transitions.push({ g: map(O), D, after: primaries.length - 1, md: readMd(c, 'reel.transition') })
        continue
      }
      if (!STORY.has(c.name)) continue
      const own = numOr(c.attrs.lane, 0)
      const primary = own === 0
      const O = parseTime(c.attrs.offset) ?? (primary ? cursor : 0)
      const r = visit(c, map(O), O, lane + own, win, depth)
      if (primary) {
        primaries.push({ items: r.items })
        cursor = O + (r.dur ?? 0)
      }
    }
    for (const tr of transitions) {
      const next = primaries[tr.after + 1]
      if (!next || tr.after < 0) {
        warn('a transition without clips on both sides was dropped')
        continue
      }
      const Df = Math.max(1, toF(tr.D))
      const cut = toF(tr.g) + Math.floor(Df / 2)
      for (const it of primaries[tr.after].items) {
        if (it.f0 < cut && it.f1 > cut) {
          trimEnd(it.s, it.f1 - cut)
          it.f1 = cut
        }
      }
      if (!next.items.length) warn('a transition into a gap was dropped')
      const type = TRANSITIONS.includes(tr.md?.type) ? tr.md.type : 'crossDissolve'
      for (const it of next.items) {
        if (it.f0 < cut && it.f1 > cut) {
          trimStart(it.s, cut - it.f0)
          it.f0 = cut
        }
        if (it.group === 'video') it.s.transitionIn = { type, dur: round(Df / fps, 5) }
      }
    }

    return cursor
  }

  const tcStart = parseTime(seq.attrs.tcStart) ?? 0
  walk(child(seq, 'spine'), L => L - tcStart, 0, [-Infinity, Infinity], 0, tcStart)

  // Caption lanes: with Reel metadata each caption track had its own lane; otherwise one
  // track per caption role (overlaps spill onto more).
  const captions = items.filter(it => it.group === 'caption')
  const mdCaptionTracks = (Array.isArray(md?.tracks) ? md.tracks : []).filter(t => t?.kind === 'caption')
  if (md && mdCaptionTracks.length) {
    const lanes = [...new Set(captions.map(it => it.lane))].sort((a, b) => a - b)
    lanes.forEach((ln, k) => {
      const track = mdCaptionTracks[k]
      if (!track) return
      const ids = Array.isArray(md.captionIds?.[track.id]) ? md.captionIds[track.id] : []
      captions.filter(it => it.lane === ln).sort((a, b) => a.f0 - b.f0).forEach((it, i) => {
        it.mdTrack = track.id
        if (ids[i]) it.json = { id: ids[i] }
      })
    })
  }
  for (const it of captions) {
    const lang = /captionFormat=([A-Za-z0-9]+)\.?([\w-]*)/.exec(it.role)
    it.key = it.role
    it.sort = it.lane
    it.trackName = lang ? `Captions ${lang[2] || lang[1]}` : undefined
  }

  const colorSpace = /9-16-9|PQ/.test(fmt?.attrs.colorSpace ?? '') ? 'rec2020-pq' : /9-18-9|HLG/.test(fmt?.attrs.colorSpace ?? '') ? 'rec2020-hlg' : 'rec709'
  const sampleRate = { '32k': 32000, '44.1k': 44100, '48k': 48000, '88.2k': 88200, '96k': 96000, '176.4k': 176400, '192k': 192000 }[seq.attrs.audioRate]

  return assemble({ fps, md, warn, items, markers, assets, name: projectNode.attrs.name, width, height, sampleRate, colorSpace })
}

// ---------------------------------------------------------------- OpenTimelineIO

const OTIO_COLORS = { RED: '#ff5f57', PINK: '#ff7b72', ORANGE: '#f0883e', YELLOW: '#f5b942', GREEN: '#3fb950', CYAN: '#39c5cf', BLUE: '#58a6ff', PURPLE: '#bc8cff', MAGENTA: '#f778ba', BLACK: '#000000', WHITE: '#ffffff' }

function otioColor(hex) {
  const c = hexToRGBA(hex)
  if (!c) return 'RED'
  let best = 'RED'
  let dist = Infinity
  for (const [name, h] of Object.entries(OTIO_COLORS)) {
    const o = hexToRGBA(h)
    const d = (o[0] - c[0]) ** 2 + (o[1] - c[1]) ** 2 + (o[2] - c[2]) ** 2
    if (d < dist) {
      dist = d
      best = name
    }
  }

  return best
}

const GENERATOR_KINDS = { title: 'Title', color: 'SolidColor' }

/**
 * Exports the main timeline as OpenTimelineIO JSON (Timeline.1). Video tracks come first,
 * bottom to top, then audio tracks. Clips reference media with ExternalReference file
 * URLs; titles and colors are GeneratorReferences. Times are whole frames at the exact
 * project rate (30000/1001 for 29.97). Speed follows OTIO's LinearTimeWarp convention:
 * source_range.duration is the clip's length on the track and time_scalar is the speed
 * (negative when reversed); freeze frames use FreezeFrame. Transitions are SMPTE_Dissolve,
 * centered on the cut. OTIO has no captions, so caption tracks travel in metadata.reel.
 * Returns the JSON object; options: { metadata: true, warnings: [] }.
 */
export function toOTIO(project, root = '', options = {}) {
  const p = migrate(clone(project))
  const warn = m => options.warnings && !options.warnings.includes(m) && options.warnings.push(m)
  const withMd = options.metadata !== false
  const fps = p.fps
  const rate = exactRate(fps)
  const F = t => Math.round((t ?? 0) * fps)
  const RT = v => ({ OTIO_SCHEMA: 'RationalTime.1', rate, value: v })
  const TR = (s, d) => ({ OTIO_SCHEMA: 'TimeRange.1', duration: RT(d), start_time: RT(s) })
  const gap = d => ({ OTIO_SCHEMA: 'Gap.1', metadata: {}, name: '', source_range: TR(0, d), effects: [], markers: [], enabled: true, color: null })

  const clipItem = (c, t, df, transitionWritten) => {
    const a = c.src ? p.assets[c.src] : null
    const media = MEDIA_KINDS.has(c.kind) && c.src
    const expressed = ['start', 'dur', 'enabled', ...(transitionWritten ? ['transitionIn'] : [])]
    const effects = []
    let ref
    let startF = 0
    if (media) {
      expressed.push('kind', 'src', 'freeze', ...(c.freeze !== undefined ? [] : ['in', 'speed', 'reverse']))
      ref = { OTIO_SCHEMA: 'ExternalReference.1', metadata: {}, name: '', available_range: a?.duration && c.kind !== 'image' ? TR(0, F(a.duration)) : null, available_image_bounds: null, target_url: fileURL(absolutePath(c.src, root)) }
      if (c.kind !== 'image') {
        startF = F(c.freeze ?? c.in ?? 0)
        if (c.freeze !== undefined) effects.push({ OTIO_SCHEMA: 'FreezeFrame.1', metadata: {}, name: '', effect_name: 'FreezeFrame', enabled: true, time_scalar: 0 })
        else if ((c.speed ?? 1) !== 1 || c.reverse) effects.push({ OTIO_SCHEMA: 'LinearTimeWarp.1', metadata: {}, name: '', effect_name: 'LinearTimeWarp', enabled: true, time_scalar: (c.reverse ? -1 : 1) * (c.speed ?? 1) })
      }
    } else {
      const kind = GENERATOR_KINDS[c.kind] ?? `Reel.${c.kind}`
      const parameters = c.kind === 'title' ? { text: c.title?.text ?? '' } : c.kind === 'color' ? { color: c.color ?? '#202020' } : {}
      if (c.kind === 'color') expressed.push('kind', 'color')
      ref = { OTIO_SCHEMA: 'GeneratorReference.1', metadata: {}, name: '', available_range: null, available_image_bounds: null, generator_kind: kind, parameters }
    }
    let json = omit(c, expressed)
    if (c.kind === 'title') json = { ...omit(json, ['kind']), title: omit(c.title ?? {}, ['text']) }

    return {
      OTIO_SCHEMA: 'Clip.2',
      metadata: withMd ? { reel: { clip: json, track: t.id } } : {},
      name: nameOf(c),
      source_range: TR(startF, df),
      effects,
      markers: [],
      enabled: c.enabled !== false,
      color: null,
      media_references: { DEFAULT_MEDIA: ref },
      active_media_reference_key: 'DEFAULT_MEDIA',
    }
  }

  const trackItems = (t, clips) => {
    const out = []
    let cursor = 0
    for (const c of clips) {
      const f0 = F(c.start)
      const df = Math.max(1, F(c.dur))
      if (f0 > cursor) out.push(gap(f0 - cursor))
      let written = false
      if (c.transitionIn && t.kind === 'video') {
        if (out.length) {
          const D = Math.max(2, F(c.transitionIn.dur))
          const left = Math.floor(D / 2)
          out.push({ OTIO_SCHEMA: 'Transition.1', metadata: withMd ? { reel: { type: c.transitionIn.type } } : {}, name: c.transitionIn.type ?? '', in_offset: RT(left), out_offset: RT(D - left), transition_type: 'SMPTE_Dissolve' })
          written = true
        } else warn(`the transition into ${c.id} has nothing before it and is kept only in Reel metadata`)
      }
      out.push(clipItem(c, t, df, written))
      cursor = f0 + df
    }

    return out
  }

  const children = []
  for (const t of p.tracks) {
    if (t.kind !== 'video' && t.kind !== 'audio') continue
    // Clips that overlap go to extra tracks right after, since an OTIO track is a sequence.
    const lanes = []
    for (const c of [...t.clips].sort((a, b) => a.start - b.start)) {
      const f0 = F(c.start)
      let lane = lanes.find(l => l.end <= f0)
      if (!lane) {
        lane = { end: -Infinity, clips: [] }
        lanes.push(lane)
      }
      lane.clips.push(c)
      lane.end = f0 + Math.max(1, F(c.dur))
    }
    if (!lanes.length) lanes.push({ clips: [] })
    if (lanes.length > 1) warn(`overlapping clips on ${t.id} are exported on ${lanes.length - 1} extra track(s)`)
    lanes.forEach((lane, i) => children.push({
      OTIO_SCHEMA: 'Track.1',
      metadata: withMd ? { reel: { track: t.id, ...(i ? { overflow: true } : {}) } } : {},
      name: i ? `${t.name ?? t.id} ${i + 1}` : t.name ?? t.id,
      source_range: null,
      effects: [],
      markers: [],
      enabled: !(t.hidden || t.muted),
      color: null,
      children: trackItems(t, lane.clips),
      kind: t.kind === 'audio' ? 'Audio' : 'Video',
    }))
  }
  const md = { ...projectMetadata(p), assets: p.assets ?? {}, captionTracks: p.tracks.filter(t => t.kind === 'caption') }
  if (md.captionTracks.length && !withMd) warn('caption tracks are left out: OpenTimelineIO has no captions (export SRT or WebVTT)')

  return {
    OTIO_SCHEMA: 'Timeline.1',
    metadata: withMd ? { reel: md } : {},
    name: p.name,
    global_start_time: RT(0),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      metadata: {},
      name: 'tracks',
      source_range: null,
      effects: [],
      markers: (p.markers ?? []).map(m => ({
        OTIO_SCHEMA: 'Marker.2',
        metadata: withMd ? { reel: defined({ id: m.id, color: m.color, kind: m.kind }) } : {},
        name: m.label ?? '',
        color: otioColor(m.color),
        marked_range: TR(F(m.t), F(m.dur ?? 0)),
        comment: m.note ?? '',
      })),
      enabled: true,
      color: null,
      children,
    },
  }
}

/**
 * Reads OpenTimelineIO JSON (a Timeline, or the first Timeline of a SerializableCollection)
 * into a Reel v3 project. Video tracks become video tracks bottom to top, Audio tracks audio
 * tracks; gaps, transitions (centered on the cut), LinearTimeWarp/FreezeFrame and markers
 * (timeline, track and clip) are read. Video-track clips never play sound (OTIO keeps sound on
 * audio tracks); a video and an audio clip of the same source over the same span are linked.
 * options: { warnings: [] }
 */
export function fromOTIO(input, root = '', options = {}) {
  const warnings = options.warnings ?? []
  const warn = m => !warnings.includes(m) && warnings.push(m)
  let tl = typeof input === 'string' ? JSON.parse(input) : input
  if (String(tl?.OTIO_SCHEMA ?? '').startsWith('SerializableCollection')) tl = (tl.children ?? []).find(x => String(x?.OTIO_SCHEMA ?? '').startsWith('Timeline'))
  if (!String(tl?.OTIO_SCHEMA ?? '').startsWith('Timeline')) throw new Error('not an OpenTimelineIO timeline')
  const md = tl.metadata?.reel?.format === 'reel' ? tl.metadata.reel : null
  let firstRate = tl.global_start_time?.rate
  const scan = n => {
    if (firstRate || !n || typeof n !== 'object') return
    if (n.OTIO_SCHEMA === 'RationalTime.1' && n.rate > 0) firstRate = n.rate
    for (const v of Object.values(n)) scan(v)
  }
  scan(tl.tracks)
  const fps = isNum(md?.fps) ? md.fps : normalizeFps(firstRate || 24)
  const exact = exactRate(fps)
  const sec = rt => (rt && isNum(rt.value) && isNum(rt.rate) && rt.rate > 0 ? rt.value / rt.rate : 0)
  const toF = s => Math.round(s * exact)
  const assets = {}
  const items = []
  const markers = []
  const pushMarkers = (list, offset) => {
    for (const m of list ?? []) {
      const r = m.marked_range
      const saved = m.metadata?.reel
      const color = saved?.color ?? OTIO_COLORS[m.color]
      markers.push({ f: toF(offset + sec(r?.start_time)), df: toF(sec(r?.duration)), label: m.name ?? '', note: m.comment || undefined, color, kind: saved?.kind })
    }
  }
  const tracks = (tl.tracks?.children ?? []).filter(t => {
    if (String(t?.OTIO_SCHEMA ?? '').startsWith('Track')) return true
    warn('nested stacks at the top of the timeline are not imported')

    return false
  })
  tracks.forEach((tr, ti) => {
    const group = tr.kind === 'Audio' ? 'audio' : tr.kind === 'Video' ? 'video' : null
    if (!group) {
      warn(`track "${tr.name}" of kind ${tr.kind} is not imported`)

      return
    }
    const mdTrack = md ? tr.metadata?.reel?.track : undefined
    let cursor = 0
    let pending = null
    for (const ch of tr.children ?? []) {
      const schema = String(ch?.OTIO_SCHEMA ?? '')
      if (schema.startsWith('Transition')) {
        pending = { dur: sec(ch.in_offset) + sec(ch.out_offset), type: ch.metadata?.reel?.type }
        if (Math.abs(sec(ch.in_offset) - sec(ch.out_offset)) > 1.5 / exact) warn('off-center transitions are imported centered on the cut')
        continue
      }
      const ref = ch.media_references?.[ch.active_media_reference_key ?? 'DEFAULT_MEDIA'] ?? ch.media_reference ?? null
      const range = ch.source_range ?? ref?.available_range
      const dur = sec(range?.duration)
      if (schema.startsWith('Clip')) {
        const json = md ? ch.metadata?.reel?.clip ?? null : null
        const refSchema = String(ref?.OTIO_SCHEMA ?? '')
        const enabled = ch.enabled === false ? false : undefined
        let s
        if (refSchema.startsWith('ExternalReference') && ref.target_url) {
          const key = projectPath(absolutePath(pathFromURL(ref.target_url), root), root)
          const a = (assets[key] ??= { hasVideo: false, hasAudio: false })
          if (group === 'video') a.hasVideo = true
          else a.hasAudio = true
          const avail = sec(ref.available_range?.duration)
          if (avail > 0) a.duration = Math.max(a.duration ?? 0, round(avail, 3))
          const warp = (ch.effects ?? []).find(e => /^(LinearTimeWarp|FreezeFrame)/.test(String(e?.OTIO_SCHEMA ?? '')))
          const scalar = warp ? Number(warp.time_scalar ?? 1) : 1
          const inSec = round(Math.max(0, sec(range?.start_time) - sec(ref.available_range?.start_time)), 5)
          const still = group === 'video' && !ref.available_range
          s = still ? { kind: 'image', src: key } : { kind: group === 'audio' ? 'audio' : 'video', src: key, in: inSec }
          if (!still && (scalar === 0 || /^FreezeFrame/.test(String(warp?.OTIO_SCHEMA ?? '')))) {
            s.freeze = inSec
            if (json) delete s.in
          } else if (!still && scalar !== 1) {
            s.speed = Math.abs(scalar)
            if (scalar < 0) s.reverse = true
          }
          if (group === 'video' && !still && !json) s.audioDetached = true
          if (!json && ch.name && ch.name !== stem(key) && ch.name !== basename(key)) s.label = ch.name
        } else if (refSchema.startsWith('GeneratorReference') && /title|text/i.test(ref.generator_kind ?? '')) {
          const text = String(ref.parameters?.text ?? ch.name ?? '')
          s = { kind: 'title', title: { ...(json?.title ?? TITLE_DEFAULTS), text } }
        } else if (refSchema.startsWith('GeneratorReference') && /solid|color/i.test(ref.generator_kind ?? '')) {
          s = { kind: 'color', color: ref.parameters?.color ?? json?.color ?? '#202020' }
          if (!json && ch.name) s.label = ch.name
        } else if (json?.kind) s = {}
        else {
          warn(`clip "${ch.name ?? ''}" has no media and is imported as a placeholder color`)
          s = { kind: 'color', color: '#202020', label: ch.name || 'Offline' }
        }
        s.enabled = enabled
        if (pending && group === 'video') s.transitionIn = { type: TRANSITIONS.includes(pending.type) ? pending.type : 'crossDissolve', dur: round(toF(pending.dur) / fps, 5) }
        const f0 = toF(cursor)
        const f1 = toF(cursor + dur)
        if (f1 > f0) items.push({ group: json?.kind === 'audio' || group === 'audio' ? 'audio' : 'video', key: ti, sort: ti, f0, f1, s, json, mdTrack: ch.metadata?.reel?.track ?? mdTrack, trackName: tr.name })
        pushMarkers(ch.markers, cursor - sec(range?.start_time))
      } else if (schema.startsWith('Gap')) {
        pushMarkers(ch.markers, cursor - sec(range?.start_time))
      } else {
        warn(`nested ${schema.split('.')[0]} items are imported as gaps`)
      }
      pending = null
      cursor += dur
    }
    pushMarkers(tr.markers, 0)
  })
  pushMarkers(tl.tracks?.markers, 0)
  for (const t of Array.isArray(md?.captionTracks) ? md.captionTracks : []) {
    for (const c of t.clips ?? []) {
      if (!isNum(c?.start) || !isNum(c?.dur)) continue
      const f0 = Math.round(c.start * fps)
      items.push({ group: 'caption', key: t.id, sort: 0, f0, f1: f0 + Math.max(1, Math.round(c.dur * fps)), s: {}, json: c, mdTrack: t.id })
    }
  }
  for (const [key, a] of Object.entries(assets)) if (a.hasVideo && !a.duration && !md?.assets?.[key]) a.still = true
  for (const [key, a] of Object.entries(md?.assets ?? {})) assets[key] = { ...(assets[key] ?? {}), ...clone(a) }

  return assemble({ fps, md, warn, items, markers, assets, name: tl.name, width: md?.width ?? 1920, height: md?.height ?? 1080, linkPairs: !md })
}

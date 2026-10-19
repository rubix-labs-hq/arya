// CMX 3600 edit decision lists for conforming in DaVinci Resolve, Avid and other finishing tools.
// One video track per list, with its linked audio as AA/V events. Record timecode starts at
// 01:00:00:00, the usual timeline start in Resolve. Arya does not read source timecode, so source
// timecode counts from 00:00:00:00 at the start of each file; "FROM CLIP NAME" and "SOURCE FILE"
// comments let the receiving tool relink by name.
//
// An EDL is read line by line, so every text field that reaches the file is reduced to one line:
// control characters (CR, LF, tabs, NUL, C1 controls, Unicode line and paragraph separators)
// become spaces and each field has a length limit. Without that, a file or project name could
// add its own events or comments to the list.

import { absolutePath, exactRate } from './interchange.js'

const RECORD_START_HOURS = 1
const TITLE_MAX = 70
const NAME_MAX = 255
const PATH_MAX = 1024
// The source column of a CMX 3600 event: up to 8 characters from A-Z, 0-9 and underscore.
const REEL_MAX = 8

/** One line of text: control characters and line separators become spaces, length is bounded. */
export function edlText(value, max) {
  const flat = String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/g, ' ').replace(/ {2,}/g, ' ').trim()
  return [...flat].slice(0, max).join('').trimEnd()
}

/** A reel name in the CMX 3600 character set and width; AX (a file-based source) when empty. */
export function edlReel(value) {
  const reel = String(value ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, REEL_MAX)
  return reel || 'AX'
}

function timecode(frames, base) {
  const f = Math.max(0, Math.round(frames))
  const hh = Math.floor(f / (base * 3600))
  const mm = Math.floor(f / (base * 60)) % 60
  const ss = Math.floor(f / base) % 60
  const ff = f % base
  return [hh, mm, ss, ff].map(n => String(n).padStart(2, '0')).join(':')
}

const clipEnd = c => c.start + c.dur
const fileName = src => String(src ?? '').split(/[\\/]/).pop()

/**
 * The CMX 3600 text for one video track (the bottom video track by default). Clips that are not
 * media (titles, shapes, compositions) and transitions cannot be described in an EDL; they are
 * left out with a warning.
 */
export function toEDL(project, root = '', options = {}) {
  const warnings = options.warnings ?? []
  const rate = exactRate(project.fps ?? 30)
  const base = Math.round(rate)
  const dropFrame = Math.abs(rate - base) > 1e-6
  const video = (project.tracks ?? []).filter(t => t.kind === 'video')
  const track = options.track ? video.find(t => t.id === options.track) : video[0]
  if (!track) throw new Error(options.track ? `no video track ${edlText(options.track, 32)}` : 'the project has no video track')
  const audio = (project.tracks ?? []).filter(t => t.kind === 'audio').flatMap(t => t.clips)
  const frames = seconds => Math.round(seconds * rate)
  const record = seconds => timecode(frames(seconds) + RECORD_START_HOURS * 3600 * base, base)
  const reel = edlReel(options.reel)
  const lines = [`TITLE: ${edlText(project.name ?? 'Arya', TITLE_MAX) || 'Arya'}`, 'FCM: NON-DROP FRAME', '']
  if (dropFrame) warnings.push(`EDL timecode counts ${base} frames per second without drop frame for the ${project.fps} fps timeline.`)
  let n = 0
  const skipped = new Set()
  for (const c of [...track.clips].sort((a, b) => a.start - b.start)) {
    if (c.enabled === false) continue
    if (!['video', 'image'].includes(c.kind) || !c.src) { skipped.add(edlText(c.kind, 32)); continue }
    const speed = Number(c.speed ?? 1)
    const inPoint = c.kind === 'image' ? 0 : Number(c.in ?? 0)
    if (![c.start, c.dur, inPoint, speed].every(Number.isFinite) || c.dur <= 0 || speed <= 0) { warnings.push(`${edlText(c.id, 32)} has invalid timing and is left out of the EDL.`); continue }
    n++
    const sourceIn = frames(inPoint)
    const sourceOut = sourceIn + (frames(clipEnd(c)) - frames(c.start)) * (c.freeze !== undefined ? 0 : speed)
    const partner = c.link ? audio.find(a => a.link === c.link && Math.abs(a.start - c.start) < 1e-3 && Math.abs(a.dur - c.dur) < 1e-3) : null
    const channel = partner ? 'AA/V' : 'V'
    const event = String(n).padStart(3, '0')
    lines.push(`${event}  ${reel.padEnd(8)} ${channel.padEnd(5)} C        ${timecode(sourceIn, base)} ${timecode(Math.max(sourceIn + 1, Math.round(sourceOut)), base)} ${record(c.start)} ${record(clipEnd(c))}`)
    if (speed !== 1 || c.reverse || c.freeze !== undefined) {
      const fps = c.freeze !== undefined ? 0 : (c.reverse ? -1 : 1) * rate * Math.min(speed, 20)
      lines.push(`M2   ${reel.padEnd(8)} ${(fps < 0 ? '-' : '') + Math.abs(fps).toFixed(1).padStart(5, '0')}                ${timecode(sourceIn, base)}`)
    }
    lines.push(`* FROM CLIP NAME: ${edlText(fileName(c.src), NAME_MAX)}`)
    lines.push(`* SOURCE FILE: ${edlText(root ? absolutePath(c.src, root) : c.src, PATH_MAX)}`)
    if (c.transitionIn) warnings.push(`${edlText(c.id, 32)}: the ${edlText(c.transitionIn.type, 32)} into this clip is a cut in the EDL.`)
    lines.push('')
  }
  for (const kind of skipped) warnings.push(`${kind} clips on ${edlText(track.id, 32)} are not media and are left out of the EDL.`)
  if (video.length > 1) warnings.push(`The EDL describes ${edlText(track.id, 32)} only. Export each video track as its own EDL.`)
  if (!n) throw new Error(`${edlText(track.id, 32)} has no media clips to describe in an EDL`)

  return `${lines.join('\n').trimEnd()}\n`
}

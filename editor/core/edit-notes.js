// Facts about a batch of ops that its log lines do not state: text likely wider than the frame,
// clips or captions hidden under another on the same track, what a speed change did to length and
// pitch, text that lost time in a cut and kept its words, caption style keys that draw nothing,
// fonts that may fall back, text too brief to read, and video zoomed past the scale that fills
// the frame. The server returns them beside the log of POST /api/ops and
// POST /api/assistant/propose. They are never written to the project, the log or undo summaries.
//
// Every note states what the edit model and the browser renderer do. Widths are estimates from
// character counts, because nothing here can measure text, and each note says so.
//
// Each note has two forms built side by side: the agent's, with clip ids, property paths and the
// fix to send, and the person's, a short sentence that names clips as the timeline does. Notes
// that only help the agent (title positions) have no person form.

import { clipEnd, hasAudio, round } from './project.js'
import { BUNDLED_FONTS, knownFont } from './fonts.js'
import { clipName } from './describe.js'

const MAX_NOTES = 10
const MAX_NOTE = 700
const LISTED = 6
// The person's overlap sentence names two clips per pair, so it lists fewer pairs than the agent's.
const PEOPLE_LISTED = 3

/** Caption style keys core/caption-render.js and the frame renderer read. */
export const CAPTION_STYLE_KEYS = ['preset', 'font', 'size', 'weight', 'color', 'highlightColor', 'plate', 'padding', 'radius', 'align', 'lineHeight', 'maxLines', 'y']

const num = value => String(round(value, 2))
const list = values => values.length < 2 ? values.join('') : `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`
const quote = text => { const flat = String(text ?? '').replace(/\s+/g, ' ').trim(); return `"${flat.length > 40 ? `${flat.slice(0, 37)}...` : flat}"` }
/** One note: the agent's sentence and the person's, or null when the person gets none. */
const note = (agent, person = null) => ({ agent, person })
/** A clip as the person sees it on the timeline, quoted and shortened. A name that cannot be read never costs the agent its notes. */
const named = (index, clip) => { try { return quote(clipName(index.project, clip)) } catch { return '"a clip"' } }
/** The first `LISTED` parts joined, with a count of the rest. */
const capped = (parts, join = '; ') => parts.length > LISTED ? `${parts.slice(0, LISTED).join(join)}${join}and ${parts.length - LISTED} more` : parts.join(join)

// Average advance widths in em for a bold sans, by character class.
const charEm = char => char === ' ' ? 0.28 : /[iIljtf.,:;'’!|()[\]]/.test(char) ? 0.32 : /[MWmw@%]/.test(char) ? 0.9 : /[A-Z0-9]/.test(char) ? 0.68 : 0.55

/** Estimated width of the longest line, in the units title.size uses. Not a measurement. */
export function estimateTextUnits(text, size, tracking = 0) {
  let widest = 0
  for (const line of String(text ?? '').split('\n')) {
    const chars = [...line]
    widest = Math.max(widest, chars.reduce((sum, char) => sum + charEm(char), 0) * size + Math.max(0, tracking) * chars.length)
  }
  return widest
}

/** Every clip of the main timeline and the compositions, with the frame it draws in. */
function indexClips(p) {
  const clips = new Map(), tracks = []
  const scopes = [{ comp: null, tracks: p.tracks ?? [], width: p.width, height: p.height, fps: p.fps }, ...Object.entries(p.comps ?? {}).map(([id, comp]) => ({ comp: id, tracks: comp.tracks ?? [], width: comp.width ?? p.width, height: comp.height ?? p.height, fps: comp.fps ?? p.fps }))]
  for (const scope of scopes) {
    const fps = scope.fps > 0 ? scope.fps : 30
    for (const track of scope.tracks) {
      tracks.push({ track, comp: scope.comp, fps })
      ;(track.clips ?? []).forEach((clip, order) => clips.set(clip.id, { clip, track, order, comp: scope.comp, width: scope.width, height: scope.height, fps }))
    }
  }
  return { clips, tracks, project: p }
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const clipText = clip => clip.kind === 'title' ? clip.title?.text : clip.kind === 'caption' ? clip.text : undefined
const longestLine = text => Math.max(0, ...String(text ?? '').split('\n').map(line => [...line].length))

function titleWidthNotes(before, after, made) {
  const notes = []
  for (const [id, entry] of after.clips) {
    const { clip } = entry
    if (clip.kind !== 'title' || clip.enabled === false) continue
    const old = before.clips.get(id)?.clip
    const sized = c => [c.title?.text, c.title?.size, c.title?.tracking, c.title?.box, c.scale, c.scaleX]
    if (!made.has(id) && old && same(sized(old), sized(clip))) continue
    if (!(entry.width > 0 && entry.height > 0)) continue
    const size = clip.title?.size ?? 96, scale = (typeof clip.scale === 'number' ? clip.scale : 1) * (typeof clip.scaleX === 'number' ? clip.scaleX : 1)
    if (!(size > 0) || !(scale > 0)) continue
    const frame = entry.width * 1080 / entry.height
    const box = clip.title?.box
    if (box?.wrap) {
      // A wrapping title breaks its lines at the box, so only a box wider than the frame can run off it.
      if (box.width * scale > frame) notes.push(note(`${id} title.box is ${Math.round(box.width * scale)} units wide${scale === 1 ? '' : ` at scale ${num(scale)}`}; the frame is ${Math.floor(frame)} units wide. Lines wrap at the box, so they can run past the frame. Set title.box.width to at most ${Math.floor(frame * 0.9 / scale)}.`,
        `The title ${named(after, clip)} wraps in a box wider than the frame, so its lines can run past the edges.`))
      continue
    }
    const estimate = estimateTextUnits(clip.title?.text, size, clip.title?.tracking ?? 0) * scale
    if (estimate <= frame * 0.9) continue
    const fit = Math.floor(size * frame * 0.9 / estimate)
    // Past the frame the text is cut off. Between 90% and 100% it fits but leaves almost no margin.
    const against = estimate > frame ? `the frame is ${Math.floor(frame)} units wide` : `that is wider than 90% of the frame (${Math.floor(frame * 0.9)} of ${Math.floor(frame)} units), so it may touch the edges`
    notes.push(note(`${id} title is about ${Math.round(estimate)} units wide (an estimate from its ${longestLine(clip.title?.text)} characters at size ${num(size)}${scale === 1 ? '' : ` at scale ${num(scale)}`}); ${against}. It does not wrap. Lower title.size to about ${fit}, break the line with \\n, or set title.box {width:${Math.floor(frame * 0.9 / scale)}, height:${Math.round(size)}, wrap:true, autoHeight:true}.`,
      estimate > frame ? `The title ${named(after, clip)} is wider than the frame. Make it smaller or let it wrap.` : `The title ${named(after, clip)} nearly fills the frame width and may touch the edges.`))
  }
  if (notes.length <= LISTED) return notes
  const more = notes.length - LISTED
  return [...notes.slice(0, LISTED), note(`and ${more} more titles are estimated wider than 90% of the frame.`, `${more} more ${more === 1 ? 'title' : 'titles'} may be too wide for the frame.`)]
}

function titlePlaceNote(before, after, made) {
  const groups = new Map()
  for (const [id, entry] of after.clips) {
    const { clip } = entry
    if (clip.kind !== 'title' || clip.enabled === false || clip.anim?.y || clip.parent || !(entry.height > 0)) continue
    const old = before.clips.get(id)?.clip
    if (!made.has(id) && old && same(old.y, clip.y)) continue
    const percent = Math.round((typeof clip.y === 'number' ? clip.y : entry.height / 2) / entry.height * 100)
    groups.set(percent, [...(groups.get(percent) ?? []), id])
  }
  if (!groups.size) return []
  const parts = [...groups].map(([percent, ids]) => `${ids.length > 8 ? `${ids.slice(0, 8).join(', ')} and ${ids.length - 8} more` : ids.join(', ')} at ${percent}%`)
  return [note(`Title centres, measured from the top of the frame: ${capped(parts)}. The editor knows no face or subject position, so only a rendered frame shows what a title covers.`)]
}

const MAX_PAIRS = 60

function overlapNote(before, after, made) {
  const pairs = [], people = [], captions = [], spoken = []
  let more = false
  const moved = id => { const old = before.clips.get(id), now = after.clips.get(id); return !old || made.has(id) || old.track.id !== now.track.id || old.comp !== now.comp || old.clip.start !== now.clip.start || old.clip.dur !== now.clip.dur || (old.clip.enabled === false) !== (now.clip.enabled === false) }
  for (const { track, fps } of after.tracks) {
    // Picture tracks and caption tracks both draw only the first clip in their list that covers a time.
    if (!['video', 'caption'].includes(track.kind) || more) continue
    const clips = (track.clips ?? []).map((clip, order) => ({ clip, order })).filter(({ clip }) => clip.enabled !== false)
    if (!clips.some(({ clip }) => moved(clip.id))) continue
    // Sorted by start, each clip is compared only with the clips that begin before it ends.
    clips.sort((a, b) => a.clip.start - b.clip.start || a.order - b.order)
    scan: for (let low = 0; low < clips.length; low++) {
      const end = clipEnd(clips[low].clip)
      for (let high = low + 1; high < clips.length && clips[high].clip.start < end - 1e-6; high++) {
        if (!moved(clips[low].clip.id) && !moved(clips[high].clip.id)) continue
        if (pairs.length + captions.length === MAX_PAIRS) { more = true; break scan }
        // The renderer draws the first clip in track order that covers the time (clips.find).
        const [first, second] = clips[low].order < clips[high].order ? [clips[low].clip, clips[high].clip] : [clips[high].clip, clips[low].clip]
        const from = Math.max(first.start, second.start), to = Math.min(clipEnd(first), clipEnd(second))
        // Stored times are rounded, so an overlap of one frame can be a little short of 1/fps; half a frame or less hides nothing.
        if (to - from > 0.5 / fps) {
          ;(track.kind === 'caption' ? captions : pairs).push(`${second.id} is hidden under ${first.id} on ${track.id} from ${num(from)}s to ${num(to)}s`)
          ;(track.kind === 'caption' ? spoken : people).push(`${named(after, second)} is hidden under ${named(after, first)} from ${num(from)}s to ${num(to)}s`)
        }
      }
    }
  }
  const listed = parts => more ? `${parts.slice(0, LISTED).join('; ')}; and more` : capped(parts)
  const shown = parts => more || parts.length > PEOPLE_LISTED ? `${parts.slice(0, PEOPLE_LISTED).join('; ')}; and ${more ? 'more' : `${parts.length - PEOPLE_LISTED} more`}` : parts.join('; ')
  return [
    ...(pairs.length ? [note(`Overlaps on one track (a track shows one clip at a time, the one that comes first in the track's clip list): ${listed(pairs)}. Move the hidden clip to another track, or omit track when adding so it gets a free one.`,
      `A track shows one clip at a time, so overlapping clips hide each other: ${shown(people)}. Move one to another track to show both.`)] : []),
    ...(captions.length ? [note(`Caption overlaps (a caption track shows one caption at a time, the one that comes first in its clip list): ${listed(captions)}. Trim the earlier caption to end where the next one starts.`,
      `A caption track shows one caption at a time, so overlapping captions hide each other: ${shown(spoken)}. Shorten the earlier one.`)] : []),
  ]
}

function speedNotes(before, after, ops, project) {
  const notes = [], seen = new Set()
  for (const op of ops) {
    if (op?.op !== 'speed' || seen.has(op.id)) continue
    seen.add(op.id)
    const old = before.clips.get(op.id), now = after.clips.get(op.id)
    if (!old || !now) continue
    const was = old.clip.speed ?? 1, speed = now.clip.speed ?? 1
    if (was === speed || !(speed > 0)) continue
    const partner = now.clip.link ? [...after.clips.values()].find(other => other.clip !== now.clip && other.clip.link === now.clip.link && other.comp === now.comp && hasAudio(project, other.clip)) : null
    const semitones = round(12 * Math.log2(speed), 2)
    const pitched = (hasAudio(project, now.clip) || partner) && semitones !== 0
    const sound = pitched ? ` Its sound plays ${num(Math.abs(semitones))} semitones ${semitones > 0 ? 'higher' : 'lower'} than at 1x.` : ''
    notes.push(note(`${op.id} now plays at ${num(speed)}x (was ${num(was)}x): ${num(old.clip.dur)}s became ${num(now.clip.dur)}s.${sound}`,
      `${named(after, now.clip)} now plays at ${num(speed)}x, so it is ${num(now.clip.dur)}s long instead of ${num(old.clip.dur)}s.${pitched ? ` Its sound is ${semitones > 0 ? 'higher' : 'lower'}.` : ''}`))
  }
  const more = notes.length - LISTED
  return notes.length > LISTED ? [...notes.slice(0, LISTED), note(`and ${more} more clips changed speed.`, `${more} more ${more === 1 ? 'clip' : 'clips'} changed speed.`)] : notes
}

function shortenedTextNote(before, after, ops) {
  const named = new Set(ops.flatMap(op => [op?.id, op?.a, op?.b, ...(Array.isArray(op?.ids) ? op.ids : [])]).filter(id => typeof id === 'string'))
  const parts = [], people = []
  for (const [id, { clip }] of after.clips) {
    const old = before.clips.get(id)?.clip
    if (!old || named.has(id) || !['title', 'caption'].includes(clip.kind) || clip.kind === 'caption' && Array.isArray(old.words)) continue
    const text = clipText(clip)
    if (!String(text ?? '').trim() || text !== clipText(old) || !(old.dur - clip.dur > 1e-4)) continue
    parts.push(`${id} ${quote(text)} lost ${num(old.dur - clip.dur)}s (now ${num(clip.dur)}s)`)
    people.push(`${quote(text)} is now ${num(clip.dur)}s`)
  }
  if (!parts.length) return []
  return [note(`Text that lost time in this edit and kept its words: ${capped(parts)}. A cut never rewrites a title, or a caption without word timings, so check each against the sound.`,
    `Some text got shorter but kept its words: ${capped(people)}. Check that it still matches the sound.`)]
}

function untimedCaptionNote(ops) {
  const count = ops.filter(op => op?.op === 'captions').flatMap(op => Array.isArray(op.items) ? op.items : []).filter(item => !Array.isArray(item?.words)).length
  if (!count) return []
  return [note(`${count} new caption${count === 1 ? ' has' : 's have'} no word timings, so a cut shortens ${count === 1 ? 'it' : 'them'} without changing ${count === 1 ? 'its' : 'their'} text. Send words:[{t,end,text}] in timeline seconds with each item to keep ${count === 1 ? 'it' : 'them'} in step with cuts.`,
    `${count} new caption${count === 1 ? ' has' : 's have'} no word timings, so a later cut shortens ${count === 1 ? 'it' : 'them'} without changing the text.`)]
}

/** Style objects this batch set on caption tracks: {track, style}. */
function captionStyleEdits(after, ops) {
  const edits = []
  // An op without comp acts on the main timeline, as applyOps scopes it.
  const captionTrack = (id, comp) => after.tracks.find(entry => entry.track.kind === 'caption' && (id ? entry.track.id === id : true) && entry.comp === comp)?.track
  for (const op of ops) {
    const comp = op?.comp ?? null
    if (op?.op === 'update_track' && op.set?.style && typeof op.set.style === 'object') {
      const track = captionTrack(op.id, comp)
      if (track) edits.push({ track, style: op.set.style })
    } else if ((op?.op === 'captions' || op?.op === 'add_caption') && op.style && typeof op.style === 'object') {
      const track = captionTrack(op.track, comp)
      if (track) edits.push({ track, style: op.style })
    }
  }
  return edits
}

function captionStyleNotes(after, ops) {
  const notes = [], unknown = new Map(), highlight = new Set()
  for (const { track, style } of captionStyleEdits(after, ops)) {
    for (const key of Object.keys(style)) {
      if (style[key] === null || CAPTION_STYLE_KEYS.includes(key)) continue
      unknown.set(track.id, [...new Set([...(unknown.get(track.id) ?? []), key])])
    }
    if (typeof style.highlightColor === 'string' && track.style?.preset !== 'karaoke') highlight.add(track)
  }
  for (const [id, keys] of unknown) {
    notes.push(note(`${list(keys.slice(0, 8).map(key => `style.${key}`))} on ${id} ${keys.length === 1 ? 'is not a caption style option and draws' : 'are not caption style options and draw'} nothing.${keys.includes('highlight') ? ' Use highlightColor, not highlight.' : ''} Options: ${CAPTION_STYLE_KEYS.join(', ')}.`,
      `${keys.length === 1 ? 'One caption style setting' : `${keys.length} caption style settings`} in this edit ${keys.length === 1 ? 'has' : 'have'} no effect.`))
  }
  for (const track of highlight) notes.push(note(`style.highlightColor on ${track.id} shows only with preset karaoke, on captions that have word timings. ${track.id} has ${track.style?.preset ? `preset ${track.style.preset}` : 'no preset'}.`,
    'The caption highlight color shows only with the Karaoke style, on captions that have word timings.'))
  return notes
}

function fontNotes(before, after, made, ops) {
  const users = new Map()
  const add = (font, user) => { if (!knownFont(font) && typeof font === 'string') { const key = font.trim().toLowerCase(); users.set(key, { name: users.get(key)?.name ?? font.trim(), ids: [...new Set([...(users.get(key)?.ids ?? []), user])] }) } }
  for (const [id, { clip }] of after.clips) {
    if (clip.kind !== 'title') continue
    const old = before.clips.get(id)?.clip
    if (made.has(id) || !old || old.title?.font !== clip.title?.font) add(clip.title?.font, id)
  }
  for (const { track, style } of captionStyleEdits(after, ops)) if (Object.hasOwn(style, 'font')) add(track.style?.font, track.id)
  return [...users.values()].map(({ name, ids }) => note(`"${name}" (${ids.length > 8 ? `${ids.slice(0, 8).join(', ')} and ${ids.length - 8} more` : ids.join(', ')}) is not a font this editor knows. It draws only if this Mac has that font; otherwise the text falls back to a system sans, which can be wider. Bundled: ${BUNDLED_FONTS.join(', ')}. GET /api/caps lists the system fonts under fonts.`,
    `${quote(name)} is not a built-in font. It shows only if this computer has it; otherwise the text uses a system font, which can be wider.`))
}

/** Title and caption clips this batch made or retimed. */
function retimedText(before, after, made) {
  return [...after.clips].filter(([id, { clip }]) => {
    if (!['title', 'caption'].includes(clip.kind) || clip.enabled === false || !(clip.dur > 0)) return false
    const old = before.clips.get(id)?.clip
    return made.has(id) || !old || old.start !== clip.start || old.dur !== clip.dur
  })
}

// Reading time for a title: about 0.6 s plus 0.1 s a word.
const readTime = text => 0.6 + 0.1 * String(text ?? '').split(/\s+/).filter(Boolean).length

/** Text left on screen for a frame or two (often what a cut leaves of a title or caption that crossed it), and titles too brief to read. */
function briefTextNotes(before, after, made) {
  const fragments = [], flashes = [], brief = [], hurried = []
  for (const [id, entry] of retimedText(before, after, made)) {
    const { clip } = entry
    // 2.5 frames, because stored times are rounded: two frames can be a little over 2/fps.
    if (clip.dur < 2.5 / entry.fps) {
      fragments.push(`${id} ${quote(clipText(clip))} at ${num(clip.start)}s lasts ${num(clip.dur)}s`)
      flashes.push(`${quote(clipText(clip))} at ${num(clip.start)}s`)
    } else if (clip.kind === 'title' && String(clipText(clip) ?? '').trim() && clip.dur < readTime(clipText(clip)) - 1e-6) {
      brief.push(`${id} ${quote(clipText(clip))} is on screen ${num(clip.dur)}s and needs about ${num(readTime(clipText(clip)))}s`)
      hurried.push(`${quote(clipText(clip))} shows for ${num(clip.dur)}s`)
    }
  }
  return [
    ...(fragments.length ? [note(`Text that lasts 2 frames or less, which reads as a flash: ${capped(fragments)}. A cut usually leaves these behind from text that crossed it. Delete them, or lengthen them if they belong.`,
      `Some text shows for only a frame or two: ${capped(flashes)}. Delete it if a cut left it behind.`)] : []),
    ...(brief.length ? [note(`Titles shorter than their reading time (about 0.6s plus 0.1s per word): ${capped(brief)}. Lengthen them or use fewer words.`,
      `Some titles are too brief to read: ${capped(hurried)}. Show them longer or shorten the text.`)] : []),
  ]
}

/** Video this batch scaled past the scale that fills its frame. Scale 1 fits the whole picture inside the frame. */
function fillScaleNotes(before, after, made, project) {
  const parts = [], people = []
  for (const [id, entry] of after.clips) {
    const { clip } = entry
    if (clip.kind !== 'video' || clip.enabled === false || clip.fit === 'cover') continue
    const asset = project.assets?.[clip.src]
    if (!(asset?.width > 0 && asset?.height > 0 && entry.width > 0 && entry.height > 0)) continue
    const old = before.clips.get(id)?.clip
    if (!made.has(id) && old && same([old.scale, old.anim?.scale], [clip.scale, clip.anim?.scale])) continue
    const fill = Math.max(entry.width / asset.width, entry.height / asset.height) / Math.min(entry.width / asset.width, entry.height / asset.height)
    // Only where the media's shape differs from the frame: a punch-in on matching media is a choice, not a reframe.
    if (!(fill > 1.01)) continue
    const scales = [typeof clip.scale === 'number' ? clip.scale : 1, ...(Array.isArray(clip.anim?.scale) ? clip.anim.scale.map(key => key?.[1]) : [])].filter(Number.isFinite)
    const most = Math.max(...scales)
    if (!(most > fill * 1.1)) continue
    const over = Math.round((most / fill - 1) * 100)
    parts.push(`${id} reaches scale ${num(most)}, ${over}% past ${num(fill)}, the scale at which its ${asset.width}x${asset.height} media fills the ${entry.width}x${entry.height} frame`)
    people.push(`${named(after, clip)} is zoomed ${over}% past the size that fills the frame`)
  }
  if (!parts.length) return []
  return [note(`Zoomed past the fill scale: ${capped(parts)}. The extra zoom crops the subject's margin. Render frames at least every 2 seconds and at fast moves and check the subject's distance from each edge, or lower scale toward the fill scale.`,
    `${capped(people)}, so more of the picture is cropped. Check that the subject stays in frame.`)]
}

/**
 * Short facts about what `ops` did between two project states. `created` is the id list applyOps
 * returned. Returns at most ten strings and never throws: a note must not fail an edit that landed.
 * `audience: 'person'` returns the sentences the editor shows under a change instead of the agent's.
 */
export function editNotes(before, after, { ops = [], created = [], audience = 'agent' } = {}) {
  try {
    if (!before || !after || !Array.isArray(ops)) return []
    const old = indexClips(before), now = indexClips(after), made = new Set(created)
    const notes = [
      ...overlapNote(old, now, made),
      ...titleWidthNotes(old, now, made),
      ...shortenedTextNote(old, now, ops),
      ...speedNotes(old, now, ops, after),
      ...captionStyleNotes(now, ops),
      ...fontNotes(old, now, made, ops),
      ...untimedCaptionNote(ops),
      ...titlePlaceNote(old, now, made),
      ...briefTextNotes(old, now, made),
      ...fillScaleNotes(old, now, made, after),
    ].map(entry => audience === 'person' ? entry.person : entry.agent).filter(Boolean)
      .map(note => note.length > MAX_NOTE ? `${note.slice(0, MAX_NOTE - 3)}...` : note)
    return notes.length > MAX_NOTES ? [...notes.slice(0, MAX_NOTES - 1), `and ${notes.length - MAX_NOTES + 1} more notes were left out.`] : notes
  } catch {
    return []
  }
}

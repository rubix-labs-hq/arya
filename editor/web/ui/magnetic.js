// Pack the primary storyline in a single undoable edit. Other tracks retain their
// timing, except unlocked linked partners which travel by the same delta as their shot.
export function primaryTrack(p) {
  return p?.tracks.find(t => t.id === 'V1' && t.kind === 'video' && !t.locked)
}

export function insertionIndex(clips, at) {
  const index = clips.findIndex(c => at < c.start + c.dur / 2)
  return index < 0 ? clips.length : index
}

export function mediaDropPosition(p, kind, hovered, at, magnetic) {
  if (hovered?.locked) return null
  const track = hovered?.kind === kind ? hovered : p.tracks.find(t => t.kind === kind && !t.locked)
  if (!track) return null
  if (!magnetic || track !== primaryTrack(p)) return { track, at }
  const clips = [...track.clips].sort((a, b) => a.start - b.start)
  const index = insertionIndex(clips, at)
  return { track, at: clips[index]?.start ?? (clips.length ? clips.at(-1).start + clips.at(-1).dur : 0) }
}

// Input ops describe the ordinary edit. A move/duplicate supplies the insertion time in the
// original timeline so moving a shot right cannot change which neighbours the pointer chose.
export function magneticOps(p, ops, { at, linked = true, applyOps, project = p }) {
  const primary = primaryTrack(p)
  if (!primary) return ops
  const scoped = ops.map(op => ({ ...op, comp: p.compId ?? null }))
  const projected = applyOps(project, scoped).project
  const next = p.compId ? projected.comps[p.compId] : projected
  const after = next.tracks.find(t => t.id === primary.id)
  const beforeByID = new Map(primary.clips.map(c => [c.id, c]))
  const afterByID = new Map(after.clips.map(c => [c.id, c]))
  const movingIDs = new Set(ops.filter(op => op.op === 'move').map(op => op.id))
  const moved = after.clips.filter(c => !beforeByID.has(c.id) || movingIDs.has(c.id))
  const movedIDs = new Set(moved.map(c => c.id))
  const remaining = primary.clips.filter(c => afterByID.has(c.id) && !movedIDs.has(c.id)).sort((a, b) => a.start - b.start)
  const index = at == null ? remaining.length : insertionIndex(remaining, at)
  const ordered = [...remaining.slice(0, index), ...moved, ...remaining.slice(index)].map(c => afterByID.get(c.id))
  const before = new Map(p.tracks.flatMap(t => t.clips.map(c => [c.id, c])))
  let cursor = 0
  const corrections = []
  const partners = new Map()
  if (linked) for (const track of next.tracks) {
    if (track.locked || track.id === primary.id) continue
    for (const c of track.clips) if (c.link) {
      if (!partners.has(c.link)) partners.set(c.link, [])
      partners.get(c.link).push(c)
    }
  }
  const relocate = (c, start) => {
    const rounded = Math.round(Math.max(0, start) * p.fps) / p.fps
    if (Math.abs(c.start - rounded) > 0.0001) corrections.push({ op: 'move', id: c.id, start: rounded, unlinked: true })
  }
  for (const c of ordered) {
    relocate(c, cursor)
    for (const partner of partners.get(c.link) ?? []) {
      // Ripple trim can already have shifted a downstream partner on one track.
      // Use its original sync offset, including intentional J and L cuts.
      const original = before.get(c.id), originalPartner = before.get(partner.id)
      const offset = original && originalPartner ? originalPartner.start - original.start : partner.start - c.start
      relocate(partner, cursor + offset)
    }
    cursor += c.dur
  }
  return [...scoped, ...corrections.map(op => ({ ...op, comp: p.compId ?? null }))]
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOps, compView, hasAudio, newProject, valueAt } from '../core/project.js'
const sources = { 'media/source.mp4': { duration: 30, hasVideo: true, hasAudio: true, width: 1920, height: 1080 } }
const seed = () => applyOps(newProject('Clipboard'), [{ op: 'import', assets: sources }, { op: 'add_clip', src: 'media/source.mp4', start: 1, dur: 3, track: 'V1', audioTrack: 'A1', set: { label: 'Source', speed: 2, crop: { left: .1 }, anim: { opacity: [{ t: 0, v: .2 }, { t: 3, v: 1 }] }, grade: { exposure: .2 }, masks: [{ id: 'mk1', type: 'rect', x: 1 }], nodes: { list: [{ id: 'n1', type: 'source' }], links: [] } } }]).project
const items = (p, ids) => { const clips = p.tracks.flatMap(t => t.clips.filter(c => !ids || ids.includes(c.id)).map(c => ({ track: t.id, clip: structuredClone(c), offset: c.start - 1 }))); return clips }
const clips = p => p.tracks.flatMap(t => t.clips)
const paste = (p, values, extra = {}) => applyOps(p, [{ op: 'paste', at: 10, clips: values, ...extra }])

test('ordinary browser paste preserves a selected linked pair with fresh IDs, metadata and independent link', () => {
  const p = seed(), before = structuredClone(p), r = paste(p, items(p)), made = clips(r.project).filter(c => r.created.includes(c.id))
  assert.deepEqual(p, before); assert.equal(made.length, 2)
  assert.ok(made[0].link && made[0].link === made[1].link); assert.notEqual(made[0].link, clips(p)[0].link)
  for (let i = 0; i < 2; i++) { const { id, start, link, ...payload } = made[i], { id: old, start: oldStart, link: oldLink, ...original } = clips(p)[i]; assert.deepEqual(payload, original); assert.equal(start, 10) }
  const video = made.find(c => c.kind === 'video'); assert.equal(hasAudio(r.project, video), false); assert.equal(hasAudio(r.project, made.find(c => c.kind === 'audio')), true)
})
test('each repeat paste gets a disjoint link identity and moving the pasted video moves only its audio partner', () => {
  const p = seed(), one = paste(p, items(p)), two = paste(one.project, items(p), { at: 20 })
  const pair1 = clips(two.project).filter(c => one.created.includes(c.id)), pair2 = clips(two.project).filter(c => two.created.includes(c.id))
  assert.ok(pair2[0].link); assert.notEqual(pair1[0].link, pair2[0].link)
  const video = pair2.find(c => c.kind === 'video'), moved = applyOps(two.project, [{ op: 'move', id: video.id, start: 22 }]).project
  assert.equal(clips(moved).find(c => c.id === pair2.find(c => c.kind === 'audio').id).start, 22)
  assert.equal(clips(moved).find(c => c.id === pair1[0].id).start, 10)
  assert.equal(clips(moved).find(c => c.id === clips(p)[0].id).start, 1)
})
test('strict clipboard paste in a nested composition respects fps, preserves main timeline and linked audio', () => {
  const p = seed(), made = applyOps(p, [{ op: 'add_comp', name: 'Nested', fps: 24 }]); const nested = made.created[0]
  const r = paste(made.project, items(p), { clipboard: true, comp: nested, at: 10.01 }), view = compView(r.project, nested)
  assert.deepEqual(r.project.tracks, made.project.tracks); assert.equal(clips(view).length, 2)
  assert.equal(clips(view)[0].start, 10); assert.ok(clips(view)[0].link); assert.equal(clips(view)[0].link, clips(view)[1].link)
  assert.equal(r.project.comps[nested].fps, 24)
})
test('strict Cut then Paste keeps both editable partners and makes one atomic core transaction', () => {
  const p = seed(), values = items(p), cut = applyOps(p, [{ op: 'delete', ids: values.map(i => i.clip.id), unlinked: true, comp: null }])
  assert.equal(clips(cut.project).length, 0)
  const beforePaste = structuredClone(cut.project), r = paste(cut.project, values, { clipboard: true, comp: null })
  assert.deepEqual(cut.project, beforePaste); assert.equal(r.created.length, 2); assert.equal(r.log.length, 1)
  assert.ok(clips(r.project)[0].link); assert.equal(clips(r.project)[0].link, clips(r.project)[1].link)
})
test('ordinary browser missing track fallback skips locked tracks', () => {
  const p = seed(); p.tracks.find(t => t.id === 'V1').locked = true
  const value = { ...items(p)[0], track: 'removed' }, r = paste(p, [value])
  assert.equal(r.project.tracks.find(t => t.id === 'V1').clips.length, 1)
  assert.equal(r.project.tracks.find(t => t.id === 'V2').clips.length, 1)
})
test('ordinary browser paste refuses when all fallback tracks are locked and source stays unchanged', () => {
  const p = seed(); for (const track of p.tracks) if (track.kind === 'video') track.locked = true
  const before = JSON.stringify(p); assert.throws(() => paste(p, [{ ...items(p)[0], track: 'removed' }]), /unlocked destination/); assert.equal(JSON.stringify(p), before)
})
test('strict locked or missing exact destination refuses instead of moving the clips onto another track', () => {
  const p = seed(); p.tracks.find(t => t.id === 'V1').locked = true
  assert.throws(() => paste(p, items(p), { clipboard: true }), /unlocked destination/)
  assert.throws(() => paste(seed(), [{ ...items(seed())[0], track: 'removed' }], { clipboard: true }), /unlocked destination/)
})
test('ordinary browser paste does not place video on an audio track with the same raw track ID', () => {
  const p = seed(), r = paste(p, [{ ...items(p)[0], track: 'A1' }]); assert.equal(r.project.tracks.find(t => t.id === 'A1').clips.length, 1); assert.equal(r.project.tracks.find(t => t.id === 'V1').clips.length, 2)
})
test('caption clip paste targets a caption track and retains editable words', () => {
  const p = seed(); p.tracks.push({ id: 'C1', kind: 'caption', clips: [] })
  const raw = { track: 'oldCaptions', offset: 0, clip: { id: 'captionOld', kind: 'caption', start: 1, dur: 2, words: [{ t: 0, end: 1, text: 'Editable' }], caption: { style: 'boxed' } } }
  const r = paste(p, [raw]); assert.equal(r.project.tracks.find(t => t.id === 'C1').clips[0].words[0].text, 'Editable'); assert.equal(r.project.tracks.find(t => t.id === 'V1').clips.length, 1)
  assert.throws(() => paste(seed(), [raw]), /unlocked destination/)
})
for (const [label, change] of [
  ['negative offset', x => { x.offset = -1 }], ['nonfinite offset', x => { x.offset = NaN }], ['nonfinite metadata', x => { x.clip.x = Infinity }], ['negative duration', x => { x.clip.dur = -2 }], ['null clip', x => { x.clip = null }], ['unsupported kind', x => { x.clip.kind = 'not-a-clip' }], ['unsafe key', x => { x.clip = JSON.parse('{"id":"c1","kind":"video","dur":3,"__proto__":{"x":1}}') }],
]) test(`malformed paste refuses ${label} before publishing any clip`, () => {
  const p = seed(), values = items(p), before = JSON.stringify(p); change(values[1]); assert.throws(() => paste(p, values)); assert.equal(JSON.stringify(p), before)
})
test('strict paste refuses unknown foreign media and missing referenced compositions', () => {
  const p = seed(), value = items(p)[0]; value.clip.src = '../foreign/source.mp4'
  assert.throws(() => paste(p, [value], { clipboard: true }), /media source was removed/)
  assert.throws(() => paste(p, [{ track: 'V1', offset: 0, clip: { id: 'old', kind: 'comp', comp: 'removed', dur: 2 } }], { clipboard: true }), /composition was removed/)
})
test('strict nested paste refuses self and ancestor composition cycles', () => {
  const p = applyOps(seed(), [{ op: 'add_comp', name: 'A' }, { op: 'add_comp', name: 'B' }]).project
  p.comps.k1.tracks[0].clips.push({ id: 'oldNested', kind: 'comp', comp: 'k2', start: 0, dur: 2 })
  for (const comp of ['k1', 'k2']) assert.throws(() => paste(p, [{ track: 'V1', offset: 0, clip: { id: 'old', kind: 'comp', comp, dur: 2 } }], { clipboard: true, comp: 'k2' }), /cycle/)
})
test('strict paste after cut remaps copied parent, matte, source and conditional expression references', () => {
  const p = seed(), pair = items(p), base = pair[0].clip
  base.parent = pair[1].clip.id; base.matte = { mode: 'alpha', source: pair[1].clip.id }; base.source = { clip: pair[1].clip.id }
  base.expr = { x: `layer(time > 0 ? "${pair[1].clip.id}" : '${pair[1].clip.id}').x + 2e1` }
  pair[1].clip.x = 100
  const cut = applyOps(p, [{ op: 'delete', ids: pair.map(i => i.clip.id), unlinked: true }]).project
  const r = paste(cut, pair, { clipboard: true }), [v, a] = clips(r.project)
  assert.equal(v.parent, a.id); assert.equal(v.matte.source, a.id); assert.equal(v.source.clip, a.id)
  assert.ok(v.expr.x.includes(`"${a.id}"`)); assert.equal(valueAt(r.project, v, 'x', 1), 120)
})
test('strict paste refuses external layer dependencies absent from its destination scope', () => {
  const p = seed(), pair = items(p); pair[0].clip.parent = 'removed'
  assert.throws(() => paste(p, pair, { clipboard: true }), /dependency.*missing/)
})
test('strict paste retains a long valid expression source without exceeding parser limits', () => {
  const p = seed(), pair = items(p); pair[0].clip.expr = { x: Array(400).fill('1').join('+') + `+layer("${pair[1].clip.id}").x` }; pair[1].clip.x = 100
  const r = paste(p, pair, { clipboard: true }), v = clips(r.project).find(c => c.id === r.created[0])
  assert.ok(v.expr.x.length < 2000); assert.equal(valueAt(r.project, v, 'x', 1), 500)
})
test('strict paste refuses duplicate raw IDs and empty payload remains an ordinary no-op', () => {
  const p = seed(), pair = items(p); pair[1].clip.id = pair[0].clip.id
  assert.throws(() => paste(p, pair, { clipboard: true }), /IDs must be unique/)
  assert.deepEqual(paste(p, []).created, [])
})
test('strict paste refuses copied parent cycles and does not reinterpret IDs as labels', () => {
  const p = seed(), pair = items(p); pair[0].clip.parent = pair[1].clip.id; pair[1].clip.parent = pair[0].clip.id
  assert.throws(() => paste(p, pair, { clipboard: true }), /cycle/)
  delete pair[1].clip.parent; pair[0].clip.parent = 'Only a label'; pair[1].clip.label = 'Only a label'
  assert.throws(() => paste(p, pair, { clipboard: true }), /dependency.*missing/)
})
test('strict paste preserves a retained external expression name verbatim when it contains a backslash', () => {
  const p = seed(), pair = items(p), external = { id: 'external', kind: 'null', label: 'Folder\\Logo', start: 0, dur: 30, x: 150 }
  p.tracks[2].clips.push(external); pair[0].clip.expr = { x: 'layer("Folder\\Logo").x + 20' }
  const r = paste(p, pair, { clipboard: true }), v = clips(r.project).find(c => c.id === r.created[0])
  assert.equal(v.expr.x, pair[0].clip.expr.x); assert.equal(valueAt(r.project, v, 'x', 1), 170)
})
for (const cut of [false, true]) test(`strict paste recognizes copied title text and keeps its expression target, cut=${cut}`, () => {
  const p = newProject('Title alias'); p.tracks[0].clips = [{ id: 'oldTitle', kind: 'title', title: { text: 'Editable heading' }, start: 1, dur: 3, x: 200 }, { id: 'oldFollower', kind: 'shape', shape: { type: 'rect', width: 10, height: 10 }, start: 1, dur: 3, expr: { x: 'layer("Editable heading").x + 20' } }]
  assert.equal(valueAt(p, clips(p)[1], 'x', 1), 220)
  const values = items(p), source = cut ? applyOps(p, [{ op: 'delete', ids: values.map(i => i.clip.id), unlinked: true }]).project : p
  const r = paste(source, values, { clipboard: true }), follower = clips(r.project).find(c => c.id === r.created[1])
  assert.equal(valueAt(r.project, follower, 'x', 1), 220); assert.ok(follower.expr.x.includes(`"${r.created[0]}"`)); assert.equal(clips(r.project).find(c => c.id === r.created[0]).title.text, 'Editable heading')
})
test('strict paste keeps a unique retained external title-text expression reference', () => {
  const p = newProject('External title'); p.tracks[0].clips = [{ id: 'oldTitle', kind: 'title', title: { text: 'Editable heading' }, start: 0, dur: 30, x: 200 }, { id: 'oldFollower', kind: 'shape', shape: { type: 'rect', width: 10, height: 10 }, start: 1, dur: 3, expr: { x: 'layer("Editable heading").x + 20' } }]
  const r = paste(p, items(p, ['oldFollower']), { clipboard: true }), follower = clips(r.project).find(c => c.id === r.created[0])
  assert.equal(follower.expr.x, 'layer("Editable heading").x + 20'); assert.equal(valueAt(r.project, follower, 'x', 1), 220)
})
test('strict paste refuses ID/label/title-text aliases that bind more than one layer instead of rebinding', () => {
  for (const alias of ['label', 'title']) {
    const p = newProject('Ambiguous alias'); p.tracks[0].clips = [{ id: 'other', kind: 'title', ...(alias === 'label' ? { label: 'rawID' } : { title: { text: 'rawID' } }), start: 1, dur: 3, x: 200 }, { id: 'rawID', kind: 'null', start: 1, dur: 3, x: 100 }, { id: 'follow', kind: 'shape', shape: { type: 'rect', width: 10, height: 10 }, start: 1, dur: 3, expr: { x: 'layer("rawID").x' } }]
    assert.equal(valueAt(p, clips(p)[2], 'x', 1), 200)
    assert.throws(() => paste(p, items(p), { clipboard: true }), /dependency.*ambiguous/)
  }
})

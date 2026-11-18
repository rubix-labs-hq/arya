import assert from 'node:assert/strict'
import test from 'node:test'
import { applyOps, newProject } from '../core/project.js'
import { editNotes, estimateTextUnits } from '../core/edit-notes.js'
import { BUNDLED_FONTS, SYSTEM_FONTS, knownFont } from '../core/fonts.js'

const vertical = () => newProject('Vertical', { width: 1080, height: 1920 })
const wide = () => newProject('Wide', { width: 1920, height: 1080 })
const run = (before, ops) => { const result = applyOps(before, ops); return { ...result, notes: editNotes(before, result.project, { ops, created: result.created }) } }
const withMedia = (project, assets) => applyOps(project, [{ op: 'import', assets }]).project

test('a default title wider than a vertical frame gets one width note that names the frame width', () => {
  const { notes, project } = run(vertical(), [{ op: 'add_title', text: 'HARVEST FAIR OPENS SATURDAY', start: 0, dur: 3 }])
  const width = notes.filter(note => /frame is 607 units wide/.test(note))
  assert.equal(width.length, 1, notes.join('\n'))
  const estimate = Math.round(estimateTextUnits('HARVEST FAIR OPENS SATURDAY', 120))
  assert.ok(estimate > 607 * 2, 'the estimate is far past the frame')
  assert.match(width[0], new RegExp(`^c1 title is about ${estimate} units wide \\(an estimate from its 27 characters at size 120\\)`))
  assert.match(width[0], /It does not wrap/)
  // The size it suggests fits 90% of the frame by the same estimate, and the box is the shape the renderer needs.
  const suggested = Number(/Lower title\.size to about (\d+)/.exec(width[0])[1])
  assert.ok(estimateTextUnits('HARVEST FAIR OPENS SATURDAY', suggested) <= 607 * 0.9 + 1 && suggested > 20)
  assert.match(width[0], /title\.box \{width:546, height:120, wrap:true, autoHeight:true\}/)
  assert.equal(project.tracks.flatMap(track => track.clips)[0].title.size, 120, 'nothing is rescaled')
})

test('a title that fits, a wrapped title and a title broken into short lines get no width note', () => {
  const fits = run(wide(), [{ op: 'add_title', text: 'HARVEST FAIR OPENS SATURDAY', title: { size: 40 } }])
  assert.equal(fits.notes.some(note => /units wide/.test(note)), false, fits.notes.join('\n'))
  const boxed = run(vertical(), [{ op: 'add_title', text: 'HARVEST FAIR OPENS SATURDAY', title: { box: { width: 540, height: 120, wrap: true, autoHeight: true } } }])
  assert.equal(boxed.notes.some(note => /units wide/.test(note)), false, boxed.notes.join('\n'))
  const broken = run(vertical(), [{ op: 'add_title', text: 'HAY\nRIDE', title: { size: 110 } }])
  assert.equal(broken.notes.some(note => /units wide/.test(note)), false, broken.notes.join('\n'))
})

test('a wrapping box wider than the frame gets a note in every frame shape, and one that fits gets none', () => {
  const long = 'HARVEST FAIR OPENS SATURDAY AT THE OLD MILL BY THE RIVER'
  for (const [make, frame] of [[wide, 1920], [vertical, 607], [() => newProject('Square', { width: 1080, height: 1080 }), 1080]]) {
    const { notes } = run(make(), [{ op: 'add_title', text: long, title: { size: 120, box: { width: 4000, height: 120, wrap: true, autoHeight: true } } }])
    const box = notes.filter(note => /title\.box is/.test(note))
    assert.equal(box.length, 1, notes.join('\n'))
    assert.equal(box[0], `c1 title.box is 4000 units wide; the frame is ${frame} units wide. Lines wrap at the box, so they can run past the frame. Set title.box.width to at most ${Math.floor(frame * 0.9)}.`)
    assert.equal(notes.some(note => /title is about/.test(note)), false, 'a wrapping title gets the box note, not the line estimate')
  }
  const scaled = run(wide(), [{ op: 'add_title', text: long, title: { box: { width: 1200, height: 120, wrap: true } }, set: { scale: 2 } }])
  assert.match(scaled.notes.join('\n'), /c1 title\.box is 2400 units wide at scale 2; the frame is 1920 units wide\. .* Set title\.box\.width to at most 864\./)
  const fits = run(wide(), [{ op: 'add_title', text: long, title: { box: { width: 1920, height: 120, wrap: true } } }])
  assert.equal(fits.notes.some(note => /units wide/.test(note)), false, fits.notes.join('\n'))
})

test('a title between 90% and 100% of the frame is called close to the edges, not wider than the frame', () => {
  // Find a size whose estimate lands between 90% and 100% of the 607-unit frame.
  const text = 'VALE ORCHARD', size = [...Array(200).keys()].map(n => n + 20).find(n => { const e = estimateTextUnits(text, n); return e > 607 * 0.92 && e < 607 * 0.98 })
  const { notes } = run(vertical(), [{ op: 'add_title', text, title: { size } }])
  const width = notes.filter(note => /units wide/.test(note))
  assert.equal(width.length, 1, notes.join('\n'))
  const estimate = Math.round(estimateTextUnits(text, size))
  assert.ok(estimate < 607)
  assert.match(width[0], new RegExp(`^c1 title is about ${estimate} units wide \\(an estimate from its 12 characters at size ${size}\\); that is wider than 90% of the frame \\(546 of 607 units\\), so it may touch the edges\\. It does not wrap\\. Lower title\\.size to about \\d+,`))
  assert.equal(/; the frame is 607 units wide/.test(width[0]), false, 'it does not say the frame is narrower than the title')
  // Past the frame the wording stays as it was.
  const past = run(vertical(), [{ op: 'add_title', text, title: { size: size * 2 } }])
  assert.match(past.notes.join('\n'), /c1 title is about \d+ units wide \(an estimate from its 12 characters at size \d+\); the frame is 607 units wide\. It does not wrap\./)
})

test('the width estimate follows clip scale, the composition size and a later size change', () => {
  const scaled = run(vertical(), [{ op: 'add_title', text: 'HARVEST FAIR', title: { size: 60 }, set: { scale: 2 } }])
  assert.match(scaled.notes.join('\n'), /c1 title is about \d+ units wide .* at scale 2/)
  const inComp = run(wide(), [{ op: 'add_comp', name: 'Tall', width: 1080, height: 1920, duration: 3 }, { op: 'add_title', comp: 'k1', text: 'HARVEST FAIR OPENS SATURDAY' }])
  assert.match(inComp.notes.join('\n'), /frame is 607 units wide/)
  const small = run(vertical(), [{ op: 'add_title', text: 'FAIR OPENS SATURDAY', title: { size: 30 } }])
  assert.equal(small.notes.some(note => /units wide/.test(note)), false)
  const grown = run(small.project, [{ op: 'update', id: 'c1', set: { title: { size: 130 } } }])
  assert.match(grown.notes.join('\n'), /c1 title is about \d+ units wide/)
  const untouched = run(grown.project, [{ op: 'update', id: 'c1', set: { opacity: 0.5 } }])
  assert.equal(untouched.notes.some(note => /units wide/.test(note)), false, 'an edit that leaves the text and size alone says nothing again')
})

test('new and moved titles report where their centre sits and that no subject position is known', () => {
  const made = run(vertical(), [
    { op: 'add_title', text: 'ONE', title: { size: 60 }, start: 0, dur: 1, set: { y: 940 } },
    { op: 'add_title', text: 'TWO', title: { size: 60 }, start: 1, dur: 1, set: { y: 940 } },
    { op: 'add_title', text: 'LOW', title: { size: 60 }, start: 2, dur: 1, set: { y: 1632 } },
    { op: 'add_title', text: 'MID', title: { size: 60 }, start: 3, dur: 1 },
  ])
  const place = made.notes.find(note => note.startsWith('Title centres'))
  assert.equal(place, 'Title centres, measured from the top of the frame: c1, c2 at 49%; c3 at 85%; c4 at 50%. The editor knows no face or subject position, so only a rendered frame shows what a title covers.')
  const moved = run(made.project, [{ op: 'update', id: 'c3', set: { y: 192 } }])
  assert.match(moved.notes.join('\n'), /Title centres, measured from the top of the frame: c3 at 10%\./)
  assert.equal(run(made.project, [{ op: 'update', id: 'c3', set: { opacity: 0.4 } }]).notes.some(note => note.startsWith('Title centres')), false)
})

test('titles put on one named track at overlapping times name each hidden pair', () => {
  const ops = [0, 1, 2].map(start => ({ op: 'add_title', text: `T${start}`, title: { size: 60 }, track: 'V1', start, dur: 3 }))
  const { notes, project } = run(vertical(), ops)
  assert.equal(project.tracks.find(track => track.id === 'V1').clips.length, 3, 'the op still does what it did')
  const overlap = notes.find(note => note.startsWith('Overlaps on one track'))
  assert.ok(overlap, notes.join('\n'))
  for (const pair of ['c2 is hidden under c1 on V1 from 1s to 3s', 'c3 is hidden under c1 on V1 from 2s to 3s', 'c3 is hidden under c2 on V1 from 2s to 4s']) assert.ok(overlap.includes(pair), `${pair}\n${overlap}`)
  assert.match(overlap, /a track shows one clip at a time/)
})

test('titles without a named track land on separate tracks and report no overlap', () => {
  const ops = [0, 1, 2].map(start => ({ op: 'add_title', text: `T${start}`, title: { size: 60 }, start, dur: 3 }))
  const { notes, project } = run(vertical(), ops)
  assert.equal(new Set(project.tracks.filter(track => track.clips.length).map(track => track.id)).size, 3)
  assert.equal(notes.some(note => note.startsWith('Overlaps')), false, notes.join('\n'))
})

test('a move onto an occupied range reports the overlap, adjacent clips with a transition do not', () => {
  const base = applyOps(vertical(), [
    { op: 'add_title', text: 'A', title: { size: 60 }, track: 'V2', start: 0, dur: 3 },
    { op: 'add_title', text: 'B', title: { size: 60 }, track: 'V2', start: 3, dur: 3 },
  ]).project
  const transition = run(base, [{ op: 'transition', id: 'c2', type: 'crossDissolve', dur: 1 }])
  assert.equal(transition.notes.some(note => note.startsWith('Overlaps')), false, transition.notes.join('\n'))
  const moved = run(base, [{ op: 'move', id: 'c2', start: 1 }])
  assert.match(moved.notes.join('\n'), /c2 is hidden under c1 on V2 from 1s to 3s/)
  const disabled = run(moved.project, [{ op: 'update', id: 'c1', set: { enabled: false } }, { op: 'move', id: 'c2', start: 2 }])
  assert.equal(disabled.notes.some(note => note.startsWith('Overlaps')), false, 'a disabled clip hides nothing')
})

test('a speed change on a clip with sound states the new length and the pitch change', () => {
  const base = applyOps(withMedia(wide(), { 'take.mp4': { assetKind: 'video', hasVideo: true, hasAudio: true, duration: 60 } }), [{ op: 'append', src: 'take.mp4', track: 'V1', in: 0, dur: 20 }])
  const video = base.project.tracks.find(track => track.id === 'V1').clips[0]
  const { notes } = run(base.project, [{ op: 'speed', id: video.id, speed: 1.1 }])
  const note = notes.find(text => text.includes('plays at 1.1x'))
  assert.equal(note, `${video.id} now plays at 1.1x (was 1x): 20s became 18.18s. Its sound plays 1.65 semitones higher than at 1x.`)
  const slow = run(base.project, [{ op: 'speed', id: video.id, speed: 0.5 }])
  assert.match(slow.notes.join('\n'), /Its sound plays 12 semitones lower than at 1x\./)
})

test('a speed change on a silent clip states the length only, and an unchanged speed says nothing', () => {
  const base = applyOps(vertical(), [{ op: 'add_title', text: 'A', title: { size: 60 }, start: 0, dur: 4 }]).project
  const { notes } = run(base, [{ op: 'speed', id: 'c1', speed: 2 }])
  const note = notes.find(text => text.includes('plays at 2x'))
  assert.equal(note, 'c1 now plays at 2x (was 1x): 4s became 2s.')
  assert.equal(run(base, [{ op: 'speed', id: 'c1', speed: 1 }]).notes.some(text => text.includes('plays at')), false)
})

test('a cut that shortens a title says the text stayed, and a caption with word timings says nothing', () => {
  const title = applyOps(wide(), [{ op: 'add_title', text: 'for later.', title: { size: 40 }, track: 'V3', start: 9.9, dur: 1.1 }]).project
  const cut = run(title, [{ op: 'delete_range', from: 10.3333, to: 11 }])
  const note = cut.notes.find(text => text.startsWith('Text that lost time'))
  assert.equal(note, 'Text that lost time in this edit and kept its words: c1 "for later." lost 0.67s (now 0.43s). A cut never rewrites a title, or a caption without word timings, so check each against the sound.')
  const words = [['we', 9, 9.2], ['already', 9.2, 9.6], ['saved', 9.6, 9.9], ['for', 9.9, 10.2], ['later.', 10.2, 11]].map(([text, t, end]) => ({ text, t, end }))
  const timed = applyOps(wide(), [{ op: 'captions', items: [{ t: 9, end: 11, text: 'we already saved for later.', words }] }]).project
  const timedCut = run(timed, [{ op: 'delete_range', from: 10.2, to: 11 }])
  assert.equal(timedCut.project.tracks.find(track => track.kind === 'caption').clips[0].text, 'we already saved for')
  assert.equal(timedCut.notes.some(text => text.startsWith('Text that lost time')), false, timedCut.notes.join('\n'))
  const untimed = applyOps(wide(), [{ op: 'captions', items: [{ t: 9, end: 11, text: 'we already saved for later.' }] }]).project
  assert.match(run(untimed, [{ op: 'delete_range', from: 10.2, to: 11 }]).notes.join('\n'), /c1 "we already saved for later\." lost 0\.8s/)
  // A trim the batch asked for by name is the caller's own choice.
  assert.equal(run(title, [{ op: 'trim', id: 'c1', edge: 'right', to: 10.5 }]).notes.some(text => text.startsWith('Text that lost time')), false)
})

test('captions sent without word timings say that cuts will not update them', () => {
  const plain = run(wide(), [{ op: 'captions', items: [{ t: 0, end: 1, text: 'one two' }, { t: 1, end: 2, text: 'three' }] }])
  assert.ok(plain.notes.includes('2 new captions have no word timings, so a cut shortens them without changing their text. Send words:[{t,end,text}] in timeline seconds with each item to keep them in step with cuts.'), plain.notes.join('\n'))
  const timed = run(wide(), [{ op: 'captions', items: [{ t: 0, end: 1, text: 'one two', words: [{ t: 0, end: 0.5, text: 'one' }, { t: 0.5, end: 1, text: 'two' }] }] }])
  assert.equal(timed.notes.some(text => text.includes('word timings')), false)
})

test('caption style keys the renderer does not read are named, with the keys it does read', () => {
  const base = applyOps(wide(), [{ op: 'captions', items: [{ t: 0, end: 1, text: 'one', words: [{ t: 0, end: 1, text: 'one' }] }] }]).project
  const { notes, project } = run(base, [{ op: 'update_track', id: 'C1', set: { burnIn: true, style: { fit: 'shrink', wrap: true, kind: 'boxed', highlight: '#ff0000', size: 104 } } }])
  assert.equal(project.tracks.find(track => track.id === 'C1').style.fit, 'shrink', 'unknown keys are still stored, as before')
  const note = notes.find(text => text.includes('draw nothing'))
  assert.equal(note, 'style.fit, style.wrap, style.kind and style.highlight on C1 are not caption style options and draw nothing. Use highlightColor, not highlight. Options: preset, font, size, weight, color, highlightColor, plate, padding, radius, align, lineHeight, maxLines, y.')
  const known = run(base, [{ op: 'update_track', id: 'C1', set: { style: { size: 60, plate: 'transparent', y: 0.8, preset: 'karaoke', highlightColor: '#00ff00' } } }])
  assert.deepEqual(known.notes, [])
  const audio = run(base, [{ op: 'update_track', id: 'A1', set: { volume: -3 } }])
  assert.deepEqual(audio.notes, [])
})

test('a highlight colour without the karaoke preset says when it shows', () => {
  const base = applyOps(wide(), [{ op: 'captions', items: [{ t: 0, end: 1, text: 'one' }] }]).project
  const { notes } = run(base, [{ op: 'update_track', id: 'C1', set: { style: { highlightColor: '#00ff00' } } }])
  assert.ok(notes.includes('style.highlightColor on C1 shows only with preset karaoke, on captions that have word timings. C1 has no preset.'), notes.join('\n'))
})

test('a font outside the known lists says it may fall back, and known fonts say nothing', () => {
  const unknown = run(wide(), [{ op: 'add_title', text: 'Hi', title: { font: 'Barlow Condensed', size: 40 } }, { op: 'add_title', text: 'Yo', title: { font: 'barlow condensed', size: 40 }, start: 5 }])
  const note = unknown.notes.find(text => text.includes('Barlow Condensed'))
  assert.equal(note, '"Barlow Condensed" (c1, c2) is not a font this editor knows. It draws only if this Mac has that font; otherwise the text falls back to a system sans, which can be wider. Bundled: Inter, Mrs Saint Delafield. GET /api/caps lists the system fonts under fonts.')
  for (const font of ['Inter', 'Avenir Next', 'helvetica neue', 'Mrs Saint Delafield']) {
    const known = run(wide(), [{ op: 'add_title', text: 'Hi', title: { font, size: 40 } }])
    assert.equal(known.notes.some(text => text.includes('not a font')), false, font)
  }
  const base = applyOps(wide(), [{ op: 'captions', items: [{ t: 0, end: 1, text: 'one', words: [{ t: 0, end: 1, text: 'one' }] }] }]).project
  const caption = run(base, [{ op: 'update_track', id: 'C1', set: { style: { font: 'Manrope' } } }])
  assert.match(caption.notes.join('\n'), /^"Manrope" \(C1\) is not a font this editor knows\./m)
})

test('the font lists hold the bundled fonts and the defaults the edit model uses', () => {
  assert.deepEqual(BUNDLED_FONTS, ['Inter', 'Mrs Saint Delafield'])
  for (const font of ['Avenir Next', 'Helvetica Neue']) assert.ok(SYSTEM_FONTS.includes(font), font)
  assert.equal(knownFont('INTER'), true); assert.equal(knownFont(' Futura '), true); assert.equal(knownFont('Barlow'), false); assert.equal(knownFont(undefined), true)
})

test('notes are bounded, and a broken project yields no notes instead of an error', () => {
  const ops = Array.from({ length: 40 }, (_, index) => ({ op: 'add_title', text: `A VERY LONG TITLE THAT RUNS OFF THE FRAME ${index}`, track: 'V1', start: index * 0.5, dur: 3 }))
  const { notes } = run(vertical(), ops)
  assert.ok(notes.length <= 10, String(notes.length))
  assert.ok(notes.every(note => note.length <= 700), String(Math.max(...notes.map(note => note.length))))
  assert.match(notes.join('\n'), /and \d+ more/)
  assert.deepEqual(editNotes(null, undefined, { ops: [{ op: 'speed', id: 'c1', speed: 2 }], created: ['c1'] }), [])
  assert.deepEqual(editNotes(vertical(), vertical()), [])
})

test('the overlap scan stays quick on a long track and caps what it lists', () => {
  const before = newProject('Long')
  before.tracks.find(track => track.id === 'V2').clips = Array.from({ length: 4000 }, (_, index) => ({ id: `t${index}`, kind: 'title', start: index * 2, dur: 1.5, title: { text: 'x' } }))
  const after = structuredClone(before)
  // Every clip moves, as after a ripple, and none overlaps.
  for (const clip of after.tracks.find(track => track.id === 'V2').clips) clip.start += 1
  const started = performance.now()
  assert.deepEqual(editNotes(before, after, { ops: [{ op: 'ripple_delete', id: 'x' }] }).filter(note => note.startsWith('Overlaps')), [])
  assert.ok(performance.now() - started < 1500, 'a 4000-clip track is scanned in well under two seconds')
  // Every clip overlaps every other: the note stops collecting and says there are more.
  for (const clip of after.tracks.find(track => track.id === 'V2').clips) { clip.start = 0; clip.dur = 5 }
  const crowded = editNotes(before, after, { ops: [] }).find(note => note.startsWith('Overlaps'))
  assert.match(crowded, /t1 is hidden under t0 on V2 from 0s to 5s/)
  assert.match(crowded, /; and more\. Move the hidden clip/)
  assert.ok(crowded.length <= 700)
})

test('the person form of every note names clips as the timeline does, with no ids, property paths or code', () => {
  const person = (before, ops) => { const result = applyOps(before, ops); return { agent: editNotes(before, result.project, { ops, created: result.created }), person: editNotes(before, result.project, { ops, created: result.created, audience: 'person' }) } }
  const media = applyOps(withMedia(wide(), { 'media/take.mp4': { assetKind: 'video', hasVideo: true, hasAudio: true, duration: 60 } }), [{ op: 'append', src: 'media/take.mp4', track: 'V1', in: 0, dur: 6 }]).project
  const take = media.tracks.find(track => track.id === 'V1').clips[0].id
  const timed = applyOps(wide(), [{ op: 'captions', items: [{ t: 0, end: 1, text: 'one', words: [{ t: 0, end: 1, text: 'one' }] }] }]).project
  const shortTitle = applyOps(wide(), [{ op: 'add_title', text: 'for later.', title: { size: 40 }, track: 'V3', start: 9.9, dur: 1.1 }]).project
  const runs = [
    person(vertical(), [{ op: 'add_title', text: 'HARVEST FAIR OPENS SATURDAY', start: 0, dur: 3, title: { font: 'Barlow Condensed' } }]),
    person(vertical(), [{ op: 'add_title', text: 'HARVEST FAIR OPENS SATURDAY AT THE MILL', title: { size: 120, box: { width: 4000, height: 120, wrap: true, autoHeight: true } } }]),
    person(vertical(), [0, 1].map(start => ({ op: 'add_title', text: `Lantern ${start}`, title: { size: 40 }, track: 'V1', start, dur: 3 }))),
    person(media, [{ op: 'speed', id: take, speed: 2 }]),
    person(shortTitle, [{ op: 'delete_range', from: 10.3333, to: 11 }]),
    person(wide(), [{ op: 'captions', items: [{ t: 0, end: 1, text: 'one two' }] }]),
    person(timed, [{ op: 'update_track', id: 'C1', set: { style: { fit: 'shrink', highlightColor: '#00ff00' } } }]),
  ]
  const all = runs.flatMap(run => run.person)
  const expected = [
    /^The title "HARVEST FAIR OPENS SATURDAY" is wider than the frame\. Make it smaller or let it wrap\.$/,
    /^The title "HARVEST FAIR OPENS SATURDAY AT THE MILL" wraps in a box wider than the frame, so its lines can run past the edges\.$/,
    /^A track shows one clip at a time, so overlapping clips hide each other: "Lantern 1" is hidden under "Lantern 0" from 1s to 3s\. Move one to another track to show both\.$/,
    /^"take\.mp4" now plays at 2x, so it is 3s long instead of 6s\. Its sound is higher\.$/,
    /^Some text got shorter but kept its words: "for later\." is now 0\.43s\. Check that it still matches the sound\.$/,
    /^1 new caption has no word timings, so a later cut shortens it without changing the text\.$/,
    /^One caption style setting in this edit has no effect\.$/,
    /^The caption highlight color shows only with the Karaoke style, on captions that have word timings\.$/,
    /^"Barlow Condensed" is not a built-in font\. It shows only if this computer has it; otherwise the text uses a system font, which can be wider\.$/,
  ]
  for (const pattern of expected) assert.ok(all.some(note => pattern.test(note)), `${pattern}\n${all.join('\n')}`)
  for (const note of all) assert.doesNotMatch(note, /\b[cCVA]\d+\b|title\.|style\.|[{}]|\n|\\n|\/api|semitones|units/, note)
  // Title positions help only the agent, so the person gets no sentence for them.
  assert.ok(runs[0].agent.some(note => note.startsWith('Title centres')))
  assert.equal(all.some(note => /centre/i.test(note)), false)
  // The agent's notes are unchanged by the person form.
  assert.ok(runs[3].agent.includes(`${take} now plays at 2x (was 1x): 6s became 3s. Its sound plays 12 semitones higher than at 1x.`), runs[3].agent.join('\n'))
})

test('the person overlap note lists three pairs and a count, so its advice is never cut', () => {
  const names = ['Morning ferry crossing at the north pier', 'Lighthouse keeper repaints the red stripe', 'Gulls circle the fishing boats at dawn now', 'Harbour market opens its striped awnings', 'Kite festival gathers on the long sand bar', 'Evening tide carries the rowing club home', 'Lamplighter walks the sea wall at seven pm', 'Last bus waits by the shuttered ice kiosk']
  const ops = names.map((label, index) => ({ op: 'add_title', text: label, title: { size: 40 }, track: 'V1', start: index * 0.5, dur: 5 }))
  const result = applyOps(wide(), ops)
  const notes = audience => editNotes(wide(), result.project, { ops, created: result.created, audience }).filter(note => /hidden under/.test(note))
  const [person] = notes('person'), [agent] = notes('agent')
  assert.ok(person.endsWith('Move one to another track to show both.'), person)
  assert.ok(person.length < 700, String(person.length))
  assert.equal(person.match(/is hidden under/g).length, 3, person)
  assert.match(person, /; and 25 more\. Move one/)
  // The agent form keeps its six pairs and its own count.
  assert.equal(agent.match(/is hidden under/g).length, 6, agent)
  assert.match(agent, /; and 22 more\. Move the hidden clip/)
})

test('the person overlap note on a crowded track says there are more and keeps its advice', () => {
  const before = newProject('Crowded')
  before.tracks.find(track => track.id === 'V2').clips = Array.from({ length: 40 }, (_, index) => ({ id: `t${index}`, kind: 'title', start: 0, dur: 5, title: { text: `Paper lantern number ${index} drifts past the old stone bridge` } }))
  const [person] = editNotes(before, structuredClone(before), { ops: [], audience: 'person' }).filter(note => /hidden under/.test(note))
  assert.equal(person, undefined, 'nothing moved, so no note')
  const after = structuredClone(before)
  for (const clip of after.tracks.find(track => track.id === 'V2').clips) clip.start = 0.25
  const [crowded] = editNotes(before, after, { ops: [], audience: 'person' }).filter(note => /hidden under/.test(note))
  assert.equal(crowded.match(/is hidden under/g).length, 3, crowded)
  assert.match(crowded, /; and more\. Move one to another track to show both\.$/)
})

test('a clip name that cannot be read costs only that name, and the agent keeps every note', () => {
  const before = wide()
  const ops = [0, 1].map(start => ({ op: 'add_title', text: `Pier ${start}`, title: { size: 40 }, track: 'V1', start, dur: 3 }))
  const after = applyOps(before, ops).project
  const clip = after.tracks.find(track => track.id === 'V1').clips[1]
  Object.defineProperty(clip, 'label', { get() { throw new Error('unreadable label') }, enumerable: false })
  const agent = editNotes(before, after, { ops, created: ['c1', 'c2'] })
  assert.ok(agent.some(note => /c2 is hidden under c1 on V1/.test(note)), agent.join('\n'))
  const person = editNotes(before, after, { ops, created: ['c1', 'c2'], audience: 'person' })
  assert.ok(person.some(note => /^A track shows one clip at a time, so overlapping clips hide each other: "a clip" is hidden under "Pier 0"/.test(note)), person.join('\n'))
})

test('an overlap of half a frame or less says nothing, and a one-frame overlap is named', () => {
  const titles = second => run(wide(), [{ op: 'add_title', text: 'Pier one', title: { size: 40 }, track: 'V1', start: 0, dur: 2.1334 }, { op: 'add_title', text: 'Pier two', title: { size: 40 }, track: 'V1', start: second, dur: 2 }])
  // Rounded times leave 0.0001 s, which drew as "from 2.13s to 2.13s".
  assert.equal(titles(2.1333).notes.some(note => /hidden under/.test(note)), false, titles(2.1333).notes.join('\n'))
  assert.match(titles(2.1).notes.join('\n'), /c2 is hidden under c1 on V1 from 2\.1s to 2\.13s/)
})

test('captions that overlap on their track get a caption note that does not claim one hides the other', () => {
  const ops = [{ op: 'captions', items: [{ t: 0, end: 1.0333, text: 'first line' }, { t: 1, end: 2, text: 'second line' }] }]
  const { notes, project } = run(wide(), ops)
  const [first, second] = project.tracks.find(track => track.kind === 'caption').clips
  const overlap = notes.find(note => note.startsWith('Caption overlaps'))
  assert.ok(overlap, notes.join('\n'))
  assert.ok(overlap.includes(`${second.id} overlaps ${first.id} on C1 from 1s to 1.03s`), overlap)
  // The native renderer draws every covering caption (render-plan.js filters, it does not find one).
  assert.match(overlap, /one caption hides the other or both draw on top of each other/)
  assert.equal(/hidden under|one caption at a time/.test(overlap), false, overlap)
  assert.match(overlap, /Trim the earlier caption to end where the next one starts\./)
  assert.equal(notes.some(note => note.startsWith('Overlaps on one track')), false, 'captions do not get the move-to-another-track advice')
  const person = editNotes(wide(), project, { ops, created: [first.id, second.id], audience: 'person' })
  assert.ok(person.includes('Overlapping captions hide each other or show on top of each other: "second line" overlaps "first line" from 1s to 1.03s. Shorten the earlier one.'), person.join('\n'))
  const apart = run(wide(), [{ op: 'captions', items: [{ t: 0, end: 1, text: 'first line' }, { t: 1, end: 2, text: 'second line' }] }])
  assert.equal(apart.notes.some(note => /hidden under|Caption overlaps/.test(note)), false, apart.notes.join('\n'))
})

test('text left for two frames or less is called a flash, and a title shorter than its reading time is called brief', () => {
  const { notes } = run(wide(), [{ op: 'add_title', text: 'Gate opens', title: { size: 40 }, track: 'V2', start: 3, dur: 0.0333 }])
  assert.ok(notes.includes('Text that lasts 2 frames or less, which reads as a flash: c1 "Gate opens" at 3s lasts 0.03s. A cut usually leaves these behind from text that crossed it. Delete them, or lengthen them if they belong.'), notes.join('\n'))
  assert.equal(notes.some(note => note.startsWith('Titles shorter')), false, 'a flash gets one note')
  const brief = run(wide(), [{ op: 'add_title', text: 'Open late tonight', title: { size: 40 }, start: 1, dur: 0.5 }])
  assert.ok(brief.notes.includes('Titles shorter than their reading time (about 0.6s plus 0.1s per word): c1 "Open late tonight" is on screen 0.5s and needs about 0.9s. Lengthen them or use fewer words.'), brief.notes.join('\n'))
  const person = editNotes(wide(), brief.project, { ops: [], created: ['c1'], audience: 'person' })
  assert.ok(person.includes('Some titles are too brief to read: "Open late tonight" shows for 0.5s. Show them longer or shorten the text.'), person.join('\n'))
  // A ripple cut earlier on the timeline moves a brief title without changing its time on screen.
  const later = run(wide(), [{ op: 'add_title', text: 'Open late tonight', title: { size: 40 }, track: 'V2', start: 10, dur: 0.5 }, { op: 'add_color', color: '#203040', track: 'V1', start: 0, dur: 12 }]).project
  const rippled = run(later, [{ op: 'delete_range', from: 2, to: 3, ripple: true }])
  assert.equal(rippled.project.tracks.find(track => track.id === 'V2').clips[0].start, 9, 'the cut moved the title')
  assert.equal(rippled.notes.some(note => /reading time/.test(note)), false, rippled.notes.join('\n'))
  const readable = run(wide(), [{ op: 'add_title', text: 'Open late tonight', title: { size: 40 }, start: 1, dur: 1 }])
  assert.equal(readable.notes.some(note => /reading time|flash/.test(note)), false, readable.notes.join('\n'))
  // A title the batch did not touch is not reported again.
  assert.equal(editNotes(brief.project, structuredClone(brief.project), { ops: [] }).some(note => /reading time/.test(note)), false)
})

test('video zoomed more than 10% past the scale that fills a frame of another shape gets a note', () => {
  const placed = (frame, set = {}) => {
    const media = applyOps(withMedia(frame, { 'media/wide.mp4': { assetKind: 'video', hasVideo: true, hasAudio: false, duration: 60, width: 1920, height: 1080 } }), [{ op: 'append', src: 'media/wide.mp4', track: 'V1', in: 0, dur: 6 }]).project
    const id = media.tracks.find(track => track.id === 'V1').clips[0].id
    return { media, id, ...run(media, [{ op: 'update', id, set }]) }
  }
  // 1920x1080 media fills a 1080x1920 frame at (1920/1080) / (1080/1920) = 3.16.
  assert.equal(placed(vertical(), { scale: 3.47 }).notes.some(note => /fill scale/.test(note)), false, '9.8% past says nothing')
  const tight = placed(vertical(), { scale: 3.49 })
  assert.ok(tight.notes.includes(`Zoomed past the fill scale: ${tight.id} reaches scale 3.49, 10% past 3.16, the scale at which its 1920x1080 media fills the 1080x1920 frame. The extra zoom crops the subject's margin. Render frames at least every 2 seconds and at fast moves and check the subject's distance from each edge, or lower scale toward the fill scale.`), tight.notes.join('\n'))
  const person = editNotes(tight.media, tight.project, { ops: [], audience: 'person' })
  assert.ok(person.includes('"wide.mp4" is zoomed 10% past the size that fills the frame, so more of the picture is cropped. Check that the subject stays in frame.'), person.join('\n'))
  // A keyframed zoom counts by its largest key.
  const { media, id } = placed(vertical(), { scale: 3.2 })
  const keyed = run(media, [{ op: 'keyframe', id, prop: 'scale', at: 0, value: 3.2 }, { op: 'keyframe', id, prop: 'scale', at: 2, value: 3.8 }])
  assert.match(keyed.notes.join('\n'), new RegExp(`${id} reaches scale 3\\.8, 20% past 3\\.16`))
  // Blading a zoomed clip makes a new piece at the same zoom, which was already noted.
  const bladed = run(tight.project, [{ op: 'blade', at: 3 }])
  assert.equal(bladed.project.tracks.find(track => track.id === 'V1').clips.length, 2, 'the blade made a second piece')
  assert.equal(bladed.notes.some(note => /fill scale/.test(note)), false, bladed.notes.join('\n'))
  // Trimming the left edge of a keyed zoom moves its keys but zooms no further, so the note does not come back.
  const trimmed = run(keyed.project, [{ op: 'trim', id, edge: 'left', to: 1 }])
  assert.equal(trimmed.project.tracks.find(track => track.id === 'V1').clips[0].anim.scale[0][0], -1, 'the trim moved the keys')
  assert.equal(trimmed.notes.some(note => /fill scale/.test(note)), false, trimmed.notes.join('\n'))
  // A key before the clip's start counts only by the zoom it gives on screen: 5 at -4s eases to 3.8 at 0s.
  const early = run(media, [{ op: 'update', id, set: { scale: 3.2, anim: { scale: [[-4, 5], [2, 3.2]] } } }])
  assert.match(early.notes.join('\n'), new RegExp(`${id} reaches scale 3\\.8, 20% past 3\\.16`))
  // A base scale that keys override does not count.
  assert.equal(run(media, [{ op: 'update', id, set: { scale: 4, anim: { scale: [[0, 3.2], [6, 3.3]] } } }]).notes.some(note => /fill scale/.test(note)), false)
  // A zoom that grows on screen is noted again.
  const grown = run(keyed.project, [{ op: 'keyframe', id, prop: 'scale', at: 4, value: 4.2 }])
  assert.match(grown.notes.join('\n'), new RegExp(`${id} reaches scale 4\\.2`))
  // A punch-in on media of the frame's own shape, and a cover fit, are choices, not reframes.
  assert.equal(placed(wide(), { scale: 1.5 }).notes.some(note => /fill scale/.test(note)), false)
  assert.equal(placed(vertical(), { scale: 4, fit: 'cover' }).notes.some(note => /fill scale/.test(note)), false)
})

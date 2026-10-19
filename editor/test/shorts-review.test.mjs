import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { applyOps, newProject } from '../core/project.js'
import { createTranscriptRoutes } from '../routes/transcript.mjs'
import { shortsCapture, shortsCaptureMatches, shortsCreationBody, shortsEvidence, shortsNavigationMatches, shortsRanges, shortsReview, shortsReviewBody, shortsTranscriptGuard } from '../web/ui/shorts-workflow.js'

const src = 'media/speech.wav', locale = 'en-US'
const words = Array.from({ length: 40 }, (_, i) => ({ t: i, end: i + 0.8, text: i % 5 === 4 ? 'sentence.' : `word${i}` }))
const settings = { dimensions: [1080, 1920], style: 'karaoke', captions: true }
const chosen = () => [{ from: 10, to: 20, name: '  Edited speech  ', chosen: true }]

function fixture(t, { saved = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-short-review-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'media'))
  const media = path.join(root, src)
  fs.writeFileSync(media, 'copied synthetic source bytes')
  let project = newProject('Short review')
  project.assets[src] = { hasAudio: true, hasVideo: true, duration: 90, width: 1920, height: 1080 }
  let version = 7
  const history = []
  const routes = createTranscriptRoutes({ root, resolveMedia: value => path.join(root, value), getProject: () => project, getVersion: () => version,
    findWhisper: async () => { throw new Error('Recognition must not run in short review tests') },
    // Only the subject-framing sampler may run; it gets no frames here, so the crop stays centred.
    process: async (command, args) => { if (command === 'ffmpeg' && args.includes('rawvideo') && args.some(a => String(a).includes('format=gray'))) return { stdout: Buffer.alloc(0), stderr: '', code: 0 }; throw new Error('Media processing must not run in short review tests') },
    apply: ops => { history.push(project); project = applyOps(project, ops).project; version++; return { project, version, applied: true } },
  })
  const get = () => routes.get({}, new URLSearchParams({ src, locale }))
  if (saved) routes.save({ src, locale, words, revision: 0 })
  const store = { root, project, version, openComp: null }
  return { routes, get, store, media, history, project: () => project, version: () => version, edit: () => { version++ } }
}

async function reviewFixture(f, options = settings) {
  const capture = shortsCapture(f.store, src, locale), body = shortsReviewBody(capture, chosen(), options, f.get())
  const response = await f.routes.build(body)
  return { capture, body, response, review: shortsReview(capture, body, response) }
}

test('The reviewed body creates editable captions and linked media in one project edit', async t => {
  const f = fixture(t), before = structuredClone(f.project()), r = await reviewFixture(f)
  assert.deepEqual(f.project(), before)
  const created = await f.routes.build(shortsCreationBody(r.review, f.store, src, locale))
  assert.equal(f.history.length, 1)
  assert.deepEqual(f.history[0], before)
  const comp = created.project.comps[created.comps[0].id]
  assert.equal(comp.name, 'Edited speech')
  assert.equal(comp.width, 1080)
  const video = comp.tracks.find(t => t.kind === 'video').clips[0], audio = comp.tracks.find(t => t.kind === 'audio').clips[0]
  assert.equal(video.src, src)
  assert.equal(video.in, 10)
  assert.equal(video.link, audio.link)
  const captions = comp.tracks.find(t => t.kind === 'caption')
  assert.equal(captions.style.preset, 'karaoke')
  assert.equal(captions.clips[0].words[0].sourceT, 10)
  assert.equal(captions.clips[0].words[0].t, 0)
  assert.equal(fs.readFileSync(f.media, 'utf8'), 'copied synthetic source bytes')
})

test('Creation reuses an immutable request after callers mutate the ranges or reply', async t => {
  const f = fixture(t), r = await reviewFixture(f)
  r.body.ranges[0].from = 0
  r.body.captionStyle = 'plain'
  r.response.comps[0].name = 'Different name'
  assert.throws(() => { r.review.body.ranges[0].from = 2 }, TypeError)
  const body = shortsCreationBody(r.review, f.store, src, locale)
  assert.equal(body.ranges[0].from, 10)
  assert.equal(body.captionStyle, 'karaoke')
  assert.equal(r.review.comps[0].name, 'Edited speech')
  assert.equal(body.apply, true)
  assert.equal(r.review.body.apply, false)
  body.ranges[0].to = 21
  assert.equal(r.review.body.ranges[0].to, 20)
})

test('Saved word corrections invalidate a review without a project version change', async t => {
  const f = fixture(t), r = await reviewFixture(f), initial = f.get()
  f.routes.save({ src, locale, revision: initial.revision, words: words.map((w, i) => i === 12 ? { ...w, text: 'corrected' } : w) })
  assert.equal(f.version(), r.review.version)
  await assert.rejects(f.routes.build(shortsCreationBody(r.review, f.store, src, locale)), /transcript changed/)
  assert.equal(f.history.length, 0)
  assert.equal(Object.keys(f.project().comps ?? {}).length, 0)
})

for (const captions of [true, false]) {
  test(`Replaced source bytes reject a reviewed ${captions ? 'captioned' : 'manual'} range`, async t => {
    const f = fixture(t, { saved: captions }), r = await reviewFixture(f, { ...settings, captions })
    fs.appendFileSync(f.media, 'replacement')
    const body = shortsCreationBody(r.review, f.store, src, locale)
    assert.equal(typeof body.expectedSourceFingerprint, 'string')
    if (!captions) assert.equal(body.expectedTranscriptRevision, undefined)
    await assert.rejects(f.routes.build(body), /source changed/)
    assert.equal(f.history.length, 0)
  })
}

test('Manual source ranges can create without a transcript or recognition process', async t => {
  const f = fixture(t, { saved: false }), r = await reviewFixture(f, { ...settings, captions: false })
  assert.equal(r.response.transcriptRevision, 0)
  const result = await f.routes.build(shortsCreationBody(r.review, f.store, src, locale))
  assert.equal(result.applied, true)
  assert.equal(result.project.comps[result.comps[0].id].tracks.some(t => t.kind === 'caption'), false)
  assert.equal(f.get().status, 'missing')
})

test('Project changes invalidate both preview and commit before they can apply', async t => {
  const f = fixture(t), r = await reviewFixture(f)
  f.edit()
  await assert.rejects(f.routes.build(r.body), /project changed/)
  await assert.rejects(f.routes.build({ ...r.body, apply: true }), /project changed/)
  assert.equal(f.history.length, 0)
})

test('Version, root, composition, optimistic project and source changes invalidate the browser review', async t => {
  const f = fixture(t), r = await reviewFixture(f)
  for (const patch of [{ version: f.store.version + 1 }, { root: '/different-project' }, { openComp: 'other' }, { project: structuredClone(f.store.project) }]) {
    const current = { ...f.store, ...patch }
    assert.equal(shortsCaptureMatches(r.capture, current), false)
    assert.throws(() => shortsCreationBody(r.review, current, src, locale), /project or source changed/)
  }
  assert.throws(() => shortsCreationBody(r.review, f.store, 'other.wav', locale), /project or source changed/)
  assert.throws(() => shortsCreationBody(r.review, f.store, src, 'fr-FR'), /project or source changed/)
})

test('Proposals return review metadata and reject stale project and transcript inputs', async t => {
  const f = fixture(t), saved = f.get(), guard = shortsTranscriptGuard(saved)
  const body = { src, locale, minDur: 5, maxDur: 10, count: 2, expectedVersion: f.version(), ...guard }
  const result = await f.routes.propose(body)
  assert.equal(result.sourceFingerprint, saved.fingerprint)
  assert.equal(result.transcriptRevision, saved.revision)
  assert.equal(result.version, f.version())
  assert.ok(result.candidates.length)
  f.routes.save({ src, locale, revision: saved.revision, words })
  await assert.rejects(f.routes.propose(body), /transcript changed/)
  await assert.rejects(f.routes.propose({ ...body, expectedVersion: 0 }), /project changed/)
  assert.equal(f.history.length, 0)
})

test('A supplied word list must match the guarded saved text and timing', async t => {
  const f = fixture(t), r = await reviewFixture(f)
  await assert.rejects(f.routes.build({ ...r.body, words: words.map((w, i) => i === 1 ? { ...w, text: 'unsaved correction' } : w) }), /reviewed transcript words changed/)
  const response = await f.routes.build({ ...r.body, words: words.map(w => ({ ...w, confidence: .8 })) })
  assert.equal(response.comps.length, 1)
  assert.equal(f.history.length, 0)
})

test('Invalid previews and names use the same bounded ranges as the core builder', () => {
  for (const range of [{ from: -1, to: 5 }, { from: 5, to: 5 }, { from: 5, to: 4 }, { from: 80, to: 91 }, { from: NaN, to: 3 }, { from: 0, to: Infinity }, { from: 0, to: 601 }]) assert.throws(() => shortsRanges([range], 90), /inside the source/)
  assert.throws(() => shortsRanges(Array(21).fill({ from: 0, to: 1 }), 90), /1 to 20/)
  assert.equal(shortsRanges([{ from: 0, to: 1, name: '😀'.repeat(120) }], 90)[0].name, '😀'.repeat(100))
  assert.equal(shortsRanges([{ from: 0, to: 1, name: 'x'.repeat(199) + '😀' }], 90)[0].name, 'x'.repeat(199))
  assert.equal(shortsRanges([{ from: 0, to: 1, name: '  ' }], 90)[0].name, 'Clip 1')
  assert.equal(shortsEvidence(words, { from: 10, to: 12 }), 'word10 word11')
  assert.equal(shortsEvidence(words, { from: 11, to: 14 }), 'word11 word12 word13')
})

test('A changed or malformed review response cannot enable Create', async t => {
  const f = fixture(t), r = await reviewFixture(f)
  for (const response of [{ ...r.response, version: 8 }, { ...r.response, sourceFingerprint: 'other' }, { ...r.response, transcriptRevision: 2 }, { ...r.response, comps: [{ ...r.response.comps[0], from: undefined }] }, { ...r.response, comps: [{ ...r.response.comps[0], name: 'other' }] }]) assert.throws(() => shortsReview(r.capture, r.body, response), /changed/)
  assert.throws(() => shortsReviewBody(r.capture, chosen(), settings, { ...f.get(), src: 'other.wav' }), /this source and language/)
})

// Run the component's actual commit handler without opening an app or creating a server.
const text = fs.readFileSync(new URL('../web/ui/plugins/shorts.js', import.meta.url), 'utf8')
const method = text.slice(text.indexOf('  const build = async apply => {'), text.indexOf('  const canUseTranscript = '))
const makeBuild = new Function('env', `const {generation,store,src,locale,chosen,dimensions,style,captions,transcript,preview,setBusy,setError,setPreview,api,set,toast,shortsCapture,shortsCaptureMatches,shortsCreationBody,shortsReviewBody,shortsReview,shortsNavigationMatches}=env; ${method}; return build`)

function component(f, api) {
  const state = { preview: null, error: '', busy: false, notices: [], mutations: [] }
  const build = () => makeBuild({ generation: { current: 0 }, store: f.store, src, locale, chosen: chosen(), dimensions: settings.dimensions, style: settings.style, captions: true, transcript: f.get(), preview: state.preview,
    setBusy: value => { state.busy = value }, setError: value => { state.error = value }, setPreview: value => { state.preview = value },
    set: patch => { state.mutations.push(patch); Object.assign(f.store, patch) }, toast: value => state.notices.push(value),
    api: api ?? ((url, body) => url === '/api/project' ? Promise.resolve({ project: f.project(), version: f.version() }) : f.routes.build(body)),
    shortsCapture, shortsCaptureMatches, shortsCreationBody, shortsReviewBody, shortsReview, shortsNavigationMatches,
  })
  return { state, build }
}

test('The component commit handler reviews and opens the actual created composition', async t => {
  const f = fixture(t), ui = component(f)
  await ui.build()(false)
  assert.equal(ui.state.error, '')
  assert.ok(ui.state.preview)
  await ui.build()(true)
  assert.equal(ui.state.error, '')
  assert.equal(ui.state.preview, null)
  assert.equal(f.store.openComp, Object.keys(f.project().comps)[0])
  assert.equal(ui.state.notices.length, 1)
  assert.equal(f.history.length, 1)
})

test('The component obtains a project when a create reply carries only native edit metadata', async t => {
  const f = fixture(t), calls = []
  const ui = component(f, async (url, body) => {
    calls.push(url)
    if (url === '/api/project') return { project: f.project(), version: f.version() }
    const result = await f.routes.build(body)
    if (body.apply) delete result.project
    return result
  })
  await ui.build()(false)
  await ui.build()(true)
  assert.equal(ui.state.error, '')
  assert.deepEqual(calls, ['/api/shorts/build', '/api/shorts/build', '/api/project'])
  assert.equal(f.store.openComp, Object.keys(f.project().comps)[0])
})

test('A late create reply from another root cannot replace the open project or navigate it', async t => {
  const f = fixture(t)
  const ui = component(f, async (_url, body) => {
    const result = await f.routes.build(body)
    if (body.apply) f.store.root = '/another-project'
    return result
  })
  await ui.build()(false)
  await ui.build()(true)
  assert.equal(ui.state.mutations.length, 0)
  assert.equal(f.store.openComp, null)
  assert.deepEqual(ui.state.notices, [])
  assert.equal(f.history.length, 1)
})

for (const change of [{ openComp: 'k1' }, { selection: ['user-selection'] }, { page: 'deliver' }, { viewerMode: 'source' }]) {
  test(`A late create reply preserves user navigation ${JSON.stringify(change)}`, async t => {
    const f = fixture(t)
    f.store.page = 'edit'; f.store.selection = []; f.store.viewerMode = 'timeline'
    const ui = component(f, async (_url, body) => {
      const result = await f.routes.build(body)
      if (body.apply) Object.assign(f.store, change)
      return result
    })
    await ui.build()(false)
    await ui.build()(true)
    assert.equal(ui.state.error, '')
    for (const [key, value] of Object.entries(change)) assert.deepEqual(f.store[key], value)
    assert.equal(ui.state.mutations.length, 1)
    assert.deepEqual(Object.keys(ui.state.mutations[0]).sort(), ['project', 'version'])
    assert.equal(Object.keys(f.store.project.comps).length, 1)
    assert.equal(ui.state.notices.length, 1)
  })
}

test('A late create reply keeps a newer project version and its navigation', async t => {
  const f = fixture(t)
  const ui = component(f, async (_url, body) => {
    const result = await f.routes.build(body)
    if (body.apply) Object.assign(f.store, { project: { ...structuredClone(result.project), name: 'Newer edit' }, version: result.version + 1, selection: ['newer-selection'] })
    return result
  })
  await ui.build()(false)
  await ui.build()(true)
  assert.equal(ui.state.error, '')
  assert.equal(ui.state.mutations.length, 0)
  assert.equal(f.store.project.name, 'Newer edit')
  assert.deepEqual(f.store.selection, ['newer-selection'])
  assert.equal(f.store.version, f.version() + 1)
})

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const directoryURL = value => pathToFileURL(value.replace(/\/$/, '') + '/')
const editor = process.env.ARYA_GENERATED_MUSIC_EDITOR_ROOT ? directoryURL(process.env.ARYA_GENERATED_MUSIC_EDITOR_ROOT) : new URL('../', import.meta.url)
const candidate = process.env.ARYA_GENERATED_MUSIC_CANDIDATE_ROOT ? directoryURL(process.env.ARYA_GENERATED_MUSIC_CANDIDATE_ROOT) : editor
registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('/core/') ? new URL('.' + specifier, editor).href : specifier, context) } })
const { newProject, applyOps } = await import(new URL('core/project.js', editor))
const { MUSIC_RENDERER, musicAssetRecord, musicPlacementOps, validateMusicScore } = await import(new URL('core/music-score.js', editor))
const modelURL = new URL('web/ui/generated-music-model.js', candidate).href
const { createGeneratedMusicSession, musicVariation, newMusicScore, resizeMusicScore } = await import(modelURL)
const source = 'media/generated/music/11111111-1111-4111-8111-111111111111/score.wav'
const generated = 'media/generated/music/22222222-2222-4222-8222-222222222222/score.wav'
const score = validateMusicScore({ version: 1, title: 'Saved cue', bpm: 120, lengthBeats: 2, seed: 17, room: 0, parts: [{ id: 'keys', instrument: 'keys', notes: [{ at: 0, duration: 1, pitch: 62, velocity: 0.7 }] }] })
const copy = value => structuredClone(value)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const scope = (project, comp) => comp === null ? project : project.comps[comp]
function receipt(path, score) {
  const duration = score.lengthBeats * 60 / score.bpm
  return { path, asset: { hasAudio: true, hasVideo: false, channels: 2, duration, codec: 'pcm_s24le' }, measurement: { samplePeakDb: -3, rmsDb: -10, samples: Math.round(duration * 48000) * 2 }, contentSHA256: 'a'.repeat(64) }
}
// Scripted HTTP replies exercise the production UI controller and real project operations.
// This fixture does not render audio or establish the backend's filesystem guarantees.
function fixture(comp = null) {
  const project = newProject('Music Media fixture')
  project.comps = { nested: { id: 'nested', name: 'Nested', fps: 25, tracks: copy(project.tracks), markers: [] } }
  project.assets[source] = musicAssetRecord(score, receipt(source, score))
  const current = { caps: { analysis: {} }, root: '/owned-music-fixture', comp, project, version: 7, connected: true }
  const calls = [], history = [], notices = []
  const e = { current, calls, history, notices, assetReady: false, beforeGet: null, beforePost: null, transformReply: null, caps: { available: true, renderer: MUSIC_RENDERER } }
  const snapshot = () => copy({ root: current.root, version: current.version, project: current.project })
  const commit = ops => { const result = applyOps(current.project, ops); history.push(current.project); current.project = result.project; current.version++; return result.created }
  e.undo = () => { current.project = history.pop(); current.version++ }
  e.request = async (route, body) => {
    calls.push({ route, body: copy(body) })
    if (route === '/api/audio/compose/capabilities') return copy(e.caps)
    if (route === '/api/project') { if (e.beforeGet) await e.beforeGet(); return snapshot() }
    assert(['/api/audio/compose', '/api/audio/compose/place'].includes(route))
    assert.equal(body.expectedVersion, current.version)
    if (e.beforePost) await e.beforePost()
    const composing = route === '/api/audio/compose'
    const path = composing ? generated : body.path
    const normalized = composing ? validateMusicScore(body.score) : current.project.assets[path].generated.score
    const rendered = receipt(path, normalized)
    const asset = composing ? musicAssetRecord(normalized, rendered) : current.project.assets[path]
    if (composing) commit([{ op: 'import', assets: { [path]: asset } }])
    let created = []
    if (!composing || !e.assetReady) {
      const { path: ignored, ...target } = body
      created = commit(musicPlacementOps(current.project, { ...target, score: normalized, expectedVersion: current.version }, rendered))
    }
    let reply = { state: composing && e.assetReady ? 'asset_ready' : 'complete', path, asset, created, version: current.version }
    if (e.transformReply) reply = e.transformReply(reply)
    return copy(reply)
  }
  e.session = createGeneratedMusicSession({ source, read: () => current, request: e.request, changed: () => notices.push(true) })
  e.ready = () => e.session.loadCapabilities()
  e.review = (values = {}) => e.session.review({ mode: 'place', track: 'A3', start: 1.02, ...values })
  e.posts = () => calls.filter(call => call.body !== undefined)
  return e
}

test('opening and reviewing saved music cannot generate or place it', async () => {
  const e = fixture(), before = copy(e.current.project)
  assert.deepEqual(e.session.state.original.generated.score, score)
  await assert.rejects(e.session.run(), /Review the current target/)
  await e.ready(); await e.review()
  assert.equal(e.posts().length, 0); assert.deepEqual(e.current.project, before)
  assert.match(e.session.state.review, /Music \(A3\).*version 7/)
})
for (const comp of [null, 'nested']) test(`explicit reuse in ${comp ?? 'main'} respects frame rounding and Undo retains Media`, async () => {
  const e = fixture(comp), before = copy(e.current.project)
  await e.ready(); await e.review(); await e.session.run()
  assert.equal(e.posts().length, 1)
  assert.deepEqual(e.posts()[0], { route: '/api/audio/compose/place', body: { path: source, track: 'A3', start: 1.02, comp, expectedVersion: 7 } })
  const placed = scope(e.current.project, comp).tracks.find(track => track.id === 'A3').clips[0]
  assert.equal(placed.src, source); assert.equal(placed.start, comp ? 1.04 : 1.03333); assert.equal(placed.dur, 1)
  assert.deepEqual(scope(e.current.project, comp).tracks.filter(track => track.id !== 'A3'), scope(before, comp).tracks.filter(track => track.id !== 'A3'))
  assert.match(e.session.state.message, /placed on the reviewed track/)
  e.undo(); assert.deepEqual(e.current.project, before); assert.deepEqual(e.current.project.assets[source], before.assets[source])
})
for (const [name, setup, values, pattern] of [
  ['locked', e => { scope(e.current.project, null).tracks.find(t => t.id === 'A3').locked = true }, {}, /locked/],
  ['overlap', e => { scope(e.current.project, null).tracks.find(t => t.id === 'A3').clips.push({ id: 'occupied', kind: 'audio', src: source, start: 1, dur: 2, in: 0 }) }, {}, /overlaps/],
  ['video track', () => {}, { track: 'V1' }, /audio track/],
  ['missing track', () => {}, { track: 'absent' }, /audio track/],
  ['invalid start', () => {}, { start: NaN }, /start/],
  ['invalid score', () => {}, { mode: 'variation', score: { ...score, bpm: 900 } }, /bpm/],
]) test(`review refuses ${name} without edits or requests to compose`, async () => {
  const e = fixture(); setup(e); const before = copy(e.current.project)
  await e.ready(); await assert.rejects(e.review(values), pattern)
  assert.equal(e.posts().length, 0); assert.deepEqual(e.current.project, before); assert.equal(e.session.currentReview(), false)
})
for (const [name, change] of [
  ['version', e => e.current.version++],
  ['optimistic project', e => { e.current.project.name = 'Pending edit' }],
  ['root', e => { e.current.root = '/another-project' }],
  ['composition', e => { e.current.comp = 'nested' }],
  ['source identity', e => { e.current.project.assets[source].generated.contentSHA256 = 'b'.repeat(64) }],
  ['connection', e => { e.current.connected = false }],
]) test(`a reviewed request cannot dispatch after ${name} changes`, async () => {
  const e = fixture(); await e.ready(); await e.review(); change(e)
  await assert.rejects(e.session.run(), /changed|disconnected|Review the current target/); assert.equal(e.posts().length, 0)
})
test('a canonical snapshot must match the local project before review', async () => {
  const e = fixture(); await e.ready()
  const original = e.request
  const session = createGeneratedMusicSession({ source, read: () => e.current, request: async (route, body) => route === '/api/project' ? { root: e.current.root, version: 7, project: { ...e.current.project, name: 'Earlier disk state' } } : original(route, body) })
  await session.loadCapabilities(); await assert.rejects(session.review({ mode: 'place', track: 'A3', start: 0 }), /still changing/)
  assert.equal(e.posts().length, 0)
})
for (const caps of [{ available: false, renderer: MUSIC_RENDERER }, { available: true, renderer: 'unsupported' }]) test(`unsupported capability ${JSON.stringify(caps)} permits inspection only`, async () => {
  const e = fixture(); e.caps = caps; await e.ready()
  assert.deepEqual(e.session.state.original.generated.score, score)
  await assert.rejects(e.review(), /availability/); assert.equal(e.posts().length, 0)
})
test('a saved variation retries placement without rendering again and survives placement Undo', async () => {
  const e = fixture(); e.assetReady = true; await e.ready()
  const varied = musicVariation(score, { title: 'Bell variation', bpm: 100, parts: score.parts.map(part => ({ ...part, instrument: 'bell' })) })
  assert.deepEqual(score.parts[0].instrument, 'keys')
  await e.review({ mode: 'variation', score: varied }); await e.session.run()
  assert.equal(e.session.state.retained.path, generated); assert.match(e.session.state.message, /without rendering again/)
  assert.deepEqual(e.current.project.assets[generated].generated.score, varied)
  assert.deepEqual(e.current.project.assets[source].generated.score, score)
  await e.review({ start: 3 }); await e.session.run()
  assert.deepEqual(e.posts().map(call => call.route), ['/api/audio/compose', '/api/audio/compose/place'])
  assert.equal(e.posts()[1].body.path, generated); assert.equal(e.posts()[1].body.expectedVersion, 8)
  assert.equal(e.current.project.tracks.find(t => t.id === 'A3').clips[0].src, generated)
  e.undo(); assert(e.current.project.assets[generated]); assert.equal(e.current.project.tracks.find(t => t.id === 'A3').clips.length, 0)
  e.session.useOriginal(); await e.review({ start: 5 }); assert.equal(e.posts().length, 2)
  await e.session.run(); assert.equal(e.posts()[2].body.path, source); assert(e.current.project.assets[generated])
})
for (const [name, corrupt] of [
  ['wrong source', reply => ({ ...reply, path: generated })],
  ['wrong score', reply => ({ ...reply, asset: { ...reply.asset, generated: { ...reply.asset.generated, score: { ...score, title: 'Wrong score' } } } })],
  ['missing version', reply => ({ ...reply, version: undefined })],
]) test(`a ${name} receipt is never reported as confirmed placement`, async () => {
  const e = fixture(); await e.ready(); await e.review(); e.transformReply = corrupt
  await assert.rejects(e.session.run()); assert(!e.session.state.message.includes('placed on the reviewed track')); assert.match(e.session.state.error, /Media/)
})
test('a missing created clip is reported as unconfirmed instead of prompting an automatic retry', async () => {
  const e = fixture(); await e.ready(); await e.review(); e.transformReply = reply => ({ ...reply, created: ['absent'] })
  await e.session.run(); assert.match(e.session.state.message, /placement could not be confirmed/); assert.equal(e.posts().length, 1)
})
for (const [name, corrupt] of [
  ['byte identity', reply => { delete reply.asset.generated.contentSHA256; return reply }],
  ['Media registration', (reply, e) => { delete e.current.project.assets[generated]; return reply }],
]) test(`a new variation needs matching ${name}`, async () => {
  const e = fixture(); await e.ready(); await e.review({ mode: 'variation', score: musicVariation(score, { title: 'Variation' }) })
  e.transformReply = reply => corrupt(reply, e)
  await assert.rejects(e.session.run()); assert.equal(e.session.state.retained, null)
})
test('closing retires dialog updates without claiming cancellation or losing the backend Media commit', async () => {
  const e = fixture(), gate = deferred(); e.assetReady = true; e.beforePost = () => gate.promise
  await e.ready(); await e.review({ mode: 'variation', score: musicVariation(score, { title: 'Continued variation' }) })
  const pending = e.session.run(); await assert.rejects(e.session.run(), /current music request/)
  e.session.close(); const count = e.notices.length, getCount = e.calls.filter(call => call.route === '/api/project').length
  gate.resolve(); assert.equal(await pending, null)
  assert.equal(e.notices.length, count); assert.equal(e.calls.filter(call => call.route === '/api/project').length, getCount)
  assert(e.current.project.assets[generated]); assert.equal(e.posts().length, 1); assert.equal(e.session.state.retained, null)
})
test('source replacement during the response cannot update the dialog from a retired request', async () => {
  const e = fixture(), gate = deferred(); e.beforePost = () => gate.promise
  await e.ready(); await e.review(); const pending = e.session.run()
  e.current.project.assets[source].generated.contentSHA256 = 'b'.repeat(64); gate.resolve()
  await assert.rejects(pending, /source changed/); assert(!e.session.state.message); assert.equal(e.session.state.retained, null)
})
test('request failure leaves a previously saved variation reusable', async () => {
  const e = fixture(); e.assetReady = true; await e.ready(); await e.review({ mode: 'variation', score: musicVariation(score, { title: 'Retained' }) }); await e.session.run()
  await e.review({ start: 3 }); e.beforePost = async () => { throw new Error('Source identity changed') }
  await assert.rejects(e.session.run(), /identity changed/); assert.equal(e.session.state.retained.path, generated); assert(e.current.project.assets[generated]); assert.equal(e.posts().filter(call => call.route === '/api/audio/compose').length, 1)
})

// Execute the actual Preact component and callbacks with owned hook state, without DOM/browser I/O.
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const fixtureKey = Symbol.for('arya.generated-music-media.fixture')
const require = createRequire(new URL('package.json', editor))
const hooks = moduleURL(`const f=()=>globalThis[Symbol.for('arya.generated-music-media.fixture')];export const useEffect=()=>{};export const useLayoutEffect=()=>{};export const useRef=v=>({current:v});export const useState=v=>{const s=f(),i=s.cursor++;if(!(i in s.states))s.states[i]=typeof v==='function'?v():v;return[s.states[i],value=>{s.states[i]=typeof value==='function'?value(s.states[i]):value}]};`)
const storeFacade = moduleURL(`const f=()=>globalThis[Symbol.for('arya.generated-music-media.fixture')];export const store=new Proxy({},{get:(_,key)=>key==='openComp'?f().e.current.comp:f().e.current[key]});export const time={t:1.02};export const useStore=()=>store;export const api=(...args)=>f().e.request(...args);`)
let uiSource = await fs.readFile(new URL('web/ui/generated-music.js', candidate), 'utf8')
for (const [from, to] of Object.entries({ preact: pathToFileURL(require.resolve('preact')).href, htm: pathToFileURL(require.resolve('htm')).href, 'preact/hooks': hooks, './generated-music-model.js': modelURL, './store.js': storeFacade })) uiSource = uiSource.replaceAll("'" + from + "'", JSON.stringify(to))
const { GeneratedMusicDetails } = await import(moduleURL(uiSource))
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.props?.children)] : []
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object' ? text(tree.props?.children) : String(tree ?? '')
function ui(t, chosenSource = source) {
  const e = fixture(), f = { e, states: [], cursor: 0, closed: 0 }
  globalThis[fixtureKey] = f; t.after(() => delete globalThis[fixtureKey])
  const tree = () => { f.cursor = 0; return GeneratedMusicDetails({ source: chosenSource, onClose: () => f.closed++ }) }
  const button = name => { const control = nodes(tree()).find(node => node.type === 'button' && text(node) === name); assert(control, name); return control }
  return { e, f, tree, button }
}
test('actual details controls inspect the score, require review, and explicitly place saved music', async t => {
  const u = ui(t)
  assert.equal(nodes(u.tree()).find(n => n.props?.role === 'dialog').props['aria-modal'], 'true')
  assert.match(text(u.tree()), /Saved score and notes/); assert.match(text(u.tree()), /"pitch": 62/)
  assert.equal(u.button('Place saved music').props.disabled, true)
  await u.button('Check composer availability').props.onClick()
  await u.button('Review target').props.onClick(); assert.equal(u.e.posts().length, 0)
  assert.equal(u.button('Place saved music').props.disabled, false)
  await u.button('Place saved music').props.onClick(); assert.equal(u.e.posts()[0].route, '/api/audio/compose/place')
})
test('actual variation controls change the requested score and a retained variation selects place-only reuse', async t => {
  const u = ui(t); u.e.assetReady = true
  await u.button('Check composer availability').props.onClick(); u.button('Create variation').props.onClick()
  const instrument = nodes(u.tree()).find(node => node.type === 'select' && node.props.value === 'keys')
  instrument.props.onChange({ target: { value: 'bell' } })
  await u.button('Review target').props.onClick(); await u.button('Create variation and place').props.onClick()
  assert.equal(u.e.posts()[0].body.score.parts[0].instrument, 'bell'); assert.equal(u.e.current.project.assets[source].generated.score.parts[0].instrument, 'keys')
  await u.button('Review target').props.onClick(); await u.button('Place saved variation').props.onClick()
  assert.deepEqual(u.e.posts().map(call => call.route), ['/api/audio/compose', '/api/audio/compose/place'])
})
test('actual close control stays available while the request is pending and explains its lifetime', async t => {
  const u = ui(t), gate = deferred(); u.e.beforePost = () => gate.promise
  await u.button('Check composer availability').props.onClick(); await u.button('Review target').props.onClick()
  const pending = u.button('Place saved music').props.onClick()
  assert.match(text(u.tree()), /Closing this dialog does not cancel it/)
  assert.notEqual(u.button('Close').props.disabled, true); u.button('Close').props.onClick(); assert.equal(u.f.closed, 1)
  gate.resolve(); await pending; assert.equal(u.e.posts().length, 1)
})

const subscriberBody = (await fs.readFile(new URL('web/ui/store.js', editor), 'utf8')).match(/^export function subscribe\(fn\) \{[^]*?^\}/m)?.[0]
assert(subscriberBody, 'Load the actual store subscriber export for the Browser dependency')
const browserFacade = moduleURL(`const listeners = new Set(); ${subscriberBody};export {store,time,api,useStore} from ${JSON.stringify(storeFacade)};const f=()=>globalThis[Symbol.for('arya.generated-music-media.fixture')];export const toast=(message)=>f().errors.push(message);export const addRef=()=>{};export const edit=()=>{};export const set=()=>{};export const viewProject=()=>f().e.current.project;`)
const empty = moduleURL('export const ScrollTabs=()=>null;export const openMenu=()=>{};export const host={};export const registry={browserSections:[],browserTabs:[]};export const runTranscriptJob=()=>{};export const importMediaPaths=()=>{};export const uploadMediaFiles=()=>{};export const mediaDisplayModel=()=>({name:"Saved cue",tooltip:"Saved cue"});export const mediaDisplayName=()=>"Saved cue";export const mediaMatchesQuery=()=>true;')
const opener = moduleURL("export const openGeneratedMusicDetails=source=>globalThis[Symbol.for('arya.generated-music-media.fixture')].opened.push(source);")
let browserSource = await fs.readFile(new URL('web/ui/browser.js', candidate), 'utf8')
for (const [from, to] of Object.entries({ preact: pathToFileURL(require.resolve('preact')).href, htm: pathToFileURL(require.resolve('htm')).href, 'preact/hooks': hooks, './store.js': browserFacade, './scroll-tabs.js': empty, './menu.js': empty, '../host.js': empty, './registry.js': empty, './transcript-jobs.js': empty, './media-import.js': empty, './media-label.js': empty, './title-presets.js': new URL('web/ui/title-presets.js', editor).href, '/ui/generated-music.js': opener, './generated-music.js': opener })) browserSource = browserSource.replaceAll("'" + from + "'", JSON.stringify(to))
const { MediaCard, MediaTab, analyzeMenu } = await import(moduleURL(browserSource + '\nexport { MediaCard, MediaTab };\n'))
function cardFixture(t) {
  const e = fixture(), f = { e, states: [], cursor: 0, opened: [], errors: [] }
  globalThis[fixtureKey] = f; t.after(() => delete globalThis[fixtureKey])
  const card = asset => { f.cursor = 0; return MediaCard({ p: e.current.project, src: source, asset }) }
  return { e, f, card }
}
test('actual Media card and menu expose details only for supported saved music', async t => {
  const u = cardFixture(t), asset = u.e.current.project.assets[source]
  const button = nodes(u.card(asset)).find(node => node.type === 'button' && text(node) === 'Music details')
  assert(button); let stopped = 0
  await button.props.onClick({ stopPropagation: () => stopped++ })
  assert.equal(stopped, 1); assert.deepEqual(u.f.opened, [source])
  const action = analyzeMenu(u.e.current.project, source).find(item => item.label === 'Music details & reuse…')
  assert(action); await action.run(); assert.deepEqual(u.f.opened, [source, source])
  for (const ordinary of [{ ...asset, generated: undefined }, { ...asset, generated: { ...asset.generated, renderer: 'arya-score-synth/next' } }]) {
    assert(!nodes(u.card(ordinary)).some(node => node.type === 'button' && text(node) === 'Music details'))
    assert(!analyzeMenu({ ...u.e.current.project, assets: { [source]: ordinary } }, source).some(item => item.label === 'Music details & reuse…'))
  }
  assert.equal(u.e.posts().length, 0)
})
test('a delayed details-module load cannot open on a replaced project', async t => {
  const u = cardFixture(t), action = analyzeMenu(u.e.current.project, source).find(item => item.label === 'Music details & reuse…')
  const pending = action.run(); u.e.current.root = '/replaced-root'; await pending
  assert.deepEqual(u.f.opened, []); assert.match(u.f.errors[0], /project or source changed/); assert.equal(u.e.posts().length, 0)
})

// Creation starts from a score, never a synthetic Media asset. These remain scripted HTTP tests.
function creationFixture(comp = null) {
  const e = fixture(comp)
  e.current.project.assets = {}
  e.session = createGeneratedMusicSession({ read: () => e.current, request: e.request, changed: () => e.notices.push(true) })
  e.review = (values = {}) => e.session.review({ mode: 'create', track: 'A3', start: 0, score: newMusicScore(), ...values })
  return e
}
test('the visible starter is an independent four-note score with explicit local synthesis values', () => {
  const starter = newMusicScore(), other = newMusicScore()
  assert.deepEqual({ title: starter.title, bpm: starter.bpm, lengthBeats: starter.lengthBeats, seed: starter.seed }, { title: 'Original cue', bpm: 120, lengthBeats: 8, seed: 17 })
  assert.equal(starter.parts[0].id, 'melody'); assert.equal(starter.parts[0].instrument, 'keys')
  assert.deepEqual(starter.parts[0].notes, [
    { at: 0, duration: 1.5, pitch: 60, velocity: 0.7 }, { at: 2, duration: 1.5, pitch: 64, velocity: 0.7 },
    { at: 4, duration: 1.5, pitch: 67, velocity: 0.7 }, { at: 6, duration: 1.5, pitch: 72, velocity: 0.7 },
  ])
  starter.parts[0].notes[0].pitch = 48; assert.equal(other.parts[0].notes[0].pitch, 60)
})
test('duration stretches note timing without modifying pitches or the starting score', () => {
  const starter = newMusicScore(), before = copy(starter), resized = resizeMusicScore(starter, 6)
  assert.equal(resized.lengthBeats, 12); assert.equal(resized.lengthBeats * 60 / resized.bpm, 6)
  assert.deepEqual(resized.parts[0].notes.map(note => [note.at, note.duration, note.pitch]), [[0, 2.25, 60], [3, 2.25, 64], [6, 2.25, 67], [9, 2.25, 72]])
  assert.deepEqual(starter, before)
  const tooLongAfterTempoChange = { ...resizeMusicScore(starter, 60), bpm: 100 }
  assert.equal(resizeMusicScore(tooLongAfterTempoChange, 30).lengthBeats, 50, 'a duration edit can repair a draft made too long by a tempo change')
})
test('duration rejects invalid bounds and cannot bypass the real score limits', () => {
  for (const value of [NaN, Infinity, 0, 0.24, 60.01]) assert.throws(() => resizeMusicScore(newMusicScore(), value), /Duration/)
  assert.throws(() => resizeMusicScore({ ...newMusicScore(), bpm: 0 }, 4), /tempo/)
  assert.throws(() => resizeMusicScore({ ...newMusicScore(), parts: [] }, 4), /instrument parts/)
})
for (const comp of [null, 'nested']) test(`first creation in empty ${comp ?? 'main'} Media requires explicit review and preserves its source on Undo`, async () => {
  const e = creationFixture(comp), before = copy(e.current.project)
  assert.equal(e.session.state.original, null); assert.equal(e.session.state.retained, null)
  await e.ready(); await assert.rejects(e.session.run(), /Review/); await e.review()
  assert.deepEqual(e.current.project, before); assert.equal(e.posts().length, 0)
  await e.session.run()
  assert.equal(e.posts().length, 1); assert.equal(e.posts()[0].route, '/api/audio/compose')
  assert.equal(e.posts()[0].body.track, 'A3'); assert.equal(e.posts()[0].body.start, 0); assert.equal(e.posts()[0].body.comp, comp); assert.equal(e.posts()[0].body.expectedVersion, 7)
  assert.equal(Object.hasOwn(e.posts()[0].body, 'path'), false)
  assert.deepEqual(Object.keys(e.current.project.assets), [generated]); assert.deepEqual(e.current.project.assets[generated].generated.score, newMusicScore())
  assert.equal(scope(e.current.project, comp).tracks.find(track => track.id === 'A3').clips[0].src, generated)
  assert.match(e.session.state.message, /placed on the reviewed track/)
  e.undo(); assert(e.current.project.assets[generated]); assert.equal(scope(e.current.project, comp).tracks.find(track => track.id === 'A3').clips.length, 0)
})
test('first creation retains a saved-only receipt after an ordinary edit and retries only placement', async () => {
  const e = creationFixture(); e.assetReady = true
  await e.ready(); await e.review()
  e.beforePost = async () => { e.current.project = { ...e.current.project, name: 'Keep my ordinary edit' }; e.current.version++ }
  await e.session.run(); e.beforePost = null
  assert.equal(e.current.project.name, 'Keep my ordinary edit'); assert.equal(e.session.state.retained.path, generated)
  assert.equal(e.current.project.tracks.find(track => track.id === 'A3').clips.length, 0)
  assert.match(e.session.state.message, /place this saved music without rendering again/)
  await e.review({ mode: 'place', start: 10 }); await e.session.run()
  assert.deepEqual(e.posts().map(call => call.route), ['/api/audio/compose', '/api/audio/compose/place'])
  assert.equal(e.posts()[1].body.path, generated); assert.equal(e.posts()[1].body.expectedVersion, 9)
  e.undo(); assert(e.current.project.assets[generated]); assert.equal(e.current.project.name, 'Keep my ordinary edit')
})
test('an empty creation session cannot reuse or claim a source that does not exist', async () => {
  const e = creationFixture(); await e.ready()
  await assert.rejects(e.review({ mode: 'place' }), /saved music changed/)
  await assert.rejects(e.review({ mode: 'variation' }), /supported creation/)
  assert.throws(() => e.session.useOriginal(), /no original Media source/)
  assert.deepEqual(e.current.project.assets, {}); assert.equal(e.posts().length, 0)
})
for (const [name, change] of [
  ['version', e => e.current.version++], ['local edit', e => { e.current.project.name = 'Changed locally' }],
  ['root', e => { e.current.root = '/another-root' }], ['composition', e => { e.current.comp = 'nested' }],
  ['connection', e => { e.current.connected = false }], ['missing project', e => { e.current.project = null }],
]) test(`first creation cannot dispatch after its reviewed ${name} changes`, async () => {
  const e = creationFixture(); await e.ready(); await e.review(); change(e)
  await assert.rejects(e.session.run(), /changed|disconnected|Review/); assert.equal(e.posts().length, 0)
})
test('unavailable local composition never creates a placeholder Media asset', async () => {
  const e = creationFixture(); e.caps = { available: false, renderer: MUSIC_RENDERER }; await e.ready()
  await assert.rejects(e.review(), /availability/)
  assert.match(e.session.state.error, /creation is unavailable/); assert.deepEqual(e.current.project.assets, {}); assert.equal(e.posts().length, 0)
})
test('a failed first request does not invent success and requires another explicit review', async () => {
  const e = creationFixture(); await e.ready(); await e.review(); e.beforePost = async () => { throw Error('Owned renderer refused the request') }
  await assert.rejects(e.session.run(), /renderer refused/)
  assert.equal(e.session.state.retained, null); assert.deepEqual(e.current.project.assets, {}); assert.equal(e.session.state.busy, false)
  await assert.rejects(e.session.run(), /Review/); assert.equal(e.posts().length, 1)
})
test('first creation cannot retain a response that lacks actual Media registration', async () => {
  const e = creationFixture(); await e.ready(); await e.review()
  e.transformReply = reply => { delete e.current.project.assets[generated]; return reply }
  await assert.rejects(e.session.run(), /no longer matches Media/); assert.equal(e.session.state.retained, null)
})
test('closing first creation retires UI callbacks while the owned backend response can finish', async t => {
  const e = creationFixture(), gate = deferred(); t.after(() => gate.resolve())
  e.assetReady = true; e.beforePost = () => gate.promise; await e.ready(); await e.review()
  const pending = e.session.run(); await assert.rejects(e.session.run(), /current music request/)
  e.session.close(); const noticeCount = e.notices.length; gate.resolve()
  assert.equal(await pending, null); assert.equal(e.notices.length, noticeCount); assert.equal(e.session.state.retained, null)
  assert(e.current.project.assets[generated]); assert.equal(e.posts().length, 1)
})
test('the actual empty Media tab exposes a connected Create music action without making an asset', async t => {
  const u = cardFixture(t); u.e.current.project.assets = {}; u.f.cursor = 0
  const tree = MediaTab({ p: u.e.current.project })
  const action = nodes(tree).find(node => node.type === 'button' && text(node) === 'Create music…')
  assert(action); assert.equal(action.props.disabled, false); assert.match(text(tree), /create music/)
  await action.props.onClick(); assert.deepEqual(u.f.opened, [null]); assert.deepEqual(u.e.current.project.assets, {}); assert.equal(u.e.posts().length, 0)
  u.e.current.connected = false; u.f.cursor = 0
  assert.equal(nodes(MediaTab({ p: u.e.current.project })).find(node => node.type === 'button' && text(node) === 'Create music…').props.disabled, true)
})
function inputFor(tree, labelText) {
  const label = nodes(tree).find(node => node.type === 'label' && text(node).trim().startsWith(labelText))
  assert(label, labelText)
  const input = nodes(label).find(node => node.type === 'input' || node.type === 'select'); assert(input, labelText); return input
}
test('actual first-use controls edit tempo, duration, instrument and notes before creating real-request music', async t => {
  const u = ui(t, null); u.e.current.project.assets = {}
  assert.match(text(u.tree()), /locally synthesized instrumental cue/)
  assert(!text(u.tree()).includes('Saved score and notes')); assert.equal(u.button('Create music and place').props.disabled, true)
  await u.button('Check composer availability').props.onClick()
  inputFor(u.tree(), 'Music name').props.onInput({ target: { value: 'My first local cue' } })
  inputFor(u.tree(), 'Tempo in BPM').props.onInput({ target: { value: '100' } })
  inputFor(u.tree(), 'Duration in seconds').props.onInput({ target: { value: '6' } })
  inputFor(u.tree(), 'melody instrument').props.onChange({ target: { value: 'bell' } })
  inputFor(u.tree(), 'Note 1 pitch').props.onChange({ target: { value: '62' } })
  await u.button('Review target').props.onClick(); assert.deepEqual(u.e.current.project.assets, {}); assert.equal(u.e.posts().length, 0)
  await u.button('Create music and place').props.onClick()
  const request = u.e.posts()[0]; assert.equal(request.route, '/api/audio/compose')
  assert.equal(request.body.score.title, 'My first local cue'); assert.equal(request.body.score.bpm, 100); assert.equal(request.body.score.lengthBeats, 10)
  assert.deepEqual(request.body.score.parts[0].notes.map(note => [note.at, note.duration, note.pitch]), [[0, 1.875, 62], [2.5, 1.875, 64], [5, 1.875, 67], [7.5, 1.875, 72]])
  assert.equal(request.body.score.parts[0].instrument, 'bell'); assert.deepEqual(Object.keys(u.e.current.project.assets), [generated])
  assert.match(text(u.tree()), /Saved score and notes/); assert(u.button('Place saved music')); assert(!text(u.tree()).includes('Use original source'))
})
test('an invalid duration or note keeps first-use review disabled until the draft is corrected', async t => {
  const u = ui(t, null); u.e.current.project.assets = {}; await u.button('Check composer availability').props.onClick()
  inputFor(u.tree(), 'Duration in seconds').props.onInput({ target: { value: '' } })
  assert.equal(u.button('Review target').props.disabled, true); assert.equal(u.button('Create music and place').props.disabled, true)
  assert.equal(inputFor(u.tree(), 'Duration in seconds').props.value, '')
  inputFor(u.tree(), 'Duration in seconds').props.onInput({ target: { value: '4' } })
  inputFor(u.tree(), 'Start beat').props.onInput({ target: { value: '99' } })
  assert.equal(u.button('Review target').props.disabled, true); assert.match(text(u.tree()), /Score cannot be used/)
  inputFor(u.tree(), 'Start beat').props.onInput({ target: { value: '0' } })
  assert.equal(u.button('Review target').props.disabled, false); await u.button('Review target').props.onClick()
  assert.equal(u.button('Create music and place').props.disabled, false); assert.equal(u.e.posts().length, 0)
})
test('actual first-use saved-only UI offers placement without a second compose request', async t => {
  const u = ui(t, null); u.e.current.project.assets = {}; u.e.assetReady = true
  await u.button('Check composer availability').props.onClick(); await u.button('Review target').props.onClick(); await u.button('Create music and place').props.onClick()
  assert.match(text(u.tree()), /Saved music: Original cue/); assert.match(text(u.tree()), /without rendering again/)
  assert.equal(u.button('Place saved music').props.disabled, true)
  await u.button('Review target').props.onClick(); await u.button('Place saved music').props.onClick()
  assert.deepEqual(u.e.posts().map(call => call.route), ['/api/audio/compose', '/api/audio/compose/place'])
  assert.equal(u.e.posts()[1].body.path, generated); assert.equal(Object.keys(u.e.current.project.assets).length, 1)
})
test('actual first-use keyboard handler wraps enabled focus and Escape closes without creating music', t => {
  const u = ui(t, null); u.e.current.project.assets = {}
  const dialog = nodes(u.tree()).find(node => node.props?.role === 'dialog'), previous = globalThis.document
  let focused = '', prevented = 0, stopped = 0
  const first = { matches: () => false, getClientRects: () => [1], focus: () => { focused = 'first' } }
  const disabled = { matches: () => true, getClientRects: () => [1] }
  const last = { matches: () => false, getClientRects: () => [1], focus: () => { focused = 'last' } }
  dialog.ref.current = { querySelectorAll: () => [first, disabled, last], contains: control => [first, disabled, last].includes(control) }
  globalThis.document = { activeElement: last }; t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous })
  const event = key => ({ key, shiftKey: false, preventDefault: () => prevented++, stopPropagation: () => stopped++ })
  dialog.props.onKeyDown(event('Tab')); assert.equal(focused, 'first')
  globalThis.document.activeElement = first; dialog.props.onKeyDown({ ...event('Tab'), shiftKey: true }); assert.equal(focused, 'last')
  dialog.props.onKeyDown(event(' ')); assert.equal(prevented, 2, 'Space remains available to the native summary/button control')
  dialog.props.onKeyDown(event('Escape')); assert.equal(u.f.closed, 1); assert.equal(stopped, 4); assert.equal(u.e.posts().length, 0)
})

for (const [name, setup, pattern] of [
  ['locked audio track', e => { e.current.project.tracks.find(track => track.id === 'A3').locked = true }, /locked/],
  ['occupied range', e => { e.current.project.tracks.find(track => track.id === 'A3').clips.push({ id: 'keep', kind: 'audio', src: 'ordinary.wav', start: 0, dur: 2, in: 0 }) }, /overlaps/],
]) test(`first creation refuses a ${name} before any render request or Media mutation`, async () => {
  const e = creationFixture(); setup(e); const before = copy(e.current.project); await e.ready()
  await assert.rejects(e.review(), pattern)
  assert.deepEqual(e.current.project, before); assert.equal(e.posts().length, 0); assert.equal(e.session.currentReview(), false)
})
test('creating another score shows the edited draft while keeping the previous saved score inspectable', async t => {
  const u = ui(t, null); u.e.current.project.assets = {}; u.e.assetReady = true
  await u.button('Check composer availability').props.onClick(); await u.button('Review target').props.onClick(); await u.button('Create music and place').props.onClick()
  u.button('Create another score').props.onClick()
  inputFor(u.tree(), 'Music name').props.onInput({ target: { value: 'Second cue draft' } })
  inputFor(u.tree(), 'Tempo in BPM').props.onInput({ target: { value: '100' } })
  assert.equal(text(nodes(u.tree()).find(node => node.type === 'strong')), 'Second cue draft')
  assert.match(text(u.tree()), /100 BPM/); assert.match(text(u.tree()), /"title": "Original cue"/)
  assert.match(text(u.tree()), /Saved music: Original cue/); assert.equal(u.e.posts().length, 1)
  u.button('Reuse saved music').props.onClick()
  assert.equal(text(nodes(u.tree()).find(node => node.type === 'strong')), 'Original cue')
  assert.equal(u.button('Place saved music').props.disabled, true)
})

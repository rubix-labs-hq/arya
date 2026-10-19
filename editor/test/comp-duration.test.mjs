import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { applyOps, compDuration, compView, duration, newProject, timecode } from '../core/project.js'

const coreURL = new URL('../core/project.js', import.meta.url).href
const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const playerSource = (await fs.readFile(new URL('../web/engine/player.js', import.meta.url), 'utf8'))
  .replace("'/core/project.js'", JSON.stringify(coreURL))
  .replace("'./frame.js'", JSON.stringify(moduleURL('export const neededImages=()=>new Set(); export const neededVideos=()=>[]; export const resolveTracks=()=>[]; export const drawFrame=(target,media,project,time)=>target.frames.push({project,time});')))
  .replace("'./media.js'", JSON.stringify(moduleURL('export const mediaUrl=()=>"unused";')))
const { Player } = await import(moduleURL(playerSource))
// Only DOM/audio/decoder hosts are replaced. The duration, transport and key
// handlers below are the actual production implementations, not copied branches.
const storeModule = moduleURL(`
export const store=new Proxy({}, {get:(_,key)=>globalThis.__compositionTest.store[key]});
export const time=new Proxy({}, {get:(_,key)=>globalThis.__compositionTest.time[key]});
export const viewProject=()=>globalThis.__compositionTest.view;
export const edit=ops=>globalThis.__compositionTest.edits.push(ops);
export const api=()=>{throw Error('Unexpected API request')};
export const set=()=>{throw Error('Unexpected state mutation')};
export const toast=()=>{};`)
const keysSource = (await fs.readFile(new URL('../web/ui/keys.js', import.meta.url), 'utf8'))
  .replace("'/core/project.js'", JSON.stringify(coreURL))
  .replace("'./engine-host.js'", JSON.stringify(moduleURL(`export const player=new Proxy({}, {get:(_,key)=>{const current=globalThis.__compositionTest.player;const value=current[key];return typeof value==='function'?value.bind(current):value;}});`)))
  .replace("'./store.js'", JSON.stringify(storeModule))
  .replace("'./timeline.js'", JSON.stringify(moduleURL('export const copySelection=()=>{throw Error("Unexpected clipboard operation")};')))
  .replace("'./source-media.js'", JSON.stringify(new URL('../web/ui/source-media.js', import.meta.url).href))
const { installKeys } = await import(moduleURL(keysSource))
const settle = () => new Promise(resolve => setImmediate(resolve))

function projectFixture(durationValue = 5, clips = []) {
  let project = applyOps(newProject('Main'), [{ op: 'add_title', text: 'Main', start: 0, dur: 20 }, { op: 'add_comp', name: 'Scene', ...(durationValue === undefined ? {} : { duration: durationValue }), fps: 25 }]).project
  project.comps.k1.tracks[0].clips = clips
  return project
}
function transport(project, compID = 'k1') {
  const target = { frames: [] }, clock = { currentTime: 0 }, updates = []
  const view = () => compView(project, compID)
  const player = new Player({ comp: target, media: { videos: new Map(), gc() {}, cancelSeeks() {} }, audio: { ctx: clock, async play() { return clock.currentTime }, stop() {} }, getProject: view, getProjectIdentity: () => project, onTime: time => updates.push(time) })
  return { player, target, clock, updates, view }
}
function animationHost(t) {
  const before = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame }
  globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}
  t.after(() => { for (const [key, value] of Object.entries(before)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value } })
}

test('empty composition reports its declared duration and transport timecode', () => {
  const project = projectFixture(), view = compView(project, 'k1')
  assert.equal(duration(view), 5)
  assert.equal(timecode(duration(view), view.fps), '00:00:05:00')
  assert.equal(compDuration(project.comps.k1), duration(view))
  assert.equal(duration(project), 20, 'main edit remains independent')
})
test('composition duration is authoritative for shorter and longer content', () => {
  for (const clip of [{ id: 'short', kind: 'title', start: 0.25, dur: 0.5 }, { id: 'long', kind: 'title', start: 0, dur: 8 }]) {
    const project = projectFixture(5, [clip])
    assert.equal(duration(compView(project, 'k1')), 5)
    assert.equal(duration(project), 20)
  }
})
test('legacy composition without duration uses existing content/default rules; main stays clip-driven', () => {
  const project = projectFixture(); delete project.comps.k1.duration
  assert.equal(duration(compView(project, 'k1')), 5, 'empty legacy comp uses existing five-second fallback')
  project.comps.k1.tracks[0].clips.push({ id: 'legacy', kind: 'title', start: 1.25, dur: 2.125 })
  assert.equal(duration(compView(project, 'k1')), 3.375)
  const empty = newProject('Empty'); empty.duration = 50; empty.comps = project.comps
  assert.equal(duration(empty), 0, 'root metadata and unused comps do not extend an empty main edit')
  assert.equal(duration({ ...project, compId: 'missing' }), 20, 'unknown view ID does not invent a composition duration')
})
test('selected composition views use their own boundary while root clip rounding stays unchanged', () => {
  const project = projectFixture(5)
  project.comps.k2 = { id: 'k2', duration: 2.5, fps: 24, tracks: [{ id: 'V1', clips: [] }] }
  assert.equal(duration(compView(compView(project, 'k1'), 'k2')), 2.5)
  assert.equal(duration(compView(project, 'k1')), 5)
  const root = newProject('Fractional main')
  root.tracks[0].clips = [{ start: 0.123456, dur: 1.234567 }]
  assert.equal(duration(root), 1.358)
})
test('actual transport seeks and frame steps through the empty tail, clamping at composition end', async t => {
  animationHost(t)
  const project = projectFixture(5, [{ id: 'short', kind: 'title', start: 0, dur: 0.5 }])
  const { player } = transport(project)
  assert.equal(player.end(), 5)
  player.seek(4.96); assert.equal(player.t, 4.96)
  player.step(1); assert.equal(player.t, 5)
  player.step(1); assert.equal(player.t, 5)
  player.seek(99); assert.equal(player.t, 5)
  player.seek(-1); assert.equal(player.t, 0)
  await settle()
})
test('actual forward playback continues beyond last content and pauses exactly at declared end', async t => {
  animationHost(t)
  for (const clips of [[], [{ id: 'short', kind: 'title', start: 0, dur: 0.5 }]]) {
    const { player, clock } = transport(projectFixture(5, clips))
    await player.play(1)
    clock.currentTime = 2; player.tick()
    assert.equal(player.playing, true); assert.equal(player.t, 2)
    clock.currentTime = 5.2; player.tick()
    assert.equal(player.playing, false); assert.equal(player.t, 5)
    await settle()
  }
})
test('actual playback respects a shorter declared boundary and preserves main timeline end', async t => {
  animationHost(t)
  const project = projectFixture(5, [{ id: 'long', kind: 'title', start: 0, dur: 8 }])
  const { player, clock } = transport(project)
  await player.play(1); clock.currentTime = 5; player.tick()
  assert.equal(player.playing, false); assert.equal(player.t, 5)
  const main = transport(project, null)
  await main.player.play(1); main.clock.currentTime = 8; main.player.tick()
  assert.equal(main.player.playing, true); assert.equal(main.player.end(), 20)
  main.clock.currentTime = 20; main.player.tick(); assert.equal(main.player.t, 20); assert.equal(main.player.playing, false)
  await settle()
})
test('actual End and I/O shortcuts use composition boundary without changing main duration', async t => {
  animationHost(t)
  const before = { window: globalThis.window, Element: globalThis.Element, fixture: globalThis.__compositionTest }
  let handler
  globalThis.window = { addEventListener: (kind, callback) => { assert.equal(kind, 'keydown'); handler = callback } }
  globalThis.Element = class {}
  t.after(() => { for (const key of ['window', 'Element']) { if (before[key] === undefined) delete globalThis[key]; else globalThis[key] = before[key] }; if (before.fixture === undefined) delete globalThis.__compositionTest; else globalThis.__compositionTest = before.fixture })
  const project = projectFixture(), fixture = transport(project)
  const context = { player: fixture.player, view: fixture.view(), store: { selection: [], settingsOpen: false }, time: { t: 1 }, edits: [] }
  globalThis.__compositionTest = context; installKeys()
  const press = key => { let prevented = false; handler({ key, target: { closest: () => null }, preventDefault: () => { prevented = true } }); assert.equal(prevented, true) }
  press('i'); assert.deepEqual(context.edits.pop(), { op: 'range', in: 1, out: 5 })
  press('End'); assert.equal(fixture.player.t, 5)
  context.time.t = fixture.player.t; press('o'); assert.deepEqual(context.edits.pop(), { op: 'range', in: 0, out: 5 })
  assert.equal(duration(project), 20); assert.equal(project.range, null, 'recording host does not persist or redefine range scope')
  await settle()
})

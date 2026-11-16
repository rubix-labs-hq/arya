// A reversed composition plays its picture backwards (compTime mirrors comp time). Its audio must
// play the same comp second as the picture, in both the browser engine and the native plan.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { audioPlan } from '../core/audio-plan.js'
import { compView, newProject, sourceTime } from '../core/project.js'
import { framePlan } from '../core/render-plan.js'

registerHooks({ resolve(specifier, context, next) { return next(specifier.startsWith('/core/') ? new URL(`../core/${specifier.slice(6)}`, import.meta.url).href : specifier, context) } })
const { leafTiming, planAudio, planLeaves } = await import('../web/engine/audio.js')

const comp = (id, duration, tracks) => ({ id, name: id, duration, fps: 30, width: 1920, height: 1080, tracks })

function project(compClip, inner = {}) {
  const p = newProject('Reverse comp audio')
  p.assets = { 'a.wav': { duration: 30, hasAudio: true } }
  p.comps = { k1: comp('k1', 10, [{ id: 'A1', kind: 'audio', clips: [{ id: 'voice', kind: 'audio', src: 'a.wav', start: 1, dur: 6, in: 3, speed: 1, ...inner }] }]) }
  p.tracks.find(t => t.id === 'V1').clips.push({ id: 'comp', kind: 'comp', comp: 'k1', start: 2, dur: 8, in: 0, speed: 1, ...compClip })
  return p
}

// The source second the picture implies: walk the comp clips down to k1 and read the voice clip there.
function pictureSource(p, T, path) {
  let plan = framePlan(p, T)
  for (const id of path) {
    plan = plan.layers.find(l => l.clip?.id === id)?.clip.composition
    if (!plan) return null
  }
  const view = compView(p, 'k1'), voice = view.tracks[0].clips[0]
  if (!(plan.time >= voice.start && plan.time < voice.start + voice.dur)) return null
  return sourceTime(view, voice, plan.time)
}

// The source second the browser plays at T, from the buffer position its leaf timing implies.
function browserSource(p, T) {
  const leaf = planLeaves(planAudio(p, 0)).find(l => l.clip.id === 'voice' && T >= l.from && T < l.to)
  if (!leaf) return null
  const bufferFrom = leaf.srcIn, bufferDur = leaf.clip.dur * leaf.speed
  const tm = leafTiming(leaf, { t0: 0, when: 0, bufferFrom, bufferDur })
  const r = tm.offset + (T - tm.at) * tm.playbackRate
  return leaf.reverse ? bufferFrom + bufferDur - r : bufferFrom + r
}

function nativeSource(p, T) {
  const leaves = buses => buses.flatMap(b => b.items.flatMap(i => i.kind === 'comp' ? leaves(i.buses) : [i]))
  const leaf = leaves(audioPlan(p, 0, 12).buses).find(l => l.id === 'voice' && T >= l.from && T < l.to)
  if (!leaf) return null
  assert.ok(leaf.speed > 0)
  return leaf.sourceIn + (leaf.reverse ? -1 : 1) * leaf.speed * (T - leaf.from)
}

function agree(p, path) {
  let heard = 0
  for (let T = 0.03; T < 11; T += 0.137) {
    const picture = pictureSource(p, T, path)
    const browser = browserSource(p, T), native = nativeSource(p, T)
    if (picture === null) { assert.equal(browser, null, `browser sounds at ${T}`); assert.equal(native, null, `native sounds at ${T}`); continue }
    heard++
    assert.ok(Math.abs(browser - picture) < 1e-9, `browser at ${T}: ${browser} vs picture ${picture}`)
    assert.ok(Math.abs(native - picture) < 1e-9, `native at ${T}: ${native} vs picture ${picture}`)
  }
  assert.ok(heard > 10, `only ${heard} audible samples`)
}

test('a reversed composition plays its audio backwards with its picture', () => {
  // Comp second tau = 10 - (T - 2): the voice (comp 1..7) sounds from T = 5 to 10, source 9 down to 3.
  const p = project({ reverse: true })
  agree(p, ['comp'])
  const [leaf] = planLeaves(planAudio(p, 0))
  assert.deepEqual([leaf.from, leaf.to, leaf.reverse], [5, 10, true])
  agree(project({ reverse: false }), ['comp'])
})

test('in, speed and a reversed clip inside a reversed composition match the picture', () => {
  agree(project({ reverse: true, in: 1, speed: 2, dur: 3 }), ['comp'])
  // A reversed clip inside a reversed composition plays forwards again.
  const p = project({ reverse: true }, { reverse: true, speed: 1.5, in: 2 })
  agree(p, ['comp'])
  assert.equal(planLeaves(planAudio(p, 0))[0].reverse, false)
  assert.equal(audioPlan(p, 0, 12).buses[0].items[0].buses[0].items[0].reverse, undefined)
})

test('a reversed composition nested in a reversed composition plays forwards', () => {
  const p = project({ comp: 'k2', reverse: true, dur: 9 })
  p.comps.k2 = comp('k2', 9, [{ id: 'V1', kind: 'video', clips: [{ id: 'mid', kind: 'comp', comp: 'k1', start: 0.5, dur: 8, in: 0.5, speed: 1, reverse: true }] }])
  agree(p, ['comp', 'mid'])
})

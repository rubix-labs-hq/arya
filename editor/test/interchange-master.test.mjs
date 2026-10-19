import assert from 'node:assert/strict'
import test from 'node:test'

import { fromFCPXML, fromOTIO, toFCPXML, toOTIO } from '../core/interchange.js'
import { applyOps, newProject } from '../core/project.js'

const formats = [
  ['OTIO', p => JSON.stringify(toOTIO(p)), fromOTIO],
  ['FCPXML', toFCPXML, fromFCPXML],
]

for (const [name, encode, decode] of formats) {
  test(`${name} round trip preserves master gain, effects, limiter and loudness target`, () => {
    const master = { volume: -2.5, target: -16, fx: [{ type: 'compressor', enabled: true, params: { threshold: -20, ratio: 2.5 } }], limiter: { enabled: true, ceiling: -1, release: 60, lookahead: 5 } }
    const p = applyOps(newProject('Master mix'), [
      { op: 'import', assets: { 'voice.wav': { duration: 10, hasVideo: false, hasAudio: true, channels: 2 } } },
      { op: 'append', src: 'voice.wav', track: 'A1', dur: 4, set: { fx: [{ type: 'eq', enabled: true, params: { bands: [{ type: 'highpass', freq: 80, gain: 0, q: 0.707 }] } }] } },
      { op: 'project', set: { master } },
    ]).project
    const restored = decode(encode(p))
    assert.deepEqual(restored.master, master)
    assert.deepEqual(restored.tracks.find(t => t.id === 'A1').clips[0].fx, p.tracks.find(t => t.id === 'A1').clips[0].fx)
  })

  test(`${name} imports without a saved master retain the default mix`, () => {
    const p = applyOps(newProject('Default mix'), [{ op: 'add_color', color: '#3a207d', start: 0, dur: 1 }]).project
    const restored = decode(encode(p))
    assert.equal(Object.hasOwn(restored, 'master'), false)
    assert.equal(restored.tracks.find(t => t.kind === 'video').clips[0].dur, 1)
  })
}

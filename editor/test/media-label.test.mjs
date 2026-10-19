import assert from 'node:assert/strict'
import test from 'node:test'
import { mediaDisplayModel, mediaDisplayName, mediaMatchesQuery } from '../web/ui/media-label.js'
import { musicAssetRecord, musicPlacementOps } from '../core/music-score.js'
import { applyOps, newProject } from '../core/project.js'

const src = 'media/generated/music/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/score.wav'
const score = { version: 1, title: 'The Last Ferry — Wistful Crossing', bpm: 120, lengthBeats: 28, seed: 17, room: 0.12, parts: [{ id: 'keys', instrument: 'keys', gainDb: -12, pan: 0, notes: [{ at: 0, duration: 1, pitch: 60, velocity: 0.7 }] }] }
const receipt = { path: src, asset: { hasAudio: true, hasVideo: false, channels: 2, duration: 14, codec: 'pcm_s24le' }, measurement: { samplePeakDb: -3, rmsDb: -18, samples: 14 * 48000 * 2 } }

test('actual generated score registration displays its authored title while preserving filename, duration and native source identity', () => {
  const asset = musicAssetRecord(score, receipt), before = JSON.stringify(asset)
  assert.deepEqual(mediaDisplayModel(src, asset), {
    name: 'The Last Ferry — Wistful Crossing', filename: 'score.wav', tooltip: `The Last Ferry — Wistful Crossing\n${src}`,
  })
  assert.equal(asset.duration, 14); assert.equal(JSON.stringify(asset), before)
  const project = applyOps(newProject('Music display'), musicPlacementOps(newProject('Music display'), { score, start: 0, track: 'A3', volume: 0, expectedVersion: 1 }, receipt)).project
  const clip = project.tracks.find(track => track.id === 'A3').clips[0]
  assert.equal(clip.src, src); assert.equal(clip.dur, 14); assert.equal(clip.label, score.title)
  assert.equal(mediaDisplayName(clip.src, project.assets[clip.src]), score.title)
  // Display metadata does not rename the file or claim sampled/realistic instruments.
  assert.equal(project.assets[src].generated.score.parts[0].instrument, 'keys')
  assert.equal(project.assets[src].generated.provenance, 'Locally synthesized from an original structured score; no external music model or recordings.')
})

test('different generated paths with the same score.wav filename stay distinct and searchable by title or original path', () => {
  const other = src.replace('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
  const assets = { [src]: musicAssetRecord(score, receipt), [other]: musicAssetRecord({ ...score, title: 'Harbor Departure' }, { ...receipt, path: other }) }
  const find = query => Object.entries(assets).filter(([path, asset]) => mediaMatchesQuery(path, asset, query)).map(([path]) => path)
  assert.deepEqual(find('wistful'), [src]); assert.deepEqual(find('HARBOR DEPARTURE'), [other])
  assert.deepEqual(find('score.wav'), [src, other]); assert.deepEqual(find('bbbbbbbb'), [other])
  assert.deepEqual(find('missing cue'), []); assert.deepEqual(find(''), [src, other])
})

test('ordinary media, invalid/empty name metadata and Unicode titles retain correct filename fallback and tooltip', () => {
  const raw = 'media/Interview & take 01.MOV'
  for (const asset of [{}, { name: '' }, { name: '  \n ' }, { name: null }, { name: 123 }]) {
    assert.deepEqual(mediaDisplayModel(raw, asset), { name: 'Interview & take 01.MOV', filename: 'Interview & take 01.MOV', tooltip: raw })
    assert.equal(mediaMatchesQuery(raw, asset, 'take 01.mov'), true)
  }
  const named = { name: '  夜の港 — Arrival  ' }
  assert.equal(mediaDisplayName(raw, named), '夜の港 — Arrival')
  assert.equal(mediaMatchesQuery(raw, named, '夜の港'), true)
  assert.equal(mediaMatchesQuery(raw, named, 'ARRIVAL'), true)
  assert.equal(mediaDisplayModel(raw, named).tooltip, `夜の港 — Arrival\n${raw}`)
  assert.equal(named.name, '  夜の港 — Arrival  ')
})

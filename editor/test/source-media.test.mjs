import assert from 'node:assert/strict'
import test from 'node:test'
import { sourceAudioWindow } from '../web/ui/source-media.js'

test('audio source seeks preserve source time across bounded preview windows', () => {
  const before = sourceAudioWindow('media/a long & unusual.aiff', 970.25, 299.99)
  const boundary = sourceAudioWindow('media/a long & unusual.aiff', 970.25, 300)
  const last = sourceAudioWindow('media/a long & unusual.aiff', 970.25, 969)
  assert.deepEqual([before.from, before.duration, before.time], [0, 300, 299.99])
  assert.deepEqual([boundary.from, boundary.duration, boundary.time], [300, 300, 0])
  assert.deepEqual([last.from, last.duration, last.time], [900, 70.25, 69])
  assert.equal(new URL(last.url, 'http://localhost').searchParams.get('src'), 'media/a long & unusual.aiff')
  assert.equal(last.from + last.time, 969)
  const end = sourceAudioWindow('media/a.aiff', 600, 600)
  assert.deepEqual([end.from, end.duration, end.time], [300, 300, 300])
})

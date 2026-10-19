import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createOutputStream, OUTPUT_RECORD_BYTES, OUTPUT_TOTAL_BYTES } from '../agent/output-stream.mjs'
import { startBridge } from '../agent/bridge.mjs'
import { fixtureSharing } from './fixtures/sharing-fixture.mjs'
const here = path.dirname(fileURLToPath(import.meta.url))

test('drains coalesced records using byte budgets per record, not per chunk', () => {
  const records = [], stream = createOutputStream(line => records.push(line), { maxRecordBytes: 12, maxTotalBytes: 10000 })
  stream.push(Buffer.from('123456789012\n'.repeat(100)))
  assert.equal(records.length, 100); assert.equal(stream.pendingBytes, 0)
  stream.finish(); assert.equal(stream.pendingBytes, 0)
})
test('split UTF-8 and final record without newline are preserved', () => {
  const lines = [], stream = createOutputStream(line => lines.push(line))
  for (const byte of Buffer.from('café 🎬\n最後')) stream.push(Buffer.from([byte]))
  assert.deepEqual(lines, ['café 🎬']); stream.finish(); assert.deepEqual(lines, ['café 🎬', '最後'])
})
test('record cap uses UTF-8 bytes and rejects incomplete or newline-terminated overflow', () => {
  for (const suffix of ['', '\n']) {
    const stream = createOutputStream(() => assert.fail('Oversized record cannot publish'), { maxRecordBytes: 4 })
    stream.push(Buffer.from('éé')); assert.equal(stream.pendingBytes, 4)
    assert.throws(() => stream.push(Buffer.from('x' + suffix)), /record.*limit/)
    stream.discard(); assert.equal(stream.pendingBytes, 0)
  }
})
test('cumulative raw bound applies even when each record is discarded', () => {
  const stream = createOutputStream(() => {}, { maxRecordBytes: 8, maxTotalBytes: 10 })
  stream.push(Buffer.from('abc\nabc\n')); assert.throws(() => stream.push(Buffer.from('abc\n')), /cumulative.*limit/)
  stream.discard(); assert.equal(stream.pendingBytes, 0)
  assert.equal(OUTPUT_RECORD_BYTES, 8 * 1024 * 1024); assert.equal(OUTPUT_TOTAL_BYTES, 64 * 1024 * 1024)
})
test('terminal callback discards remaining coalesced records and pending bytes', () => {
  let calls = 0
  const stream = createOutputStream(() => { calls++; return false })
  stream.push(Buffer.from('done\nlate\nunfinished')); stream.push(Buffer.from('ignored')); stream.finish()
  assert.equal(calls, 1); assert.equal(stream.pendingBytes, 0)
})

async function request(bridge, method, route, body) {
  const reply = await fetch(new URL(route, bridge.endpoint), { method, headers: { authorization: `Bearer ${bridge.token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) })
  return { status: reply.status, body: await reply.json() }
}
async function fixture(t, mode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'arya-stream-')), bin = path.join(root, 'bin'), marker = path.join(root, 'pid')
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, 'codex'), `#!${process.execPath}\n` + await fs.readFile(path.join(here, 'fixtures/agent-output-stream.mjs'), 'utf8'), { mode: 0o700 })
  const original = { PATH: process.env.PATH, ARYA_STREAM_CASE: process.env.ARYA_STREAM_CASE, ARYA_STREAM_MARKER: process.env.ARYA_STREAM_MARKER }
  process.env.PATH = bin + path.delimiter + original.PATH
  process.env.ARYA_STREAM_CASE = mode; process.env.ARYA_STREAM_MARKER = marker
  let bridge
  const id = randomUUID()
  t.after(async () => {
    await bridge?.close()
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await fs.rm(root, { recursive: true, force: true })
  })
  bridge = await startBridge({ catalogOptions: { providerStatus: async () => [{id:'codex',installed:true,authenticated:true}], executable: async () => null } })
  assert.equal((await request(bridge, 'POST', '/v1/runs', { id, provider: 'codex', text: 'Inspect the edited project.', sharing: fixtureSharing(bridge.endpoint, [{provider:'codex',model:''}]) })).status, 201)
  return { bridge, id, marker }
}
async function collect(bridge, id, onTool) {
  const events = []; let cursor = 0
  for (let n = 0; n < 600; n++) {
    const reply = await request(bridge, 'GET', `/v1/runs/${id}/events?after=${cursor}`); assert.equal(reply.status, 200)
    for (const event of reply.body.events) {
      events.push(event); cursor = event.seq
      if (event.type === 'tool') await onTool?.(event)
      if (['done', 'error'].includes(event.type)) return events
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail('Streaming fixture timed out')
}
test('actual fake Codex echoes three maximum accepted MCP images and completes without retaining image echoes', async t => {
  const { bridge, id } = await fixture(t, 'images')
  const image = { image: { mediaType: 'image/png', data: Buffer.alloc(4 * 1024 * 1024).toString('base64') } }
  assert.equal(image.image.data.length, 5592408)
  const events = await collect(bridge, id, async event => {
    assert.equal((await request(bridge, 'POST', `/v1/runs/${id}/tools/${event.callID}`, image)).status, 200)
  })
  assert.equal(events.filter(e => e.type === 'tool').length, 3)
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.some(e => e.type === 'error'), false)
  assert.equal(events.find(e => e.type === 'text').text, 'Inspected three frames.')
  assert.ok(Buffer.byteLength(JSON.stringify(events)) < 4096, 'MCP image echoes cannot become retained events')
})
for (const [mode, text] of [['coalesced', 'Complete records drained.'], ['unicode-tail', 'Edited café 🎬'], ['malformed', 'Valid record after malformed output.']]) {
  test(`actual fake Codex handles ${mode}`, async t => {
    const { bridge, id } = await fixture(t, mode), events = await collect(bridge, id)
    assert.equal(events.at(-1).type, 'done'); assert.equal(events.find(e => e.type === 'text').text, text)
  })
}
for (const [mode, reason] of [['oversized-record', /record.*limit/], ['raw-flood', /cumulative.*limit/]]) {
  test(`actual fake Codex rejects ${mode} and keeps bridge responsive`, async t => {
    const { bridge, id } = await fixture(t, mode), events = await collect(bridge, id)
    assert.equal(events.at(-1).type, 'error'); assert.match(events.at(-1).message, reason)
    assert.ok(Buffer.byteLength(JSON.stringify(events)) < 4096)
    assert.equal((await request(bridge, 'GET', `/v1/runs/${id}/events`)).status, 200)
  })
}
test('actual cancellation during a partial large record keeps one terminal error and stops the owned provider', async t => {
  const { bridge, id, marker } = await fixture(t, 'hold')
  let pid
  for (let n = 0; n < 300; n++) { try { pid = Number(await fs.readFile(marker, 'utf8')); break } catch {}; await new Promise(resolve => setTimeout(resolve, 20)) }
  assert.ok(Number.isSafeInteger(pid)); assert.equal((await request(bridge, 'POST', `/v1/runs/${id}/cancel`, {})).status, 200)
  const events = await collect(bridge, id); assert.equal(events.filter(event => ['done', 'error'].includes(event.type)).length, 1); assert.equal(events.at(-1).type, 'error')
  await bridge.close()
  assert.throws(() => process.kill(pid, 0), /ESRCH/)
})

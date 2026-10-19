import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Readable, PassThrough } from 'node:stream'
import test from 'node:test'
import { storeMediaUpload } from '../core/media-upload.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-upload-integrity-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const original = '{"name":"Original project"}\n'
  fs.writeFileSync(path.join(root, 'reel.project.json'), original)
  const request = (bytes, headers = {}) => Object.assign(Readable.from([Buffer.from(bytes)]), { headers })
  const query = (name = 'clip.mov', dir) => new URLSearchParams({ name, ...(dir === undefined ? {} : { dir }) })
  return { root, request, query, original }
}

function entries(root) { return fs.existsSync(path.join(root, 'media')) ? fs.readdirSync(path.join(root, 'media')).sort() : [] }

test('upload publishes complete bytes under media and preserves the project original', async t => {
  const f = fixture(t), bytes = 'complete source bytes'
  const result = await storeMediaUpload(f.root, f.request(bytes, { 'content-length': String(bytes.length) }), f.query())
  assert.equal(result.path, 'media/clip.mov')
  assert.equal(fs.readFileSync(path.join(f.root, result.path), 'utf8'), bytes)
  assert.deepEqual(entries(f.root), ['clip.mov'])
  assert.equal(fs.readFileSync(path.join(f.root, 'reel.project.json'), 'utf8'), f.original)
})

test('same-name uploads choose unique names without replacing prior media', async t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'media')); fs.writeFileSync(path.join(f.root, 'media/clip.mov'), 'original media')
  const result = await storeMediaUpload(f.root, f.request('new media'), f.query())
  assert.equal(result.path, 'media/clip-1.mov')
  assert.equal(fs.readFileSync(path.join(f.root, 'media/clip.mov'), 'utf8'), 'original media')
  assert.equal(fs.readFileSync(path.join(f.root, result.path), 'utf8'), 'new media')
})

test('concurrent same-name uploads use no-replace publication and each retains its bytes', async t => {
  const f = fixture(t), contents = Array.from({ length: 20 }, (_, i) => `media ${i}`)
  const results = await Promise.all(contents.map(value => storeMediaUpload(f.root, f.request(value), f.query())))
  assert.equal(new Set(results.map(result => result.path)).size, 20)
  for (let i = 0; i < results.length; i++) assert.equal(fs.readFileSync(path.join(f.root, results[i].path), 'utf8'), contents[i])
  assert.equal(entries(f.root).length, 20)
})

test('nested media destination remains supported', async t => {
  const f = fixture(t), result = await storeMediaUpload(f.root, f.request('camera'), f.query('shot.mov', 'media/camera-2'))
  assert.equal(result.path, 'media/camera-2/shot.mov')
})

for (const dir of ['..', '../outside', 'media/../outside', '/tmp', '.reel', 'media/.reel', 'media//nested', 'media/']) test(`unsafe upload directory is rejected: ${dir}`, async t => {
  const f = fixture(t)
  await assert.rejects(storeMediaUpload(f.root, f.request('data'), f.query('shot.mov', dir)), /project media folder/)
  assert.deepEqual(fs.readdirSync(f.root), ['reel.project.json'])
})

for (const location of ['media', 'media/nested']) test(`symbolic ${location} directory cannot redirect an upload`, async t => {
  const f = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-upload-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'original.mov'), 'outside original')
  if (location !== 'media') fs.mkdirSync(path.join(f.root, 'media'))
  fs.symlinkSync(outside, path.join(f.root, location))
  await assert.rejects(storeMediaUpload(f.root, f.request('data'), f.query('shot.mov', location)), /symbolic links/)
  assert.deepEqual(fs.readdirSync(outside), ['original.mov'])
  assert.equal(fs.readFileSync(path.join(outside, 'original.mov'), 'utf8'), 'outside original')
})

test('a symlink at the requested filename is preserved and rejects publication', async t => {
  const f = fixture(t)
  fs.mkdirSync(path.join(f.root, 'media')); fs.writeFileSync(path.join(f.root, 'original.mov'), 'original')
  fs.symlinkSync('../original.mov', path.join(f.root, 'media/clip.mov'))
  await assert.rejects(storeMediaUpload(f.root, f.request('new'), f.query()), /symbolic links/)
  assert.equal(fs.lstatSync(path.join(f.root, 'media/clip.mov')).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(path.join(f.root, 'original.mov'), 'utf8'), 'original')
  assert.deepEqual(entries(f.root), ['clip.mov'])
})

for (const mode of ['empty', 'declared too big', 'undeclared too big', 'truncated declared', 'stream failure']) test(`failed ${mode} upload leaves no published or staging file`, async t => {
  const f = fixture(t), options = { maxBytes: 8 }
  let request = f.request('bytes')
  if (mode === 'empty') request = f.request('')
  if (mode === 'declared too big') request = f.request('bytes', { 'content-length': '9' })
  if (mode === 'undeclared too big') request = f.request('123456789')
  if (mode === 'truncated declared') request = f.request('bytes', { 'content-length': '7' })
  if (mode === 'stream failure') {
    request = Object.assign(new PassThrough(), { headers: {} })
    setImmediate(() => { request.write('part'); request.destroy(Error('fixture disconnect')) })
  }
  await assert.rejects(storeMediaUpload(f.root, request, f.query(), options))
  assert.deepEqual(entries(f.root), [])
  assert.equal(fs.readFileSync(path.join(f.root, 'reel.project.json'), 'utf8'), f.original)
})

test('a directory changed during upload cannot receive a completed publication', async t => {
  const f = fixture(t), outside = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-upload-race-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outside, 'clip.mov'), 'outside original')
  const request = Object.assign(new PassThrough(), { headers: {} })
  const outcome = storeMediaUpload(f.root, request, f.query())
  request.write('pending upload')
  await new Promise(resolve => setImmediate(resolve))
  fs.renameSync(path.join(f.root, 'media'), path.join(f.root, 'owned-staging-moved'))
  fs.symlinkSync(outside, path.join(f.root, 'media'))
  request.end()
  await assert.rejects(outcome, /symbolic links|changed during upload/)
  assert.deepEqual(fs.readdirSync(outside), ['clip.mov'])
  assert.equal(fs.readFileSync(path.join(outside, 'clip.mov'), 'utf8'), 'outside original')
  assert.ok(fs.readdirSync(path.join(f.root, 'owned-staging-moved')).every(name => name.endsWith('.part')), 'displaced owned staging is left for review rather than following a substituted directory')
})

test('read-only media folder rejects upload without modifying existing media', async t => {
  const f = fixture(t), media = path.join(f.root, 'media')
  fs.mkdirSync(media); fs.writeFileSync(path.join(media, 'original.mov'), 'original')
  fs.chmodSync(media, 0o500)
  try {
    await assert.rejects(storeMediaUpload(f.root, f.request('data'), f.query()))
    assert.deepEqual(fs.readdirSync(media), ['original.mov'])
    assert.equal(fs.readFileSync(path.join(media, 'original.mov'), 'utf8'), 'original')
  } finally { fs.chmodSync(media, 0o700) }
})

test('actual server upload branch returns a successful path over an owned ephemeral HTTP server', async t => {
  const f = fixture(t), source = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8')
  const a = source.indexOf("    if (url.pathname === '/api/upload' && req.method === 'POST') {")
  const b = source.indexOf("    if (url.pathname === '/api/audio')", a)
  assert.ok(a >= 0 && b > a)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const route = new AsyncFunction('req', 'res', 'url', 'ROOT', 'send', 'storeMediaUpload', source.slice(a, b))
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const server = http.createServer((req, res) => route(req, res, new URL(req.url, 'http://fixture.invalid'), f.root, send, storeMediaUpload).catch(error => send(res, 500, { error: error.message })))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  globalThis[Symbol.for('arya.verification.registerOwnedEphemeralHTTP')]?.(server)
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/upload?name=clip.mov`, { method: 'POST', body: 'actual HTTP bytes' })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { path: 'media/clip.mov' })
  assert.equal(fs.readFileSync(path.join(f.root, 'media/clip.mov'), 'utf8'), 'actual HTTP bytes')
})

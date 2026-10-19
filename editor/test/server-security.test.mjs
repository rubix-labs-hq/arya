import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { spawn } from 'node:child_process'
import http from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { newProject } from '../core/project.js'
import { redact } from '../agent/protocol.mjs'

// Findings from the October 9 security review, each checked against a real server: a web
// page must not crash or drive the editor, project files must not run as the editor, and
// media reads must stay inside the project or on media files the project chose.

async function unusedPort() { const l = net.createServer(); l.listen(0, '127.0.0.1'); await once(l, 'listening'); const { port } = l.address(); await new Promise(r => l.close(r)); return port }
const pause = ms => new Promise(r => setTimeout(r, ms))

async function server(t, root) {
  const port = await unusedPort(), base = `http://127.0.0.1:${port}`
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url)), '--root', root, '--port', String(port)], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', d => { output += d }); child.stderr.on('data', d => { output += d })
  const ended = new Promise(r => child.once('exit', r))
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([ended, pause(3000)]) } })
  const request = (route, { method = 'GET', headers = {}, body } = {}) => fetch(base + route, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  for (let i = 0; ; i++) {
    try { if ((await request('/api/project')).ok) break } catch {}
    if (i > 120) assert.fail(`server did not start: ${output}`)
    await pause(100)
  }
  // fetch() sets its own Sec-Fetch-Mode, so browser metadata is sent through node:http.
  const raw = (route, headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers }, response => { response.resume(); response.once('end', () => resolve({ status: response.statusCode, headers: response.headers })) }).once('error', reject)
  })
  return { request, raw, alive: () => child.exitCode === null && child.signalCode === null, output: () => output }
}

async function folder(t) {
  const parent = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'arya-security-')))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  const root = path.join(parent, 'project'), outside = path.join(parent, 'outside')
  await fs.mkdir(path.join(root, 'media'), { recursive: true }); await fs.mkdir(outside)
  return { root, outside }
}

test('a directory request or bad range answers without crashing the server', { timeout: 30000 }, async t => {
  const { root } = await folder(t)
  await fs.writeFile(path.join(root, 'media/clip.mp4'), Buffer.alloc(1000, 7))
  const s = await server(t, root)
  for (const route of ['/ui', '/cache/', '/vendor/preact']) assert.equal((await s.request(route)).status, 404, route)
  const backwards = await s.request('/media?path=media%2Fclip.mp4', { headers: { range: 'bytes=100-50' } })
  assert.equal(backwards.status, 416); assert.equal(backwards.headers.get('content-range'), 'bytes */1000')
  const malformed = await s.request('/media?path=media%2Fclip.mp4', { headers: { range: 'bytes=x-y' } })
  assert.equal(malformed.status, 200); assert.equal((await malformed.arrayBuffer()).byteLength, 1000)
  const partial = await s.request('/media?path=media%2Fclip.mp4', { headers: { range: 'bytes=990-' } })
  assert.equal(partial.status, 206); assert.equal((await partial.arrayBuffer()).byteLength, 10)
  assert.ok(s.alive(), s.output())
})

test('another site may open the editor page but not load media or call the API', { timeout: 30000 }, async t => {
  const { root } = await folder(t)
  await fs.writeFile(path.join(root, 'media/clip.mp4'), 'media bytes')
  const s = await server(t, root)
  const crossSite = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' }
  const navigation = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }
  for (const route of ['/api/project', '/api/audio?src=media%2Fclip.mp4&in=0&dur=1', '/media?path=media%2Fclip.mp4', '/ui']) assert.equal((await s.raw(route, crossSite)).status, 403, route)
  assert.equal((await s.raw('/api/project', { ...crossSite, 'sec-fetch-site': 'same-site' })).status, 403)
  for (const route of ['/api/project', '/media?path=media%2Fclip.mp4']) assert.equal((await s.raw(route, navigation)).status, 403, route)
  const page = await s.raw('/', navigation)
  assert.equal(page.status, 200); assert.equal(page.headers['content-security-policy'], "frame-ancestors 'none'")
  assert.notEqual((await s.raw('/api/figma/callback?code=x&state=y', navigation)).status, 403)
  assert.equal((await s.raw('/?worker=1', navigation)).status, 403, 'a query can turn the page into a render worker')
  assert.equal((await s.raw('/api/project', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' })).status, 200)
  assert.equal((await s.raw('/api/project', {})).status, 200, 'local tools send no fetch metadata')
})

test('analysis settings must be bounded numbers before they reach an ffmpeg filter', { timeout: 30000 }, async t => {
  const { root, outside } = await folder(t)
  await fs.writeFile(path.join(root, 'media/clip.mp4'), 'not decoded')
  const s = await server(t, root)
  const target = path.join(outside, 'written.txt')
  for (const body of [{ kind: 'scenes', threshold: `10,metadata=mode=print:file=${target}` }, { kind: 'silence', min: '1,ametadata=print:file=x' }, { kind: 'silence', noise: 5 }]) {
    const response = await s.request('/api/analyze', { method: 'POST', body: { src: 'media/clip.mp4', ...body } })
    assert.equal(response.status, 500, JSON.stringify(body)); assert.match((await response.json()).error, /must be a number from/)
  }
  await assert.rejects(fs.access(target))
})

// Registering media needs the macOS atomic project writer.
test('media reads stay inside the project or on media files the project chose', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const { root, outside } = await folder(t)
  const project = newProject({ name: 'Security fixture' })
  writeFileSync(path.join(root, 'reel.project.json'), JSON.stringify(project, null, 2))
  await fs.writeFile(path.join(outside, 'secret.txt'), 'private notes')
  await fs.writeFile(path.join(outside, 'footage.mp4'), 'external footage')
  await fs.writeFile(path.join(root, 'notes.html'), '<script>parent.location="x"</script>')
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'media/link.txt'))
  await fs.symlink(path.join(outside, 'footage.mp4'), path.join(root, 'media/linked.mp4'))
  await fs.writeFile(path.join(outside, 'look.cube'), 'LUT_3D_SIZE 2')
  await fs.writeFile(path.join(outside, 'tape.mpg'), 'mpeg program stream')
  await fs.writeFile(path.join(outside, 'app.ts'), 'export const key = "TYPESCRIPT-SOURCE-MARKER"')
  await fs.mkdir(path.join(root, '.reel/cache'), { recursive: true })
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, '.reel/cache/leak.txt'))
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, '.reel/cache/.missing'))
  await fs.writeFile(path.join(outside, 'module.mts'), 'export const value = 1\n'.repeat(20))
  const stream = Buffer.alloc(376); stream[0] = 0x47; stream[188] = 0x47
  await fs.writeFile(path.join(outside, 'camera.mts'), stream)
  await fs.symlink(path.join(outside, 'look.cube'), path.join(root, 'media/look.cube'))
  const s = await server(t, root)
  const registered = await s.request('/api/ops', { method: 'POST', body: { ops: [{ op: 'import', assets: { [path.join(outside, 'secret.txt')]: {}, [path.join(outside, 'footage.mp4')]: {}, [path.join(outside, 'later.txt')]: {}, [path.join(outside, 'tape.mpg')]: {}, [path.join(outside, 'app.ts')]: {}, [path.join(outside, 'module.mts')]: {}, [path.join(outside, 'camera.mts')]: {} } }] } })
  assert.equal(registered.status, 200, await registered.clone().text())
  const media = rel => s.request(`/media?path=${encodeURIComponent(rel)}`)
  for (const rel of [path.join(outside, 'secret.txt'), 'media/link.txt', '/etc/hosts', path.join(outside, 'app.ts')]) {
    const response = await media(rel)
    assert.notEqual(response.status, 200, rel); assert.doesNotMatch(await response.text(), /private notes|localhost|TYPESCRIPT-SOURCE-MARKER/)
  }
  assert.equal(await (await media(path.join(outside, 'footage.mp4'))).text(), 'external footage')
  assert.equal(await (await media('media/linked.mp4')).text(), 'external footage')
  assert.equal(await (await media('media/look.cube')).text(), 'LUT_3D_SIZE 2')
  assert.equal(await (await media(path.join(outside, 'tape.mpg'))).text(), 'mpeg program stream')
  for (const route of ['/cache/leak.txt', '/cache/.missing', '/cache/does-not-exist', '/cache/%E0%A4%A']) {
    const leaked = await s.request(route)
    assert.equal(leaked.status, 404, route); assert.doesNotMatch(await leaked.text(), /private notes/)
  }
  assert.notEqual((await media(path.join(outside, 'module.mts'))).status, 200, 'a TypeScript .mts outside is refused')
  assert.equal((await media(path.join(outside, 'camera.mts'))).status, 200, 'a transport stream .mts outside is served')
  const missing = await media(path.join(outside, 'later.txt'))
  assert.notEqual(missing.status, 200, 'a missing outside path is refused')
  assert.match(await missing.text(), /outside the project/, 'by the path check, not only because the file is absent')
  await fs.writeFile(path.join(outside, 'later.txt'), 'created after registration')
  assert.notEqual((await media(path.join(outside, 'later.txt'))).status, 200, 'and stays refused once created')
  const page = await media('notes.html')
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff'); assert.match(page.headers.get('content-security-policy'), /^sandbox;/)
  // Interchange reads and Reveal/Open follow no symlink out of the project, and Open launches nothing.
  await fs.writeFile(path.join(outside, 'cut.otio'), '{"OTIO_SCHEMA":"Timeline.1","tracks":{"children":[]}}')
  await fs.symlink(path.join(outside, 'cut.otio'), path.join(root, 'linked.otio'))
  const linked = await s.request('/api/interchange/import', { method: 'POST', body: { path: 'linked.otio' } })
  assert.equal(linked.status, 500); assert.match((await linked.json()).error, /outside the project/)
  await fs.writeFile(path.join(outside, 'Info.fcpxml'), '<?xml version="1.0"?><fcpxml version="1.10"><resources/></fcpxml>')
  await fs.mkdir(path.join(root, 'cut.fcpxmld'))
  await fs.symlink(path.join(outside, 'Info.fcpxml'), path.join(root, 'cut.fcpxmld/Info.fcpxml'))
  const bundle = await s.request('/api/interchange/import', { method: 'POST', body: { path: 'cut.fcpxmld' } })
  assert.equal(bundle.status, 500, 'a bundle whose Info.fcpxml links outside is refused'); assert.match((await bundle.json()).error, /outside the project/)
  await fs.writeFile(path.join(outside, 'run.command'), '#!/bin/sh\ntouch ran\n', { mode: 0o755 })
  await fs.symlink(path.join(outside, 'run.command'), path.join(root, 'renders.command'))
  const opened = await s.request('/api/reveal', { method: 'POST', body: { path: 'renders.command', open: true } })
  assert.equal(opened.status, 500); assert.match((await opened.json()).error, /outside the project/)
  await fs.writeFile(path.join(root, 'local.command'), '#!/bin/sh\ntouch ran\n', { mode: 0o755 })
  const script = await s.request('/api/reveal', { method: 'POST', body: { path: 'local.command', open: true } })
  assert.equal(script.status, 500); assert.match((await script.json()).error, /Only a project file/)
  // A non-executable Terminal settings file can still carry a command; only Arya's file kinds open.
  await fs.writeFile(path.join(root, 'startup.terminal'), '<plist/>')
  const terminal = await s.request('/api/reveal', { method: 'POST', body: { path: 'startup.terminal', open: true } })
  assert.equal(terminal.status, 500); assert.match((await terminal.json()).error, /Only a project file/)
  const listing = await s.request(`/api/files?dir=${encodeURIComponent('..')}`)
  assert.equal(listing.status, 500); assert.match((await listing.json()).error, /outside the project/)
})

test('chat redaction covers common provider, Figma and cloud credentials without eating prose', () => {
  for (const secret of ['figd_ABCDEFGHIJKLMNOPQRSTU', 'ghp_abcdefghijklmnopqrstuvwxyz123456', 'github_pat_ABCDEFGHIJKLMNOPQRSTUVWX', 'xoxb-1234567890-abcdef', 'AKIAABCDEFGHIJKLMNOP', 'AIzaSyA1234567890abcdefghijklmnopqrstu', 'sk-ant-abcdefghijklmnop'])
    assert.equal(redact(`use ${secret} now`), 'use [redacted] now', secret)
  assert.equal(redact('password=hunter22 and api_key: "abc defgh"'), 'password=[redacted] and api_key: [redacted]')
  for (const prose of ['Here is the secret: keep cuts short', 'The token count is fine', 'Set the password later']) assert.equal(redact(prose), prose)
})

test('a Figma asset redirect cannot move to another host', { skip: process.platform !== 'darwin', timeout: 30000 }, async t => {
  const { root } = await folder(t)
  writeFileSync(path.join(root, 'reel.project.json'), JSON.stringify(newProject({ name: 'Redirect fixture' }), null, 2))
  let reached = 0
  const target = http.createServer((_req, res) => { reached++; res.end('PNG') })
  target.listen(0, '127.0.0.1'); await once(target, 'listening'); t.after(() => target.close())
  const hop = http.createServer((req, res) => { res.writeHead(302, { location: `http://${req.url === '/port.png' ? '127.0.0.1' : 'localhost'}:${target.address().port}/image.png` }); res.end() })
  hop.listen(0, '127.0.0.1'); await once(hop, 'listening'); t.after(() => hop.close())
  const s = await server(t, root)
  const response = await s.request('/api/figma/import-mcp', { method: 'POST', body: { xml: '<frame id="1:1" name="Frame" width="10" height="10" />', assets: { '1:2': `http://127.0.0.1:${hop.address().port}/asset.png`, '1:3': `http://127.0.0.1:${hop.address().port}/port.png` } } })
  const body = JSON.stringify(await response.json())
  assert.equal(reached, 0, 'no redirect target was contacted')
  assert.match(body, /refusing a redirect from 127\.0\.0\.1:\d+ to localhost:\d+/)
  assert.match(body, /refusing a redirect from 127\.0\.0\.1:\d+ to 127\.0\.0\.1:\d+/, 'another port on the same host is refused too')
})

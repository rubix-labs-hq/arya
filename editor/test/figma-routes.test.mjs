// node --test editor/test
// Runs the Reel server (editor/server.mjs) against a local fake Figma API, end to end:
// personal-token and OAuth (PKCE) sign-in, token storage, frame listing with thumbnails,
// import as a composition, Smart Animate, and the Figma MCP import path.
//
// REEL_TEST_SCRATCH picks the scratch folder (default: a temp dir); REEL_TEST_PORT the port (4903).
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures', 'figma')
const SERVER = path.join(HERE, '..', 'server.mjs')
const PORT = Number(process.env.REEL_TEST_PORT ?? 4903)
const BASE = `http://127.0.0.1:${PORT}`
const SCRATCH = process.env.REEL_TEST_SCRATCH ?? path.join(os.tmpdir(), `reel-figma-test-${process.pid}`)
const ROOT = path.join(SCRATCH, 'project')
const CONFIG = path.join(SCRATCH, 'config')
const KEY = 'Fk7qLowerThirdsReel'

const PAT = 'figd_TEST_personal_token_7f3a9c1e2b'
const SECRET = 'oauth-client-secret-5d8e1f'
const CLIENT_ID = 'reel-test-client'

const load = name => JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'))
const A = load('lower-third-a.nodes.json')
const B = load('lower-third-b.nodes.json')
const FILE = load('file.depth2.json')
const ME = load('me.json')

// ---------------------------------------------------------------- a fake Figma API

function png(w, h, rgba) {
  const row = w * 4 + 1
  const raw = Buffer.alloc(row * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgba, y * row + 1 + x * 4)
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))

    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 6, 0, 0, 0], 8)

  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const index = new Map()
const indexTree = n => {
  index.set(n.id, n)
  for (const c of n.children ?? []) indexTree(c)
}
indexTree(A.nodes['12:3'].document)
indexTree(B.nodes['12:40'].document)

// A title card whose background is an image fill (4:3 photo in a 16:9 frame, FILL), with a
// headline and a logo whose render URL has expired.
const box = (x, y, w, h) => ({ absoluteBoundingBox: { x, y, width: w, height: h }, absoluteRenderBounds: { x, y, width: w, height: h }, relativeTransform: [[1, 0, x], [0, 1, y - 2000]], size: { x: w, y: h } })
const white = { blendMode: 'NORMAL', type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }
const HERO = {
  id: '40:1', name: 'Hero', type: 'FRAME', blendMode: 'PASS_THROUGH', clipsContent: true, ...box(0, 2000, 1280, 720), relativeTransform: [[1, 0, 0], [0, 1, 2000]],
  fills: [{ blendMode: 'NORMAL', type: 'IMAGE', scaleMode: 'FILL', imageRef: 'f00dfeed0123456789abcdef0123456789abcdef', filters: {} }], strokes: [], strokeWeight: 1, strokeAlign: 'INSIDE', effects: [],
  children: [
    { id: '40:2', name: 'Headline', type: 'TEXT', blendMode: 'PASS_THROUGH', ...box(64, 2560, 300, 72), characters: 'Reel 3', style: { fontFamily: 'Inter', fontWeight: 800, fontSize: 60, textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP', letterSpacing: 0, lineHeightPx: 72, textAutoResize: 'WIDTH_AND_HEIGHT' }, fills: [white], strokes: [], effects: [], characterStyleOverrides: [], styleOverrideTable: {} },
    { id: '40:3', name: 'Logo', type: 'VECTOR', blendMode: 'PASS_THROUGH', ...box(1120, 2040, 96, 96), fills: [white], strokes: [], effects: [] },
  ],
}
indexTree(HERO)

const GEOMETRY_ONLY = ['relativeTransform', 'size', 'fillGeometry', 'strokeGeometry']
function shaped(node, { depth, geometry }) {
  const copy = JSON.parse(JSON.stringify(node))
  const walk = (n, level) => {
    if (geometry !== 'paths') for (const k of GEOMETRY_ONLY) delete n[k]
    if (depth !== undefined && level >= depth) delete n.children
    for (const c of n.children ?? []) walk(c, level + 1)
  }
  walk(copy, 0)

  return copy
}

const fake = {
  requests: [],
  pats: new Set([PAT]),
  access: new Set(),
  refresh: new Map(), // refresh token → user
  codes: new Map(), // code → { challenge, redirectUri }
  refreshCalls: 0,
  throttleImagesOnce: false,
  issued: 0,
}

function authorized(req) {
  const pat = req.headers['x-figma-token']
  if (pat) return fake.pats.has(pat)
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')

  return Boolean(m && fake.access.has(m[1]))
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function bodyOf(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)

  return Buffer.concat(chunks).toString('utf8')
}

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function basicOk(req) {
  return req.headers.authorization === `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`
}

function issue() {
  fake.issued++
  const access = `figu_access_${fake.issued}_${Math.random().toString(36).slice(2)}`
  fake.access.add(access)

  return access
}

const fakeServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://fake')
  fake.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers } })
  const files = /^\/v1\/files\/([^/]+)(\/nodes|\/images)?$/.exec(url.pathname)
  if (url.pathname === '/v1/oauth/token' && req.method === 'POST') {
    const form = new URLSearchParams(await bodyOf(req))
    if (!basicOk(req)) return json(res, 401, { error: true, message: 'bad client credentials' })
    const flow = fake.codes.get(form.get('code'))
    if (!flow || form.get('grant_type') !== 'authorization_code' || form.get('redirect_uri') !== flow.redirectUri) return json(res, 400, { error: true, message: 'invalid grant' })
    if (b64url(createHash('sha256').update(form.get('code_verifier') ?? '').digest()) !== flow.challenge) return json(res, 400, { error: true, message: 'code_verifier does not match code_challenge' })
    fake.codes.delete(form.get('code'))
    const refresh = `figr_refresh_${Math.random().toString(36).slice(2)}`
    fake.refresh.set(refresh, true)
    // A short-lived token, so the next call has to renew it.
    return json(res, 200, { user_id_string: ME.id, access_token: issue(), token_type: 'bearer', expires_in: 60, refresh_token: refresh })
  }
  if (url.pathname === '/v1/oauth/refresh' && req.method === 'POST') {
    const form = new URLSearchParams(await bodyOf(req))
    if (!basicOk(req) || !fake.refresh.has(form.get('refresh_token'))) return json(res, 400, { error: true, message: 'invalid refresh token' })
    fake.refreshCalls++

    return json(res, 200, { access_token: issue(), token_type: 'bearer', expires_in: 7776000 })
  }
  if (url.pathname.startsWith('/render/') || url.pathname.startsWith('/mcp/')) {
    const [w, h] = (url.searchParams.get('size') ?? '10x10').split('x').map(Number)
    const id = url.searchParams.get('id') ?? url.pathname
    const shade = createHash('md5').update(id).digest()
    res.writeHead(200, { 'content-type': 'image/png' })

    return res.end(png(w, h, [shade[0], shade[1], shade[2], 255]))
  }
  if (url.pathname.startsWith('/gone/')) return json(res, 404, { error: 'expired' })
  if (url.pathname === '/mcp-svg/icon.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml' })

    return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
  }
  if (!authorized(req)) return json(res, 403, { status: 403, err: 'Invalid token' })
  if (url.pathname === '/v1/me') return json(res, 200, ME)
  const imageRender = /^\/v1\/images\/([^/]+)$/.exec(url.pathname)
  if (imageRender) {
    if (fake.throttleImagesOnce) {
      fake.throttleImagesOnce = false
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })

      return res.end(JSON.stringify({ status: 429, err: 'Rate limit exceeded' }))
    }
    const scale = Number(url.searchParams.get('scale') ?? 1)
    const absolute = url.searchParams.get('use_absolute_bounds') === 'true'
    const images = {}
    for (const id of (url.searchParams.get('ids') ?? '').split(',')) {
      const n = index.get(id) ?? FILE.document.children[0].children.find(x => x.id === id)
      if (!n || n.visible === false) {
        images[id] = null
        continue
      }
      if (id === '40:3') {
        images[id] = `http://127.0.0.1:${fakeServer.address().port}/gone/40-3.png`
        continue
      }
      const b = absolute ? n.absoluteBoundingBox : n.absoluteRenderBounds ?? n.absoluteBoundingBox
      const size = `${Math.max(1, Math.round(b.width * scale))}x${Math.max(1, Math.round(b.height * scale))}`
      images[id] = `http://127.0.0.1:${fakeServer.address().port}/render/${imageRender[1]}/${encodeURIComponent(id)}.png?size=${size}&id=${encodeURIComponent(id)}`
    }

    return json(res, 200, { err: null, images })
  }
  if (files && files[1] === KEY) {
    if (!files[2]) return json(res, 200, FILE)
    if (files[2] === '/images') return json(res, 200, { error: false, status: 200, meta: { images: { [HERO.fills[0].imageRef]: `http://127.0.0.1:${fakeServer.address().port}/render/fill?size=1600x1200&id=photo` } } })
    const nodes = {}
    for (const id of (url.searchParams.get('ids') ?? '').split(',')) {
      const n = index.get(id)
      nodes[id] = n ? { document: shaped(n, { depth: url.searchParams.has('depth') ? Number(url.searchParams.get('depth')) : undefined, geometry: url.searchParams.get('geometry') }), components: {}, componentSets: {}, schemaVersion: 0, styles: {} } : null
    }

    return json(res, 200, { name: A.name, lastModified: A.lastModified, thumbnailUrl: A.thumbnailUrl, version: A.version, role: 'owner', editorType: 'figma', linkAccess: 'view', nodes })
  }
  json(res, 404, { status: 404, err: 'Not found' })
})

// ---------------------------------------------------------------- the Reel server

let child
let logs = ''
const answers = []

async function call(method, pathname, body, headers = {}) {
  const res = await fetch(`${BASE}${pathname}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  answers.push(text)
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}

  return { status: res.status, data, text, headers: res.headers }
}
const get = p => call('GET', p)
const post = (p, body = {}) => call('POST', p, body)

before(async () => {
  fs.rmSync(SCRATCH, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
  fs.mkdirSync(CONFIG, { recursive: true })
  await new Promise((resolve, reject) => {
    fakeServer.once('error', reject)
    fakeServer.listen(0, '127.0.0.1', resolve)
  })
  child = spawn(process.execPath, [SERVER, '--root', ROOT, '--port', String(PORT)], {
    env: { ...process.env, REEL_FIGMA_API_BASE: `http://127.0.0.1:${fakeServer.address().port}`, REEL_CONFIG_DIR: CONFIG, REEL_FIGMA_CLIENT_ID: '', REEL_FIGMA_CLIENT_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', d => (logs += d))
  child.stderr.on('data', d => (logs += d))
  const until = Date.now() + 15000
  while (!logs.includes('Reel editor at')) {
    if (Date.now() > until || child.exitCode !== null) throw new Error(`the Reel server did not start:\n${logs}`)
    await new Promise(r => setTimeout(r, 50))
  }
  assert.match(logs, /routes: figma\.mjs/)
})

after(async () => {
  if (child && child.exitCode === null) {
    const gone = new Promise(r => child.once('exit', r))
    child.kill('SIGTERM')
    await gone
  }
  await new Promise(r => fakeServer.close(r))
  if (process.env.REEL_TEST_VERBOSE) console.log(logs)
})

const secrets = () => [PAT, SECRET, ...fake.access, ...fake.refresh.keys()]

test('personal access token: validate, store 0600, never echo', async () => {
  let r = await get('/api/figma/status')
  assert.deepEqual(r.data, { connected: false, handle: null, method: null, oauth: false })
  r = await post('/api/new', { name: 'Figma test' })
  assert.equal(r.status, 200)

  r = await post('/api/figma/frames', { url: `https://www.figma.com/design/${KEY}/Lower-thirds` })
  assert.equal(r.status, 500)
  assert.match(r.data.error, /not connected/)

  r = await post('/api/figma/token', { token: 'figd_wrong' })
  assert.equal(r.status, 500)
  assert.match(r.data.error, /Figma did not accept that token \(403\)/)
  assert.ok(!fs.existsSync(path.join(CONFIG, 'figma-token.json')))

  r = await post('/api/figma/token', { token: ` ${PAT} ` })
  assert.deepEqual(r.data, { connected: true, handle: 'Ada Designer', method: 'pat' })
  const file = path.join(CONFIG, 'figma-token.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(stored.accessToken, PAT)
  assert.equal(stored.method, 'pat')
  r = await get('/api/figma/status')
  assert.deepEqual(r.data, { connected: true, handle: 'Ada Designer', method: 'pat', oauth: false })
  const me = fake.requests.filter(q => q.path === '/v1/me').at(-1)
  assert.equal(me.headers['x-figma-token'], PAT, 'personal tokens go in X-Figma-Token')
})

test('frames: a page lists its frames with cached thumbnails; a frame lists itself and child frames', async () => {
  let r = await post('/api/figma/frames', { url: `https://www.figma.com/design/${KEY}/Lower-thirds?t=x` })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.data.fileKey, KEY)
  assert.equal(r.data.fileName, 'Reel Lower Thirds')
  assert.deepEqual(r.data.target, { id: '0:1', name: 'Lower thirds', type: 'CANVAS' })
  assert.deepEqual(r.data.frames.map(f => [f.id, f.name, f.type]), [['12:3', 'Lower Third / A', 'FRAME'], ['12:40', 'Lower Third / B', 'FRAME'], ['30:1', 'Archive', 'SECTION']])
  const thumb = r.data.frames[0].thumbnail
  assert.match(thumb, new RegExp(`^/cache/figma/${KEY}/12-3-[0-9a-f]{10}\\.png$`))
  const img = await fetch(`${BASE}${thumb}`)
  assert.equal(img.status, 200)
  assert.equal(img.headers.get('content-type'), 'image/png')
  const listing = fake.requests.find(q => q.path === `/v1/files/${KEY}`)
  assert.equal(listing.query.depth, '2')

  r = await post('/api/figma/frames', { url: `https://www.figma.com/design/${KEY}/Lower-thirds?node-id=12-3` })
  assert.deepEqual(r.data.frames.map(f => f.name), ['Lower Third / A', 'Ticker'])
  assert.deepEqual([r.data.frames[0].width, r.data.frames[0].height], [1920, 1080])
})

test('import a frame: renders downloaded and probed, composition built and placed', async () => {
  fake.throttleImagesOnce = true
  const r = await post('/api/figma/import', { url: `https://www.figma.com/design/${KEY}/Lower-thirds?node-id=12-3`, placeOnTimeline: true, duration: 6 })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.data.comp, 'k1')
  assert.deepEqual(r.data.comps, ['k1', 'k2'])
  assert.deepEqual(r.data.warnings, [])
  assert.ok(r.data.clip, 'placed on the timeline')

  // The node JSON came with geometry; renders were PNG @2x; the 429 was retried.
  const nodeReq = fake.requests.find(q => q.path === `/v1/files/${KEY}/nodes` && q.query.geometry)
  assert.equal(nodeReq.query.geometry, 'paths')
  const renders = fake.requests.filter(q => q.path === `/v1/images/${KEY}` && q.query.scale === '2')
  assert.equal(renders.length, 2, 'one 429, one retry')
  assert.deepEqual(renders[1].query.ids.split(',').sort(), ['12:10', '12:7'])
  assert.equal(renders[1].query.format, 'png')
  for (const q of fake.requests.filter(x => x.path.startsWith('/render/'))) {
    assert.equal(q.headers['x-figma-token'], undefined, 'no token to the image host')
    assert.equal(q.headers.authorization, undefined)
  }

  const saved = fs.readdirSync(path.join(ROOT, 'media', 'figma', KEY)).sort()
  assert.equal(saved.length, 2)
  assert.match(saved[0], /^12-10-2x-[0-9a-f]{10}\.png$/)
  assert.match(saved[1], /^12-7-2x-[0-9a-f]{10}\.png$/)

  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'reel.project.json'), 'utf8'))
  const avatarSrc = `media/figma/${KEY}/${saved[1]}`
  assert.deepEqual([p.assets[avatarSrc].width, p.assets[avatarSrc].height], [224, 224])
  const k1 = p.comps.k1
  assert.equal(k1.duration, 6)
  const clips = k1.tracks.flatMap(t => t.clips)
  const avatar = clips.find(c => c.label === 'Avatar')
  assert.equal(avatar.src, avatarSrc)
  assert.ok(Math.abs(224 * Math.min(1920 / 224, 1080 / 224) * avatar.scale - 112) < 0.01)
  assert.equal(clips.find(c => c.label === 'Ticker').comp, 'k2')
  assert.equal(clips.find(c => c.label === 'Name').title.text, 'Ada Lovelace')
  const placed = p.tracks.flatMap(t => t.clips).find(c => c.id === r.data.clip)
  assert.deepEqual([placed.kind, placed.comp, placed.start, placed.dur], ['comp', 'k1', 0, 6])
})

test('Smart Animate import keyframes the matched layers', async () => {
  const r = await post('/api/figma/import', { fileKey: KEY, nodeId: '12-3', toNodeId: '12:40', mode: 'smartAnimate', duration: 1, delay: 0.25, hold: 1 })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.data.comp, 'k3')
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'reel.project.json'), 'utf8'))
  const comp = p.comps.k3
  assert.equal(comp.name, 'Lower Third / A → Lower Third / B')
  assert.equal(comp.duration, 2.25)
  const clips = comp.tracks.flatMap(t => t.clips)
  assert.deepEqual(clips.find(c => c.label === 'Card').anim['shape.width'], [[0.25, 878, 'smooth'], [1.25, 1038]])
  assert.deepEqual(clips.find(c => c.label === 'Live Dot').anim.opacity, [[0.25, 0, 'smooth'], [1.25, 1]])
  const nodesReq = fake.requests.filter(q => q.path === `/v1/files/${KEY}/nodes` && q.query.geometry).at(-1)
  assert.equal(nodesReq.query.ids, '12:3,12:40')
})

test('an image-fill background imports from the original; a dead render becomes a warning, not a failure', async () => {
  const r = await post('/api/figma/import', { fileKey: KEY, nodeId: '40:1', who: 'claude' })
  assert.equal(r.status, 200, r.text)
  assert.ok(r.data.warnings.some(w => w.startsWith('render of node 40:3') && w.includes('404')), r.data.warnings.join('\n'))
  assert.ok(r.data.warnings.some(w => w.startsWith('"Logo" (VECTOR) needs a rendered image')), r.data.warnings.join('\n'))
  const fillReq = fake.requests.filter(q => q.path === `/v1/files/${KEY}/images`)
  assert.equal(fillReq.length, 1)
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'reel.project.json'), 'utf8'))
  const comp = p.comps[r.data.comp]
  assert.deepEqual([comp.width, comp.height, comp.background], [1280, 720, 'transparent'])
  const clips = comp.tracks.flatMap(t => t.clips)
  assert.deepEqual(clips.map(c => c.label), ['Hero image', 'Headline'])
  const photo = clips[0]
  assert.match(photo.src, new RegExp(`^media/figma/${KEY}/fill-f00dfeed0123456789abcdef0123456789abcdef-[0-9a-f]{10}\\.png$`))
  assert.deepEqual([p.assets[photo.src].width, p.assets[photo.src].height], [1600, 1200])
  // FILL: a 4:3 photo covers 1280x720 at 1280x960 and loses 120 px top and bottom.
  assert.ok(Math.abs(1600 * Math.min(1280 / 1600, 720 / 1200) * photo.scale - 1280) < 0.01)
  assert.deepEqual(photo.crop, { l: 0, r: 0, t: 0.125, b: 0.125 })
  assert.deepEqual([photo.x, photo.y], [640, 360])
  assert.deepEqual([clips[1].x, clips[1].y, clips[1].title.text], [214, 596, 'Reel 3'])
})

test('Claude path: MCP metadata plus asset URLs, without any Figma sign-in', async () => {
  await post('/api/figma/disconnect')
  const xml = fs.readFileSync(path.join(FIX, 'lower-third-a.metadata.xml'), 'utf8')
  const port = fakeServer.address().port
  const dataPng = `data:image/png;base64,${png(224, 224, [200, 120, 40, 255]).toString('base64')}`
  const before = fake.requests.length
  const r = await post('/api/figma/import-mcp', {
    xml,
    who: 'claude',
    assets: {
      '12:5': `http://localhost:${port}/mcp/asset/card.png?size=1760x360`,
      '12:7': dataPng,
      '12:10': `http://127.0.0.1:${port}/mcp-svg/icon.svg`,
      '12:16': 'http://example.com/bar.png',
    },
  })
  assert.equal(r.status, 200, r.text)
  assert.equal(r.data.comp, 'k5')
  assert.ok(r.data.warnings.some(w => w.startsWith('asset for 12:10') && w.includes('SVG')))
  assert.ok(r.data.warnings.some(w => w.startsWith('asset for 12:16') && w.includes('refusing to download over http from example.com')))
  assert.ok(fake.requests.slice(before).every(q => !q.path.startsWith('/v1/')), 'no Figma API calls on the MCP path')
  const p = JSON.parse(fs.readFileSync(path.join(ROOT, 'reel.project.json'), 'utf8'))
  const clips = p.comps[r.data.comp].tracks.flatMap(t => t.clips)
  const card = clips.find(c => c.label === 'Card')
  assert.equal(card.kind, 'image')
  assert.deepEqual([card.x, card.y], [536, 910])
  assert.ok(Math.abs(1760 * Math.min(1920 / 1760, 1080 / 360) * card.scale - 880) < 0.01, 'a 2x asset shows at the node size')
  assert.ok(clips.find(c => c.label === 'Avatar').src.startsWith('media/figma/mcp/12-7-'))
  assert.equal(clips.find(c => c.label === 'Icon / Play'), undefined)
  const project = await get('/api/project')
  assert.ok(project.data.activity.some(a => a.who === 'claude' && a.text.includes('from Figma')))
})

test('OAuth with PKCE: start, callback, stored session, renewal before expiry', async () => {
  let r = await get('/api/figma/oauth/start')
  assert.equal(r.status, 500)
  assert.match(r.data.error, /No Figma app is configured/)
  fs.writeFileSync(path.join(CONFIG, 'figma-app.json'), JSON.stringify({ clientId: CLIENT_ID, clientSecret: SECRET }))
  r = await get('/api/figma/status')
  assert.deepEqual(r.data, { connected: false, handle: null, method: null, oauth: true })
  r = await get('/api/figma/oauth/start')
  const auth = new URL(r.data.url)
  assert.equal(`${auth.origin}${auth.pathname}`, 'https://www.figma.com/oauth')
  const q = Object.fromEntries(auth.searchParams)
  assert.equal(q.client_id, CLIENT_ID)
  assert.equal(q.redirect_uri, `http://127.0.0.1:${PORT}/api/figma/callback`)
  assert.equal(q.response_type, 'code')
  assert.equal(q.code_challenge_method, 'S256')
  assert.equal(q.scope, 'current_user:read,file_content:read')
  assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/)
  assert.ok(!r.text.includes(SECRET))

  // The user approves in the browser; Figma redirects with a code bound to the challenge.
  fake.codes.set('code-approved', { challenge: q.code_challenge, redirectUri: q.redirect_uri })
  const cb = await fetch(`${q.redirect_uri}?code=code-approved&state=${encodeURIComponent(q.state)}`)
  const page = await cb.text()
  assert.equal(cb.status, 200, page)
  assert.match(cb.headers.get('content-type'), /text\/html/)
  assert.match(page, /Figma connected/)
  assert.match(page, /Ada Designer/)
  const tokenReq = fake.requests.filter(x => x.path === '/v1/oauth/token').at(-1)
  assert.equal(tokenReq.headers.authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`)

  // The state is single use.
  const replay = await fetch(`${q.redirect_uri}?code=code-approved&state=${encodeURIComponent(q.state)}`)
  assert.equal(replay.status, 400)
  assert.match(await replay.text(), /not valid/)
  const denied = await fetch(`${q.redirect_uri}?error=access_denied&state=x`)
  assert.equal(denied.status, 400)
  assert.match(await denied.text(), /access_denied/)

  r = await get('/api/figma/status')
  assert.deepEqual(r.data, { connected: true, handle: 'Ada Designer', method: 'oauth', oauth: true })
  const file = path.join(CONFIG, 'figma-token.json')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(stored.method, 'oauth')
  assert.ok(stored.refreshToken && stored.expiresAt - Date.now() < 61000)

  // The token expires within five minutes, so the next call renews it first and uses the new one.
  r = await post('/api/figma/frames', { url: `https://www.figma.com/design/${KEY}/x?node-id=12-40` })
  assert.equal(r.status, 200, r.text)
  assert.equal(fake.refreshCalls, 1)
  const renewed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.notEqual(renewed.accessToken, stored.accessToken)
  assert.equal(renewed.refreshToken, stored.refreshToken)
  const used = fake.requests.filter(x => x.path === `/v1/files/${KEY}/nodes`).at(-1)
  assert.equal(used.headers.authorization, `Bearer ${renewed.accessToken}`)
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)

  r = await post('/api/figma/disconnect')
  assert.deepEqual(r.data, { connected: false, handle: null, method: null })
  assert.ok(!fs.existsSync(file))
})

test('no token, refresh token or client secret reached a response or the server log', () => {
  for (const s of secrets()) {
    assert.ok(!logs.includes(s), 'secret in the server log')
    for (const text of answers) assert.ok(!text.includes(s), 'secret in an HTTP answer')
  }
})

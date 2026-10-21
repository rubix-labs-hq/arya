// Figma for Reel: per-user Figma sign-in and frame import.
//
// Each person connects their own Figma account, either through OAuth 2.0 with PKCE (when the
// app owner configured an OAuth app) or by pasting a personal access token. Both land in
// ~/.reel/figma-token.json with mode 0600. Tokens never reach the page or the log: the page
// only learns { connected, handle, method }.
//
// App owner config: ~/.reel/figma-app.json { "clientId", "clientSecret", "redirectUri"?, "scopes"? }
// or REEL_FIGMA_CLIENT_ID / REEL_FIGMA_CLIENT_SECRET. The redirect URL registered with Figma
// must match byte for byte; by default it is http://127.0.0.1:<port>/api/figma/callback.
// REEL_CONFIG_DIR replaces ~/.reel and REEL_FIGMA_API_BASE replaces https://api.figma.com
// (the tests point both at scratch space and a local fake API).
//
// Routes:
//   GET  /api/figma/status        → { connected, handle, method, oauth }
//   POST /api/figma/token         { token } → validates with GET /v1/me, stores it
//   POST /api/figma/disconnect    → forgets the token
//   GET  /api/figma/oauth/start   → { url } to open in the system browser
//   GET  /api/figma/callback      Figma's redirect; exchanges the code (PKCE) and shows a page
//   POST /api/figma/frames        { url } → the page's frames (or the node and its child frames) with thumbnails
//   POST /api/figma/import        { url | fileKey+nodeId, mode: comp|smartAnimate, toNodeId?, placeOnTimeline?, start?, compName?,
//                                   duration? (composition length), transition?, delay?, hold?, ease? (Smart Animate) }
//   POST /api/figma/import-mcp    { xml | nodes, assets: { nodeId: url }, mode?, toXml | toNodes?, coords?, fileKey?, … } for Claude's Figma MCP path

import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { figmaAssets, figmaToOps, mcpToNodes, parseFigmaUrl, placeCompOps, smartAnimateOps } from '../core/figma.js'
import { guardedOutput } from '../core/output-path.js'

const SCOPES = 'current_user:read,file_content:read'
const RENDER_SCALE = 2
const THUMB_WIDTH = 360
const MAX_IMAGE_BYTES = 100e6

const apiBase = () => (process.env.REEL_FIGMA_API_BASE || 'https://api.figma.com').replace(/\/+$/, '')
const authorizeUrl = () => process.env.REEL_FIGMA_OAUTH_URL || 'https://www.figma.com/oauth'
const configDir = () => process.env.REEL_CONFIG_DIR || path.join(os.homedir(), '.reel')
const tokenFile = () => path.join(configDir(), 'figma-token.json')
const appFile = () => path.join(configDir(), 'figma-app.json')

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const sha256 = text => createHash('sha256').update(text).digest()
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- stored credentials

function readToken() {
  try {
    const t = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'))

    return t?.accessToken ? t : null
  } catch {
    return null
  }
}

function writeToken(data) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  const tmp = `${tokenFile()}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, tokenFile())
}

function appConfig() {
  let file = {}
  try {
    file = JSON.parse(fs.readFileSync(appFile(), 'utf8'))
  } catch {}
  const clientId = process.env.REEL_FIGMA_CLIENT_ID || file.clientId || file.client_id
  const clientSecret = process.env.REEL_FIGMA_CLIENT_SECRET || file.clientSecret || file.client_secret
  if (!clientId || !clientSecret) return null
  const scopes = Array.isArray(file.scopes) ? file.scopes.join(',') : file.scopes || SCOPES

  return { clientId, clientSecret, redirectUri: file.redirectUri || file.redirect_uri || null, scopes }
}

const basicAuth = app => `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`

function authHeaders(auth) {
  return auth.method === 'oauth' ? { authorization: `Bearer ${auth.accessToken}` } : { 'x-figma-token': auth.accessToken }
}

// ---------------------------------------------------------------- talking to Figma

async function figmaFetch(pathname, { auth, query, method = 'GET', headers = {}, body } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : ''
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${apiBase()}${pathname}${qs}`, { method, headers: { ...(auth ? authHeaders(auth) : {}), ...headers }, body, signal: AbortSignal.timeout(90000) })
    if (res.status === 429 && attempt === 0) {
      await res.arrayBuffer().catch(() => {})
      const header = res.headers.get('retry-after')
      const wait = Math.min(10, header !== null && Number.isFinite(Number(header)) ? Math.max(0, Number(header)) : 2)
      await sleep(wait * 1000)
      continue
    }

    return res
  }
}

/** The JSON body, or an error that says what Figma refused. Never includes credentials. */
async function readFigmaJson(res, what) {
  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    const reason = [data?.err, data?.message, typeof data?.error === 'string' ? data.error : null].find(x => typeof x === 'string' && x)
    if (res.status === 401 || res.status === 403) throw new Error(`Figma refused ${what} (${res.status})${reason ? `: ${reason}` : ''}. The token may be expired or missing a scope, or the file is not shared with this account`)
    if (res.status === 404) throw new Error(`Figma could not find that file or node (404)`)
    if (res.status === 429) throw new Error('Figma rate limit reached (429); try again in a minute')
    throw new Error(`Figma ${what} failed (${res.status})${reason ? `: ${reason}` : ''}`)
  }
  if (data === null) throw new Error(`Figma ${what} did not answer with JSON`)

  return data
}

export default function figmaRoutes(ctx) {
  const pending = new Map() // OAuth state → { verifier, redirectUri, at }
  let refreshing = null

  async function refresh(token) {
    refreshing ??= (async () => {
      const app = appConfig()
      if (!app) throw new Error('The Figma app settings are gone, so the session cannot be renewed: connect Figma again')
      const res = await figmaFetch('/v1/oauth/refresh', {
        method: 'POST',
        headers: { authorization: basicAuth(app), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ refresh_token: token.refreshToken }).toString(),
      })
      const data = await readFigmaJson(res, 'renewing the session')
      if (!data.access_token) throw new Error('Figma did not return a renewed session')
      const next = { ...token, accessToken: data.access_token, refreshToken: data.refresh_token || token.refreshToken, expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null, refreshedAt: Date.now() }
      writeToken(next)
      ctx.log('figma: renewed the OAuth session')

      return next
    })().finally(() => {
      refreshing = null
    })

    return refreshing
  }

  async function currentAuth() {
    const token = readToken()
    if (!token) return null
    if (token.method === 'oauth' && token.refreshToken && token.expiresAt && token.expiresAt - Date.now() < 5 * 60 * 1000) return refresh(token)

    return token
  }

  /** GET a Figma API path as the connected user, renewing an OAuth session once if Figma refuses it. */
  async function api(pathname, query, what = pathname) {
    let auth = await currentAuth()
    if (!auth) throw new Error('Figma is not connected: open the Figma tab to sign in or paste a personal access token')
    let res = await figmaFetch(pathname, { auth, query })
    if ((res.status === 401 || res.status === 403) && auth.method === 'oauth' && auth.refreshToken) {
      await res.arrayBuffer().catch(() => {})
      auth = await refresh(auth)
      res = await figmaFetch(pathname, { auth, query })
    }

    return readFigmaJson(res, what)
  }

  async function whoIs(auth) {
    const res = await figmaFetch('/v1/me', { auth })
    if (res.status === 401 || res.status === 403) {
      await res.arrayBuffer().catch(() => {})
      throw new Error(`Figma did not accept that token (${res.status}). Check that it is current and has the "current_user:read" and "file_content:read" scopes.`)
    }

    return readFigmaJson(res, 'the token check (GET /v1/me)')
  }

  // ---------------------------------------------------------------- files on disk

  const safeKey = key => {
    const k = String(key ?? '')
    if (!/^[A-Za-z0-9]{1,128}$/.test(k)) throw new Error('That Figma file key is not valid')

    return k
  }
  const safeName = id => String(id).replace(/[^A-Za-z0-9_]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'node'
  const normId = id => (id === undefined || id === null || id === '' ? null : String(id).trim().replace(/-/g, ':'))

  function sniff(buf) {
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
    if (buf.length > 6 && buf.toString('ascii', 0, 4) === 'GIF8') return 'gif'
    if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp'
    const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).trimStart()
    if (/^(<\?xml[\s\S]*?)?<svg[\s>]/i.test(head)) return 'svg'

    return null
  }

  const figmaHost = host => host === 'figma.com' || host.endsWith('.figma.com') || host === 'figma-alpha-api.s3.us-west-2.amazonaws.com'

  /** Bytes of an asset: https, http on this machine (the Figma desktop MCP serves there), data: URL or a local file. */
  async function fetchBytes(source) {
    if (typeof source !== 'string') throw new Error('an asset must be a URL, data: URL or file path')
    const s = source
    if (s.startsWith('data:')) {
      const m = /^data:([\w/+.-]+)?(;base64)?,(.*)$/s.exec(s)
      if (!m) throw new Error('unreadable data: URL')

      return m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
    }
    if (/^https?:\/\//i.test(s)) {
      // No credentials: Figma's image URLs are pre-signed, and the token must never leave for another host.
      // Redirects are followed by hand so every hop passes the same https-or-loopback check.
      let u = new URL(s)
      const origin = u.host
      for (let hop = 0; ; hop++) {
        const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)
        if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`refusing to download over ${u.protocol.replace(':', '')} from ${u.hostname}`)
        // A redirect may stay on the asset's host or move to Figma's own hosts, never elsewhere.
        if (hop > 0 && u.host !== origin && !(u.protocol === 'https:' && figmaHost(u.hostname))) throw new Error(`refusing a redirect from ${origin} to ${u.host}`)
        const res = await fetch(u, { signal: AbortSignal.timeout(120000), redirect: 'manual' })
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
          await res.arrayBuffer().catch(() => {})
          if (hop >= 4) throw new Error('too many redirects downloading an image')
          u = new URL(res.headers.get('location'), u)
          continue
        }
        if (!res.ok) throw new Error(`downloading an image failed (${res.status} from ${u.hostname})`)
        if (Number(res.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) throw new Error('an image from Figma is larger than 100 MB')

        return Buffer.from(await res.arrayBuffer())
      }
    }
    const abs = s.startsWith('file://') ? new URL(s).pathname : path.isAbsolute(s) ? s : path.join(ctx.ROOT, s)
    ctx.checkAgentFile?.(abs)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`no such asset file: ${s}`)

    return fs.readFileSync(abs)
  }

  /** Saves an image under media/figma/<key>/ named by node and content, so re-imports reuse files. */
  async function saveImage(source, key, base) {
    const buf = await fetchBytes(source)
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('an image from Figma is larger than 100 MB')
    const ext = sniff(buf)
    if (ext === 'svg') throw new Error(`"${base}" is an SVG; Reel needs PNG or JPEG (ask Figma for format=png)`)
    if (!ext) throw new Error(`"${base}" is not a PNG, JPEG, GIF or WebP image`)
    ctx.assertCurrent?.()
    const dir = guardedOutput(ctx.ROOT, path.join(ctx.ROOT, 'media', 'figma', key))
    fs.mkdirSync(dir, { recursive: true })
    const file = guardedOutput(ctx.ROOT, path.join(dir, `${safeName(base)}-${createHash('sha1').update(buf).digest('hex').slice(0, 10)}.${ext}`))
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf)

    return path.relative(ctx.ROOT, file)
  }

  async function pool(items, size, fn) {
    const out = new Array(items.length)
    let next = 0
    const worker = async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i], i)
      }
    }
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker))

    return out
  }

  /** Renders (PNG @2x) and original image fills an import needs, saved and probed. */
  async function fetchAssets(key, plan, warnings) {
    const images = {}
    const jobs = []
    for (let i = 0; i < plan.renders.length; i += 40) {
      const ids = plan.renders.slice(i, i + 40)
      const data = await api(`/v1/images/${key}`, { ids: ids.join(','), format: 'png', scale: String(RENDER_SCALE) }, 'rendering layers')
      if (data.err) throw new Error(`Figma could not render layers: ${data.err}`)
      for (const id of ids) {
        const url = data.images?.[id]
        if (url) jobs.push({ id, url, scale: RENDER_SCALE })
        else warnings.push(`Figma returned no render for node ${id}`)
      }
    }
    if (plan.fills.length) {
      const data = await api(`/v1/files/${key}/images`, undefined, 'listing image fills')
      const map = data.meta?.images ?? data.images ?? {}
      for (const ref of plan.fills) {
        if (map[ref]) jobs.push({ id: ref, url: map[ref] })
        else warnings.push(`Figma returned no download for image fill ${ref}`)
      }
    }
    await pool(jobs, 4, async job => {
      try {
        const src = await saveImage(job.url, key, job.scale ? `${job.id}@${job.scale}x` : `fill-${job.id}`)
        images[job.id] = { src, ...(job.scale ? { scale: job.scale } : {}) }
      } catch (error) {
        warnings.push(`${job.scale ? `render of node ${job.id}` : `image fill ${job.id}`}: ${error.message}`)
      }
    })

    return images
  }

  /**
   * Probes the images and adds the ones the project lacks, in one undoable step. An image that
   * does not probe is dropped with a warning; the mapper then skips its layer and says so.
   */
  async function importImages(images, who, warnings) {
    const known = ctx.getProject()?.assets ?? {}
    const assets = {}
    for (const [id, entry] of Object.entries(images)) {
      let asset = known[entry.src] ?? assets[entry.src]
      if (!asset) {
        try {
          asset = await ctx.probe(entry.src)
          if (!(asset.width > 0 && asset.height > 0)) throw new Error('no picture in it')
        } catch (error) {
          warnings.push(`${entry.src} could not be read (${error.message.split('\n')[0].slice(0, 200)}); skipped`)
          delete images[id]
          continue
        }
      }
      entry.width = asset.width
      entry.height = asset.height
      if (!known[entry.src]) assets[entry.src] = asset
    }
    if (Object.keys(assets).length) await ctx.editOps([{ op: 'import', assets }], who, `imported ${Object.keys(assets).length} Figma image${Object.keys(assets).length === 1 ? '' : 's'}`)
  }

  /**
   * Builds the ops against the project as it is right now and applies them in the same tick:
   * every source is already imported, so POST /api/ops reaches applyOps without awaiting, and
   * the composition ids the mapper predicted cannot be taken in between.
   */
  async function applyImport(build, body, kind) {
    const who = body.who === 'claude' ? 'claude' : 'you'
    const current = ctx.getProject()
    const result = build(current)
    const comp = { id: result.comp, name: result.name, width: result.width, height: result.height, duration: result.duration }
    const ops = [...result.ops, ...(body.placeOnTimeline ? placeCompOps(current, comp, { start: Number(body.start) || 0, track: body.track, ...(Object.hasOwn(body, 'comp') ? { comp: body.comp } : {}) }) : [])]
    const applied = await ctx.editOps(ops, who, `imported ${kind} "${result.name}" from Figma (${result.layers} layer${result.layers === 1 ? '' : 's'})`)
    if (!applied.created.includes(result.comp)) throw new Error('the composition ids moved while importing; nothing is wrong with the file, try again')
    const destination = body.comp ? ctx.getProject().comps?.[body.comp] : ctx.getProject()
    const placed = body.placeOnTimeline ? applied.created.filter(id => /^c\d+$/.test(id)).find(id => destination?.tracks.some(t => t.clips.some(c => c.id === id && c.comp === result.comp))) : undefined

    return { comp: result.comp, comps: result.comps, name: result.name, created: applied.created, layers: result.layers, images: result.images ?? [], clip: placed ?? null, warnings: result.warnings, version: applied.version }
  }

  function needProject() {
    if (!ctx.getProject()) throw new Error('Open or create a Reel project first')
  }

  function refOf(body) {
    if (body.url) {
      const ref = parseFigmaUrl(body.url)
      if (!ref) throw new Error('That is not a Figma file link (expected https://www.figma.com/design/…)')

      return { fileKey: safeKey(ref.fileKey), nodeId: normId(body.nodeId) ?? ref.nodeId }
    }
    if (body.fileKey) return { fileKey: safeKey(body.fileKey), nodeId: normId(body.nodeId) }
    throw new Error('Give a Figma link (url), or fileKey and nodeId')
  }

  const FRAME_LIKE = new Set(['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'SECTION'])
  const frameLike = nodes => (nodes ?? []).filter(n => FRAME_LIKE.has(n.type) && n.visible !== false)

  async function thumbnails(key, nodes) {
    const out = {}
    const list = nodes.slice(0, 60)
    if (!list.length) return out
    const widest = Math.max(1, ...list.map(n => Math.max(n.absoluteBoundingBox?.width ?? 0, n.absoluteBoundingBox?.height ?? 0)))
    const scale = Math.max(0.01, Math.min(1, THUMB_WIDTH / widest))
    let data
    try {
      data = await api(`/v1/images/${key}`, { ids: list.map(n => n.id).join(','), format: 'png', scale: scale.toFixed(4) }, 'rendering thumbnails')
    } catch (error) {
      ctx.log(`figma: thumbnails failed: ${error.message}`)

      return out
    }
    ctx.assertCurrent?.()
    const dir = guardedOutput(ctx.ROOT, path.join(ctx.CACHE, 'figma', key))
    fs.mkdirSync(dir, { recursive: true })
    await pool(list, 4, async n => {
      const url = data.images?.[n.id]
      if (!url) return
      try {
        const buf = await fetchBytes(url)
        const ext = sniff(buf)
        if (!ext || ext === 'svg') return
        ctx.assertCurrent?.()
        const name = `${safeName(n.id)}-${createHash('sha1').update(buf).digest('hex').slice(0, 10)}.${ext}`
        const file = guardedOutput(ctx.ROOT, path.join(dir, name))
        if (!fs.existsSync(file)) fs.writeFileSync(file, buf)
        out[n.id] = `/cache/figma/${key}/${name}`
      } catch (error) {
        ctx.log(`figma: thumbnail ${n.id}: ${error.message}`)
      }
    })

    return out
  }

  const callbackPage = (title, text, ok) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f0f12;color:#e6e6ec;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}main{max-width:420px;padding:24px}h1{font-size:18px;margin:0 0 8px;color:${ok ? '#f5b942' : '#ff5f57'}}p{margin:0;color:#b7b7c2}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></main></body></html>`

  async function finishOAuth(url) {
    const error = url.searchParams.get('error')
    if (error) return { ok: false, title: 'Figma did not connect', text: `Figma said: ${error}. Start again from Reel's Figma tab.` }
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code') ?? ''
    const flow = pending.get(state)
    if (!flow || !code) return { ok: false, title: 'This sign-in link is not valid', text: 'It expired or was already used. Start again from Reel\'s Figma tab.' }
    pending.delete(state)
    const app = appConfig()
    if (!app) return { ok: false, title: 'Figma is not configured', text: 'The Figma app settings are missing.' }
    try {
      // Figma's codes expire 30 seconds after the redirect, so exchange at once.
      const res = await figmaFetch('/v1/oauth/token', {
        method: 'POST',
        headers: { authorization: basicAuth(app), 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ redirect_uri: flow.redirectUri, code, grant_type: 'authorization_code', code_verifier: flow.verifier }).toString(),
      })
      const data = await readFigmaJson(res, 'the sign-in')
      if (!data.access_token) throw new Error('Figma did not return an access token')
      const auth = { method: 'oauth', accessToken: data.access_token }
      const me = await whoIs(auth)
      writeToken({ ...auth, refreshToken: data.refresh_token ?? null, expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null, userId: data.user_id_string ?? me.id ?? null, handle: me.handle ?? null, email: me.email ?? null, savedAt: Date.now() })
      ctx.pushActivity('reel', `Figma connected as ${me.handle}`)
      ctx.broadcast('figma', { connected: true, handle: me.handle, method: 'oauth' })

      return { ok: true, title: 'Figma connected', text: `Signed in as ${me.handle}. You can close this tab and go back to Reel.` }
    } catch (err) {
      ctx.log(`figma: sign-in failed: ${err.message}`)

      return { ok: false, title: 'Figma did not connect', text: err.message }
    }
  }

  const routes = {
    'GET /api/figma/status': () => {
      const t = readToken()

      return { connected: Boolean(t), handle: t?.handle ?? null, method: t?.method ?? null, oauth: Boolean(appConfig()) }
    },

    'POST /api/figma/token': async body => {
      const token = String(body.token ?? '').trim()
      if (!token) throw new Error('Paste a Figma personal access token')
      if (token.length > 512 || /\s/.test(token)) throw new Error('That does not look like a Figma token')
      const me = await whoIs({ method: 'pat', accessToken: token })
      writeToken({ method: 'pat', accessToken: token, handle: me.handle ?? null, email: me.email ?? null, userId: me.id ?? null, savedAt: Date.now() })
      ctx.pushActivity('reel', `Figma connected as ${me.handle}`)

      return { connected: true, handle: me.handle ?? null, method: 'pat' }
    },

    'POST /api/figma/disconnect': () => {
      fs.rmSync(tokenFile(), { force: true })
      ctx.pushActivity('reel', 'Figma disconnected')

      return { connected: false, handle: null, method: null }
    },

    'GET /api/figma/oauth/start': (_body, _query, req) => {
      const app = appConfig()
      if (!app) throw new Error('No Figma app is configured for sign-in. Paste a personal access token instead, or add ~/.reel/figma-app.json with clientId and clientSecret')
      const port = /:(\d+)$/.exec(String(req?.headers?.host ?? ''))?.[1] ?? JSON.parse(fs.readFileSync(path.join(ctx.DOT, 'server.json'), 'utf8')).port
      const redirectUri = app.redirectUri ?? `http://127.0.0.1:${port}/api/figma/callback`
      const state = b64url(randomBytes(24))
      const verifier = b64url(randomBytes(48))
      for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60 * 1000) pending.delete(k)
      pending.set(state, { verifier, redirectUri, at: Date.now() })
      const q = new URLSearchParams({ client_id: app.clientId, redirect_uri: redirectUri, scope: app.scopes, state, response_type: 'code', code_challenge: b64url(sha256(verifier)), code_challenge_method: 'S256' })

      return { url: `${authorizeUrl()}?${q}` }
    },

    'POST /api/figma/frames': async body => {
      const { fileKey, nodeId } = refOf(body)
      let fileName
      let target
      let frames
      if (!nodeId) {
        const data = await api(`/v1/files/${fileKey}`, { depth: '2' }, 'reading the file')
        fileName = data.name
        const page = data.document?.children?.[0]
        if (!page) throw new Error('That file has no pages')
        target = page
        frames = frameLike(page.children)
      } else {
        const data = await api(`/v1/files/${fileKey}/nodes`, { ids: nodeId, depth: '1' }, 'reading the node')
        fileName = data.name
        const doc = data.nodes?.[nodeId]?.document
        if (!doc) throw new Error(`Figma could not find node ${nodeId} in that file`)
        target = doc
        frames = doc.type === 'CANVAS' || doc.type === 'SECTION' ? frameLike(doc.children) : [doc, ...frameLike(doc.children).filter(n => n.type !== 'GROUP')]
      }
      const thumbs = await thumbnails(fileKey, frames)

      return {
        fileKey,
        fileName: fileName ?? null,
        target: { id: target.id, name: target.name, type: target.type },
        frames: frames.map(n => ({ id: n.id, name: n.name, type: n.type, width: n.absoluteBoundingBox?.width ?? null, height: n.absoluteBoundingBox?.height ?? null, thumbnail: thumbs[n.id] ?? null })),
      }
    },

    'POST /api/figma/import': async body => {
      needProject()
      const { fileKey, nodeId } = refOf(body)
      if (!nodeId) throw new Error('Pick a frame: the link names no node (copy a link to the frame, or pass nodeId)')
      const smart = body.mode === 'smartAnimate'
      const toId = normId(body.toNodeId ?? body.to)
      if (smart && !toId) throw new Error('Smart Animate needs toNodeId, the frame to animate to')
      const ids = smart ? [nodeId, toId] : [nodeId]
      const data = await api(`/v1/files/${fileKey}/nodes`, { ids: ids.join(','), geometry: 'paths' }, 'reading the frame')
      const docs = ids.map(id => {
        const doc = data.nodes?.[id]?.document
        if (!doc) throw new Error(`Figma could not find node ${id} in that file`)

        return doc
      })
      const warnings = []
      const images = await fetchAssets(fileKey, figmaAssets(smart ? docs : docs[0], { flatten: smart }), warnings)
      const who = body.who === 'claude' ? 'claude' : 'you'
      await importImages(images, who, warnings)
      const common = { images, fps: Number(body.fps) || undefined, compName: body.compName || undefined }
      const out = await applyImport(current => (smart
        ? smartAnimateOps(docs[0], docs[1], { ...common, project: current, duration: Number(body.transition ?? body.duration) || undefined, delay: body.delay === undefined ? undefined : Number(body.delay), hold: body.hold === undefined ? undefined : Number(body.hold), ease: body.ease || undefined })
        : figmaToOps(docs[0], { ...common, project: current, duration: Number(body.duration) || undefined })), body, smart ? 'Smart Animate' : 'frame')
      out.warnings = [...warnings, ...out.warnings]

      return out
    },

    'POST /api/figma/import-mcp': async body => {
      needProject()
      const input = body.xml ?? body.nodes
      if (!input || (typeof input !== 'string' && typeof input !== 'object')) throw new Error('Give the Figma MCP get_metadata XML (xml) or a node tree (nodes)')
      const smart = body.mode === 'smartAnimate'
      const toInput = body.toXml ?? body.toNodes
      if (smart && !toInput) throw new Error('Smart Animate needs toXml or toNodes, the frame to animate to')
      const key = body.fileKey ? safeKey(body.fileKey) : 'mcp'
      const sources = body.assets && typeof body.assets === 'object' ? body.assets : {}
      const images = {}
      const warnings = []
      await pool(Object.entries(sources), 4, async ([id, source]) => {
        try {
          images[id] = { src: await saveImage(source, key, id) }
        } catch (error) {
          warnings.push(`asset for ${id}: ${error.message}`)
        }
      })
      const who = body.who === 'claude' ? 'claude' : 'you'
      await importImages(images, who, warnings)
      const options = { coords: body.coords }
      const a = mcpToNodes(input, images, options)
      const b = smart ? mcpToNodes(toInput, images, options) : null
      const common = { images, fps: Number(body.fps) || undefined, compName: body.compName || body.name || undefined }
      const out = await applyImport(current => (smart
        ? smartAnimateOps(a, b, { ...common, project: current, duration: Number(body.transition ?? body.duration) || undefined, delay: body.delay === undefined ? undefined : Number(body.delay), hold: body.hold === undefined ? undefined : Number(body.hold), ease: body.ease || undefined })
        : figmaToOps(a, { ...common, project: current, duration: Number(body.duration) || undefined })), body, smart ? 'Smart Animate' : 'frame')
      out.warnings = [...warnings, ...out.warnings]

      return out
    },
  }

  // Figma redirects the browser here, so the answer is a page, not JSON.
  const raw = async (req, res, url) => {
    if (url.pathname !== '/api/figma/callback' || req.method !== 'GET') return false
    const r = await finishOAuth(url)
    ctx.send(res, r.ok ? 200 : 400, callbackPage(r.title, r.text, r.ok), { 'content-type': 'text/html; charset=utf-8' })

    return true
  }

  return { routes, raw }
}

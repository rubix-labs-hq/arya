// Sign in with ChatGPT for the local editor: ChatGPT plan usage for open-source apps that run
// on the user's own computer. https://developers.openai.com/siwc/token-sharing-open-source
// Tokens stay in this process and in owner-only files under ~/.arya/chatgpt. They never reach
// the page, a URL other than OpenAI's authorize endpoint, a log, a project folder or a command line.
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

export const CHATGPT_RESOURCE = 'https://api.openai.com/v1'
export const CHATGPT_SCOPES = Object.freeze(['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct'])
export const CHATGPT_PLAN_SCOPE = 'chatgpt.tokens.use.direct'
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'
// Production endpoints from https://auth.openai.com/.well-known/openid-configuration.
const PRODUCTION = Object.freeze({
  issuer: 'https://auth.openai.com',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  revoke: 'https://auth.openai.com/api/accounts/oauth/revoke',
  jwks: 'https://auth.openai.com/.well-known/jwks.json',
  api: CHATGPT_RESOURCE,
})
const AGENT_NAME = 'Arya'
const REGISTRATION_CLIENT = 'dynamic_agent_client'
const UNUSABLE_REFRESH = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])
const REFRESH_MARGIN_MS = 5 * 60 * 1000
const SKEW_SECONDS = 60
const UNREADABLE = 'The saved ChatGPT connection is unreadable. Continue with ChatGPT to replace it.'

const failure = (message, status = 400, code) => Object.assign(new Error(message), { status, ...(code ? { code } : {}) })
const random = () => randomBytes(32).toString('base64url')
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a), right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}
const safeCode = value => typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : ''
const usableToken = value => typeof value === 'string' && value.length > 0 && value.length <= 16384 && !/\s/.test(value)
const validClient = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{3,200}$/.test(value) && value !== REGISTRATION_CLIENT
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const form = values => Object.entries(values).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&')
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
const page = (title, text) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHTML(title)}</title><style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f5f5f4;color:#1c1917}main{max-width:28rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}@media (prefers-color-scheme:dark){body{background:#1c1917;color:#f5f5f4}}</style></head><body><main><h1>${escapeHTML(title)}</h1><p>${escapeHTML(text)}</p></main></body></html>`
// The page sees a short opaque label for each registration, never its client ID or tokens.
export const accountID = clientID => createHash('sha256').update(`arya-chatgpt:${clientID}`).digest('base64url').slice(0, 16)

async function boundedText(response, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.length
    if (size > limit) throw failure('OpenAI returned a response larger than expected.', 502)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}
async function readJSON(response, limit = 256 * 1024) {
  const text = await boundedText(response, limit)
  if (!text.trim()) return {}
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
}
function timestamp(value) {
  if (Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string' && value) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null }
  return null
}
function parseSegment(value) {
  try { const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed } catch {}
  throw failure('OpenAI returned an unreadable identity token.', 502)
}

function openWithSystem(url) {
  const command = process.platform === 'darwin' ? '/usr/bin/open' : process.platform === 'linux' ? 'xdg-open' : null
  if (!command) return Promise.resolve(false)
  return new Promise(resolve => execFile(command, [url], { timeout: 10000 }, error => resolve(!error)))
}

// `endpoints`, `fetch`, `openURL`, `now`, `retryDelays` and `attemptTimeout` exist for tests.
// Production uses OpenAI's published endpoints; no setting or environment variable redirects tokens.
export function createChatGPTAccount(options = {}) {
  const endpoints = Object.freeze({ ...PRODUCTION, ...(options.endpoints ?? {}) })
  const directory = options.directory ?? path.join(os.homedir(), '.arya', 'chatgpt')
  const fetchImpl = options.fetch ?? globalThis.fetch
  const openURL = options.openURL ?? openWithSystem
  const now = options.now ?? Date.now
  const retryDelays = options.retryDelays ?? [500, 1500, 4000]
  const attemptTimeout = options.attemptTimeout ?? 10 * 60 * 1000
  const listeners = new Set()
  let attempt = null, refreshing = null, jwks = new Map(), closed = false

  const file = name => path.join(directory, name)
  const ensureDirectory = () => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700) }
  const readFile = (name, fallback) => {
    let stat
    try { stat = fs.lstatSync(file(name)) } catch (error) { if (error.code === 'ENOENT') return fallback; throw error }
    if (!stat.isFile() || stat.size > 512 * 1024) throw failure(UNREADABLE, 500)
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')) } catch { throw failure(UNREADABLE, 500) }
  }
  const writeFile = (name, value) => {
    ensureDirectory()
    const temporary = file(`.${name}.${randomUUID()}.tmp`)
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
      fs.renameSync(temporary, file(name))
    } finally { try { fs.unlinkSync(temporary) } catch {} }
  }
  const empty = () => ({ version: 1, active: null, welcomed: false, accounts: [] })
  const load = () => {
    const value = readFile('accounts.json', null)
    if (!value) return empty()
    if (value.version !== 1 || !Array.isArray(value.accounts) || value.accounts.length > 32 || value.accounts.some(item => !validClient(item?.client_id))) throw failure(UNREADABLE, 500)
    return value
  }
  const loadOrEmpty = () => { try { return load() } catch { return empty() } }
  const byClient = (saved, clientID) => saved.accounts.find(item => item.client_id === clientID) ?? null
  const byID = (saved, id) => saved.accounts.find(item => accountID(item.client_id) === id) ?? null
  const clearSession = (account, { keepHint = false } = {}) => {
    for (const key of ['access_token', 'refresh_token', 'expires_at', 'earliest_refresh_at']) delete account[key]
    if (!keepHint) delete account.id_token
    account.scopes = []
  }
  const hasSession = account => !!account?.access_token && (!!account.refresh_token || account.expires_at > now())
  const planUsage = account => hasSession(account) && (account.scopes ?? []).includes(CHATGPT_PLAN_SCOPE)
  const emit = change => { for (const listener of listeners) { try { listener(change) } catch {} } }

  // The host ID names this installation. It survives sign-out and account changes.
  const hostID = () => {
    let saved = null
    try { saved = readFile('host.json', null) } catch {}
    if (typeof saved?.ext_agent_host_id === 'string' && /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.ext_agent_host_id)) return saved.ext_agent_host_id
    const value = `urn:uuid:${randomUUID()}`
    writeFile('host.json', { ext_agent_host_id: value })
    return value
  }

  // Refresh tokens rotate, so two editor processes must never refresh the same session at once.
  async function withFileLock(work) {
    ensureDirectory()
    const lock = file('refresh.lock'), deadline = Date.now() + 20000
    for (;;) {
      try { fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); break } catch (error) {
        if (error.code !== 'EEXIST') throw error
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 60000) { fs.unlinkSync(lock); continue } } catch {}
        if (Date.now() > deadline) throw failure('Another Arya window is updating your ChatGPT sign-in. Try again.', 503, 'chatgpt_busy')
        await sleep(25)
      }
    }
    try { return await work() } finally { try { fs.unlinkSync(lock) } catch {} }
  }

  const post = (url, values, timeout = 20000) => fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: form(values), redirect: 'error', signal: AbortSignal.timeout(timeout) })

  async function loadKeys() {
    const response = await fetchImpl(endpoints.jwks, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (!response.ok) throw failure('OpenAI signing keys are unavailable. Try again shortly.', 502)
    const body = await readJSON(response, 64 * 1024), keys = new Map()
    for (const jwk of Array.isArray(body.keys) ? body.keys : []) {
      if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string' || jwk.use && jwk.use !== 'sig' || jwk.alg && jwk.alg !== 'RS256') continue
      try {
        const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })
        if (key.asymmetricKeyDetails?.modulusLength >= 2048) keys.set(jwk.kid, key)
      } catch {}
    }
    jwks = keys
  }
  // Keys rotate, so an unfamiliar kid triggers one refetch. ID tokens only arrive from the token
  // endpoint over TLS, once per sign-in or refresh, so this cannot be used to flood OpenAI.
  async function signingKey(kid) {
    if (!jwks.has(kid)) await loadKeys()
    const key = jwks.get(kid)
    if (!key) throw failure('OpenAI sign-in could not be verified. Try again.', 502)
    return key
  }
  // Mirrors https://developers.openai.com/siwc/website#6-verify-the-id-token.
  async function verifyIdentity(idToken, { clientID, nonce, subject }) {
    if (typeof idToken !== 'string' || idToken.length > 16384) throw failure('OpenAI did not return an identity token.', 502)
    const parts = idToken.split('.')
    if (parts.length !== 3) throw failure('OpenAI returned an unreadable identity token.', 502)
    const header = parseSegment(parts[0]), claims = parseSegment(parts[1])
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw failure('OpenAI returned an identity token Arya cannot verify.', 502)
    const key = await signingKey(header.kid)
    if (!verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'))) throw failure('The ChatGPT identity token signature is invalid.', 502)
    const seconds = Math.floor(now() / 1000), audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== endpoints.issuer || !audience.includes(clientID)) throw failure('The ChatGPT identity token was not issued to Arya.', 502)
    if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.exp + SKEW_SECONDS < seconds || Number.isFinite(claims.nbf) && claims.nbf - SKEW_SECONDS > seconds) throw failure('The ChatGPT identity token has expired. Try again.', 502)
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256 || claims.sid !== undefined && (typeof claims.sid !== 'string' || !claims.sid.trim())) throw failure('The ChatGPT identity token has no usable account identity.', 502)
    if (nonce !== undefined && !same(claims.nonce, nonce)) throw failure('The ChatGPT sign-in did not match this attempt. Try again.', 502)
    if (subject !== undefined && claims.sub !== subject) throw failure('ChatGPT returned a different account than the one you chose. Arya kept your saved connection. Choose Use a different account to add another one.', 409, 'chatgpt_account_mismatch')
    return claims
  }
  function tokenSet(body, previous) {
    if (!usableToken(body.access_token) || body.token_type !== undefined && String(body.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(body.expires_in) || body.expires_in <= 0 || body.expires_in > 86400) throw failure('OpenAI returned an unreadable sign-in response.', 502)
    if (body.refresh_token !== undefined && !usableToken(body.refresh_token) || body.scope !== undefined && typeof body.scope !== 'string') throw failure('OpenAI returned an unreadable sign-in response.', 502)
    // Plan usage is decided only by the scopes a response grants; a missing list grants nothing new.
    return { access_token: body.access_token, refresh_token: body.refresh_token ?? previous?.refresh_token, token_type: 'Bearer', expires_at: now() + body.expires_in * 1000,
      earliest_refresh_at: timestamp(body.earliest_refresh_at), scopes: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean).slice(0, 32) : previous?.scopes ?? [], saved_at: new Date(now()).toISOString() }
  }

  async function revoke(account) {
    for (let index = 0; index <= retryDelays.length; index++) {
      try {
        const response = await post(endpoints.revoke, { token: account.refresh_token, token_type_hint: 'refresh_token', client_id: account.client_id }, 8000)
        await boundedText(response, 64 * 1024).catch(() => '')
        if (response.status === 200) return true
        if (response.status < 500) return false
      } catch {}
      if (index < retryDelays.length) await sleep(retryDelays[index])
    }
    return false
  }

  const finishAttempt = (current, phase, message, { force = false } = {}) => {
    clearTimeout(current.timer)
    if (['waiting', 'exchanging'].includes(current.phase)) { current.phase = phase; current.message = message }
    current.server.close()
    if (force) current.server.closeAllConnections?.()
  }

  async function complete(current, { code, callbackClient }) {
    let clientID = current.clientID
    if (current.registration) {
      if (!validClient(callbackClient)) throw failure('ChatGPT did not finish registering Arya. Continue with ChatGPT to try again.', 502)
      clientID = callbackClient
    } else if (callbackClient && callbackClient !== clientID) throw failure('ChatGPT returned a different app registration. Arya kept your saved connection. Try again.', 502)
    if (typeof code !== 'string' || !code || code.length > 4096) throw failure('ChatGPT returned no sign-in code. Try again.', 502)
    const response = await post(endpoints.token, { grant_type: 'authorization_code', client_id: clientID, code, code_verifier: current.verifier, redirect_uri: current.redirect, resource: CHATGPT_RESOURCE })
    const body = await readJSON(response)
    if (!response.ok) throw safeCode(body.error) === 'invalid_grant' ? failure('The ChatGPT sign-in code expired. Continue with ChatGPT again.', 400) : failure(`ChatGPT sign-in failed (${safeCode(body.error) || response.status}).`, 502)
    const tokens = tokenSet(body)
    const claims = await verifyIdentity(body.id_token, { clientID, nonce: current.nonce, subject: current.registration ? undefined : current.subject })
    if (current.phase !== 'exchanging') {
      // Cancelled while the code was being exchanged: discard the new session.
      if (tokens.refresh_token) revoke({ refresh_token: tokens.refresh_token, client_id: clientID }).catch(() => {})
      return
    }
    let first = false, recorded = false
    await withFileLock(async () => {
      // Cancellation may happen while another editor owns the credential lock.
      if (current.phase !== 'exchanging') return
      const saved = loadOrEmpty(), existing = byClient(saved, clientID)
      if (existing && existing.subject !== claims.sub) throw failure('ChatGPT returned a registration that belongs to another account. Arya kept your saved connections.', 409, 'chatgpt_account_mismatch')
      // A replaced registration for this account (after OpenAI rejected the old client) goes away.
      saved.accounts = saved.accounts.filter(item => item.client_id !== clientID && !(item.invalid && item.subject === claims.sub))
      saved.accounts.push({ client_id: clientID, subject: claims.sub, email: typeof claims.email === 'string' ? claims.email.slice(0, 320) : '', issuer: endpoints.issuer, id_token: body.id_token, ...tokens })
      saved.accounts = saved.accounts.slice(-32)
      saved.active = clientID
      first = tokens.scopes.includes(CHATGPT_PLAN_SCOPE) && saved.welcomed !== true
      writeFile('accounts.json', saved)
      recorded = true
    })
    if (!recorded) {
      if (tokens.refresh_token) await revoke({ refresh_token: tokens.refresh_token, client_id: clientID })
      return
    }
    const plan = tokens.scopes.includes(CHATGPT_PLAN_SCOPE)
    current.phase = 'done'
    current.message = plan ? 'Signed in. Arya can use your ChatGPT plan.' : 'Signed in, but ChatGPT plan usage was not allowed. Turn it on to use the assistant.'
    emit({ kind: 'signed-in', planUsage: plan, first })
  }

  // One sign-in at a time. `account` picks a saved registration; `newAccount` registers another.
  async function signIn({ account: selected, newAccount = false, enablePlan = false } = {}) {
    if (closed) throw failure('The editor is closing.', 410)
    if (attempt) finishAttempt(attempt, 'cancelled', 'Replaced by a newer sign-in.', { force: true })
    const saved = loadOrEmpty()
    let record = null
    if (!newAccount) {
      record = selected ? byID(saved, selected) : byClient(saved, saved.active)
      if (selected && !record) throw failure('That ChatGPT account is no longer saved. Continue with ChatGPT to add it again.', 404)
      if (record?.invalid) record = null
    }
    const registration = !record
    const host = hostID()
    const current = { phase: 'waiting', message: '', registration, clientID: record?.client_id ?? REGISTRATION_CLIENT, subject: record?.subject,
      verifier: random(), state: random(), nonce: random(), startToken: random(), timer: null, server: null }
    const challenge = createHash('sha256').update(current.verifier).digest('base64url')
    const server = http.createServer((request, response) => {
      const port = server.address()?.port
      const respond = (status, title, text) => {
        response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'", 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', connection: 'close' })
        response.end(page(title, text))
      }
      if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${port}`) return respond(400, 'Request refused', 'Start ChatGPT sign-in from Arya Settings.')
      const url = new URL(request.url, `http://127.0.0.1:${port}`)
      if (url.pathname === '/auth/start') {
        if (attempt !== current || current.phase !== 'waiting' || !same(url.searchParams.get('attempt') ?? '', current.startToken)) return respond(404, 'Sign-in link expired', 'Start ChatGPT sign-in again from Arya Settings.')
        // The authorize URL can carry an identity hint, so only this redirect ever holds it.
        response.writeHead(302, { location: current.authorizeURL, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', connection: 'close' })
        return response.end()
      }
      if (url.pathname !== '/auth/callback') return respond(404, 'Not found', 'Start ChatGPT sign-in from Arya Settings.')
      if (attempt !== current || current.phase !== 'waiting' || !same(url.searchParams.get('state') ?? '', current.state)) return respond(400, 'Sign-in not recognized', 'This sign-in does not match the one Arya started. Start again from Arya Settings.')
      const error = url.searchParams.get('error')
      if (error) {
        const declined = error === 'access_denied'
        respond(200, declined ? 'Sign-in cancelled' : 'Sign-in failed', 'Return to Arya. You can close this tab.')
        finishAttempt(current, declined ? 'cancelled' : 'failed', declined ? 'ChatGPT sign-in was cancelled. Manual editing still works without an account.' : `ChatGPT sign-in failed (${safeCode(error) || 'unknown error'}). Try again.`)
        return
      }
      respond(200, 'Finishing sign-in', 'Return to Arya to finish. You can close this tab.')
      current.phase = 'exchanging'
      clearTimeout(current.timer)
      server.close()
      complete(current, { code: url.searchParams.get('code'), callbackClient: url.searchParams.get('client_id') ?? '' })
        .catch(failed => { if (current.phase === 'exchanging') { current.phase = 'failed'; current.message = String(failed.message).slice(0, 300) } })
    })
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 64
    current.server = server
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    current.redirect = `http://127.0.0.1:${port}/auth/callback`
    current.authorizeURL = `${endpoints.authorize}?${form({
      client_id: current.clientID,
      ...(registration ? { agent_name_hint: AGENT_NAME } : {}),
      ext_agent_host_id: host,
      ...(!registration && record.id_token ? { id_token_hint: record.id_token } : {}),
      ...(!registration && record.email ? { login_hint: record.email } : {}),
      response_type: 'code', redirect_uri: current.redirect, scope: CHATGPT_SCOPES.join(' '), resource: CHATGPT_RESOURCE,
      state: current.state, nonce: current.nonce, code_challenge_method: 'S256', code_challenge: challenge,
      ...(enablePlan ? { prompt: 'consent' } : {}),
    })}`
    current.startURL = `http://127.0.0.1:${port}/auth/start?attempt=${current.startToken}`
    current.timer = setTimeout(() => finishAttempt(current, 'expired', 'ChatGPT sign-in timed out. Continue with ChatGPT to try again.', { force: true }), attemptTimeout)
    current.timer.unref?.()
    attempt = current
    let opened = false
    try { opened = await openURL(current.startURL) === true } catch {}
    return { started: true, opened, startURL: current.startURL }
  }

  function cancelSignIn() {
    if (!attempt || !['waiting', 'exchanging'].includes(attempt.phase)) return { cancelled: false }
    finishAttempt(attempt, 'cancelled', 'ChatGPT sign-in was cancelled. Manual editing still works without an account.', { force: true })
    return { cancelled: true }
  }

  // Revoke first, then clear locally even when revocation is not confirmed. The registration stays.
  async function signOut({ account: selected } = {}) {
    cancelSignIn()
    let revocationConfirmed = true, signedOut = false, email = ''
    await withFileLock(async () => {
      const saved = load(), account = selected ? byID(saved, selected) : byClient(saved, saved.active)
      if (!account || !account.access_token && !account.refresh_token) return
      email = account.email ?? ''
      revocationConfirmed = account.refresh_token ? await revoke(account) : true
      clearSession(account)
      writeFile('accounts.json', saved)
      signedOut = true
    })
    if (signedOut) emit({ kind: 'signed-out' })
    return { signedOut, revocationConfirmed, email }
  }

  const fresh = account => account.expires_at - now() > REFRESH_MARGIN_MS || account.earliest_refresh_at > now() && account.expires_at - now() > 60000
  const credential = account => ({ accessToken: account.access_token, expiresAt: account.expires_at, planUsage: (account.scopes ?? []).includes(CHATGPT_PLAN_SCOPE), account: accountID(account.client_id) })
  const signInRequired = message => failure(message, 401, 'chatgpt_sign_in_required')

  async function renew() {
    const peek = load(), quick = byClient(peek, peek.active)
    if (!hasSession(quick)) throw signInRequired('Sign in to ChatGPT in Arya Settings to use your plan.')
    if (fresh(quick)) return credential(quick)
    return withFileLock(async () => {
      // Another process may have renewed while this one waited for the lock.
      const saved = load(), account = byClient(saved, saved.active)
      if (!hasSession(account)) throw signInRequired('Sign in to ChatGPT in Arya Settings to use your plan.')
      if (fresh(account)) return credential(account)
      const stillValid = account.expires_at - now() > 60000
      if (!account.refresh_token) {
        if (stillValid) return credential(account)
        clearSession(account, { keepHint: true }); writeFile('accounts.json', saved); emit({ kind: 'expired' })
        throw signInRequired('Your ChatGPT sign-in expired. Continue with ChatGPT to sign in again.')
      }
      let response, body
      try {
        response = await post(endpoints.token, { grant_type: 'refresh_token', client_id: account.client_id, refresh_token: account.refresh_token, resource: CHATGPT_RESOURCE })
        body = await readJSON(response)
      } catch {
        if (stillValid) return credential(account)
        throw failure('OpenAI could not be reached to renew your ChatGPT sign-in. Check your connection and try again.', 503, 'chatgpt_refresh_unavailable')
      }
      if (!response.ok) {
        const code = safeCode(body.error)
        if (UNUSABLE_REFRESH.has(code)) {
          clearSession(account, { keepHint: true }); writeFile('accounts.json', saved); emit({ kind: 'expired' })
          throw signInRequired('Your ChatGPT sign-in ended. Continue with ChatGPT to sign in again.')
        }
        if (code === 'invalid_client') {
          // OpenAI no longer accepts this registration. The next sign-in registers Arya again.
          clearSession(account); account.invalid = true; writeFile('accounts.json', saved); emit({ kind: 'expired' })
          throw signInRequired('OpenAI no longer accepts Arya’s registration for this ChatGPT account. Continue with ChatGPT to register Arya again.')
        }
        if (stillValid) return credential(account)
        throw failure(`OpenAI could not renew your ChatGPT sign-in (${code || response.status}). Try again shortly.`, 503, 'chatgpt_refresh_unavailable')
      }
      const tokens = tokenSet(body, account)
      if (body.id_token !== undefined) { await verifyIdentity(body.id_token, { clientID: account.client_id, subject: account.subject }); account.id_token = body.id_token }
      Object.assign(account, tokens)
      writeFile('accounts.json', saved)
      return credential(account)
    })
  }
  // One renewal at a time in this process; the file lock covers other processes.
  function accessToken() {
    if (!refreshing) refreshing = renew().finally(() => { refreshing = null })
    return refreshing
  }

  async function models() {
    const current = await accessToken()
    if (!current.planUsage) throw failure('ChatGPT plan usage is off for this sign-in. Turn it on in Arya Settings.', 403, 'chatgpt_plan_disabled')
    const response = await fetchImpl(`${endpoints.api}/models`, { headers: { authorization: `Bearer ${current.accessToken}`, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000) })
    const body = await readJSON(response, 2 * 1024 * 1024)
    if (!response.ok) throw failure(`OpenAI did not list ChatGPT models (${safeCode(body.error?.code) || response.status}).`, response.status === 401 ? 401 : 502)
    if (!Array.isArray(body.models)) throw failure('OpenAI returned an unreadable model list.', 502)
    // Keep display models in the server's order. Show display_name; send slug.
    return body.models.filter(item => item && item.visibility === 'list' && typeof item.slug === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(item.slug)).slice(0, 256)
      .map(item => ({ slug: item.slug, display_name: typeof item.display_name === 'string' && item.display_name.trim() ? item.display_name.trim().slice(0, 160) : item.slug }))
  }

  function status() {
    const sign = attempt ? { state: attempt.phase, message: attempt.message ?? '', startURL: attempt.phase === 'waiting' ? attempt.startURL : null } : { state: 'idle', message: '', startURL: null }
    let saved
    try { saved = load() } catch (error) { return { supported: true, signedIn: false, planUsage: false, email: '', active: null, accounts: [], welcome: false, usageURL: CHATGPT_USAGE_URL, attempt: sign, error: error.message } }
    const active = byClient(saved, saved.active)
    const accounts = saved.accounts.map(item => ({ id: accountID(item.client_id), email: item.email ?? '', signedIn: hasSession(item), planUsage: planUsage(item), active: item === active }))
    return { supported: true, signedIn: hasSession(active), planUsage: planUsage(active), email: active?.email ?? '', active: active ? accountID(active.client_id) : null,
      accounts, welcome: planUsage(active) && saved.welcomed !== true, usageURL: CHATGPT_USAGE_URL, attempt: sign }
  }

  async function acknowledgeWelcome() {
    await withFileLock(async () => { const saved = load(); if (saved.welcomed !== true) { saved.welcomed = true; writeFile('accounts.json', saved) } })
    return { welcome: false }
  }

  return {
    apiBase: endpoints.api,
    status, signIn, cancelSignIn, signOut, accessToken, models, acknowledgeWelcome,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    close() { closed = true; if (attempt) finishAttempt(attempt, 'cancelled', 'The editor closed before sign-in finished.', { force: true }) },
  }
}

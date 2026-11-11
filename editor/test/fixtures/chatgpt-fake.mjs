// A fake OpenAI auth server and Responses API that enforces the Sign in with ChatGPT docs.
// Every request that breaks a documented rule is recorded in `violations` and refused, so a
// test that ends with no violations has stayed inside the documented contract. Sources:
// developers.openai.com/siwc/token-sharing-open-source (sign-in, profiles-and-sessions,
// token-reference, models-and-inference, preview-limitations, errors-and-recovery), read 2026-11-10.
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import http from 'node:http'

export const DOC_SCOPES = ['chatgpt.tokens.use.direct', 'email', 'offline_access', 'openid', 'profile', 'resource.invoke']
export const DOC_MODEL = 'gpt-6.1-sol'
const RESOURCE = 'https://api.openai.com/v1'
const ISSUER = 'https://auth.openai.com'
const UNSUPPORTED_FIELDS = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id']
const UNSUPPORTED_TOOLS = ['image_generation', 'file_search', 'code_interpreter', 'computer_use_preview', 'computer_use', 'mcp', 'tool_search', 'programmatic_tool_calling']
const token = prefix => `${prefix}_${randomBytes(24).toString('base64url')}`
const b64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')

export async function startChatGPTFake(options = {}) {
  const now = options.now ?? Date.now
  const signing = new Map()
  let kid = null, keyCount = 0
  const fake = {
    violations: [], requests: [], registrations: new Map(), codes: new Map(), refresh: new Map(), access: new Map(),
    consent: [], refreshFailures: [], revokeFailures: 0, responses: [], responseBodies: [], refreshGrants: 0, revocations: [],
    models: [
      { slug: DOC_MODEL, display_name: 'GPT-6.1 Sol', visibility: 'list' },
      { slug: 'gpt-6.1-sol-mini', display_name: 'GPT-6.1 Sol mini', visibility: 'list' },
      { slug: 'internal-eval', display_name: 'Internal', visibility: 'hide' },
    ],
    rotateKey() {
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
      kid = `test-key-${++keyCount}`
      signing.set(kid, { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } })
    },
    // Signs an ID token like the sample in developers.openai.com/siwc/website#sample-id-token.
    idToken(claims, { badSignature = false } = {}) {
      const seconds = Math.floor(now() / 1000)
      const body = { iss: ISSUER, aud: [claims.client_id], auth_time: seconds, email_verified: false, sid: `sid_${randomBytes(8).toString('hex')}`, 'https://api.openai.com/auth': { per_user_salt: 'salt' }, iat: seconds, exp: seconds + 3600, jti: randomBytes(16).toString('hex'), ...claims }
      delete body.client_id
      const head = b64({ alg: 'RS256', kid, typ: 'JWT' }), payload = b64(body)
      const signature = sign('RSA-SHA256', Buffer.from(`${head}.${payload}`), signing.get(kid).privateKey).toString('base64url')
      return `${head}.${payload}.${badSignature ? signature.slice(0, -4) + 'AAAA' : signature}`
    },
  }
  fake.rotateKey()
  const violate = (response, message) => { fake.violations.push(message); json(response, 400, { error: 'doc_violation', error_description: message }) }
  const json = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(body === undefined ? '' : JSON.stringify(body)) }
  const readBody = request => new Promise((resolve, reject) => { const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); request.on('error', reject) })
  const grant = (client_id, subject, scopes) => {
    const access = token('at'), refresh = token('rt')
    fake.access.set(access, { client_id, subject, scopes, exp: now() + 3600 * 1000 })
    fake.refresh.set(refresh, { client_id, subject, scopes, used: false })
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' '), earliest_refresh_at: Math.floor(now() / 1000) + 3000 }
  }

  function authorize(url, response) {
    const p = Object.fromEntries(url.searchParams)
    const consent = fake.consent.shift() ?? {}
    const dynamic = p.client_id === 'dynamic_agent_client'
    if (!dynamic && !fake.registrations.has(p.client_id)) return violate(response, `authorize: unknown client_id ${p.client_id}`)
    if (dynamic && p.agent_name_hint !== 'Arya') return violate(response, 'authorize: first registration needs agent_name_hint=Arya')
    if (!dynamic && 'agent_name_hint' in p) return violate(response, 'authorize: agent_name_hint is only for first registration')
    if (!/^urn:uuid:[0-9a-f-]{36}$/.test(p.ext_agent_host_id ?? '')) return violate(response, 'authorize: ext_agent_host_id is required')
    if (dynamic && ('id_token_hint' in p || 'login_hint' in p)) return violate(response, 'authorize: hints belong to reauthorization')
    if (p.response_type !== 'code') return violate(response, 'authorize: response_type must be code')
    if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(p.redirect_uri ?? '')) return violate(response, `authorize: redirect_uri must be http://127.0.0.1:<port>/auth/callback, got ${p.redirect_uri}`)
    if ((p.scope ?? '').split(' ').sort().join(' ') !== [...DOC_SCOPES].sort().join(' ')) return violate(response, `authorize: scope must be the full documented set, got ${p.scope}`)
    if (p.resource !== RESOURCE) return violate(response, 'authorize: resource must be https://api.openai.com/v1')
    if (!p.state || !p.nonce) return violate(response, 'authorize: state and nonce are required')
    if (p.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge ?? '')) return violate(response, 'authorize: PKCE S256 is required')
    if ('force_reconsent' in p || 'client_secret' in p || p.prompt !== undefined && p.prompt !== 'consent') return violate(response, 'authorize: unsupported parameter')
    fake.lastAuthorize = p
    const redirect = new URL(p.redirect_uri)
    if (consent.hold) { response.writeHead(200, { 'content-type': 'text/html' }); return response.end('<p>Waiting for the user.</p>') }
    if (consent.deny) { redirect.search = new URLSearchParams({ error: 'access_denied', state: consent.state ?? p.state }).toString(); response.writeHead(302, { location: redirect.href }); return response.end() }
    let clientID = p.client_id, subject, email
    if (dynamic) {
      clientID = consent.issuedClient ?? token('oaiapp')
      subject = consent.subject ?? 'sub-alex'; email = consent.email ?? 'alex@example.com'
      if (!fake.registrations.has(clientID)) fake.registrations.set(clientID, { subject, email })
    } else ({ subject, email } = { ...fake.registrations.get(clientID), ...(consent.subject ? { subject: consent.subject } : {}) })
    const scopes = consent.grantPlan === false ? DOC_SCOPES.filter(item => item !== 'chatgpt.tokens.use.direct') : DOC_SCOPES
    const code = token('code')
    fake.codes.set(code, { client_id: clientID, redirect_uri: p.redirect_uri, challenge: p.code_challenge, nonce: p.nonce, subject, email, scopes, consent, used: false })
    const query = { code, scope: scopes.join(' '), state: consent.state ?? p.state }
    if (consent.callbackClient !== undefined) { if (consent.callbackClient) query.client_id = consent.callbackClient } else if (dynamic) query.client_id = clientID
    redirect.search = new URLSearchParams(query).toString()
    response.writeHead(302, { location: redirect.href })
    response.end()
  }

  async function tokenEndpoint(request, response) {
    if (request.headers['content-type'] !== 'application/x-www-form-urlencoded') return violate(response, 'token: body must be form-encoded')
    const p = Object.fromEntries(new URLSearchParams(await readBody(request)))
    fake.requests.push({ path: '/token', grant_type: p.grant_type, keys: Object.keys(p).sort() })
    if ('client_secret' in p) return violate(response, 'token: public client sends no secret')
    if (p.client_id === 'dynamic_agent_client') return violate(response, 'token: use the issued client_id, never dynamic_agent_client')
    if (p.resource !== RESOURCE) return violate(response, 'token: resource must be https://api.openai.com/v1')
    if (p.grant_type === 'authorization_code') {
      const code = fake.codes.get(p.code)
      if (!code || code.used) return json(response, 400, { error: 'invalid_grant' })
      code.used = true
      if (p.client_id !== code.client_id) return violate(response, 'token: client_id differs from the authorization')
      if (p.redirect_uri !== code.redirect_uri) return violate(response, 'token: redirect_uri must match the authorization exactly')
      if (createHash('sha256').update(p.code_verifier ?? '').digest('base64url') !== code.challenge) return violate(response, 'token: code_verifier does not match the S256 challenge')
      const body = grant(code.client_id, code.subject, code.scopes)
      const c = code.consent
      body.id_token = fake.idToken({ client_id: c.audience ?? code.client_id, sub: code.subject, email: code.email, name: 'Alex Morgan', nonce: c.nonce ?? code.nonce, ...(c.issuer ? { iss: c.issuer } : {}), ...(c.expired ? { iat: Math.floor(now() / 1000) - 7200, exp: Math.floor(now() / 1000) - 3600 } : {}) }, { badSignature: c.badSignature })
      if (c.rotateKeyBeforeToken) { fake.rotateKey(); body.id_token = fake.idToken({ client_id: code.client_id, sub: code.subject, email: code.email, nonce: code.nonce }) }
      return json(response, 200, body)
    }
    if (p.grant_type === 'refresh_token') {
      if ('scope' in p) return violate(response, 'refresh: omit scope to retain the grant')
      fake.refreshGrants++
      const failureCase = fake.refreshFailures.shift()
      if (failureCase) return json(response, failureCase.status, failureCase.body)
      const saved = fake.refresh.get(p.refresh_token)
      if (!saved) return json(response, 400, { error: 'invalid_grant' })
      if (saved.client_id !== p.client_id) return violate(response, 'refresh: client_id must be the one saved with this token set')
      if (saved.used) return json(response, 400, { error: 'refresh_token_reused' })
      saved.used = true
      return json(response, 200, grant(saved.client_id, saved.subject, saved.scopes))
    }
    return violate(response, `token: unexpected grant_type ${p.grant_type}`)
  }

  async function revokeEndpoint(request, response) {
    if (request.headers['content-type'] !== 'application/x-www-form-urlencoded') return violate(response, 'revoke: body must be form-encoded')
    const p = Object.fromEntries(new URLSearchParams(await readBody(request)))
    if (p.token_type_hint !== 'refresh_token' || !p.token || !p.client_id || p.client_id === 'dynamic_agent_client') return violate(response, 'revoke: send token, token_type_hint=refresh_token and the issued client_id')
    if (fake.revokeFailures > 0) { fake.revokeFailures--; return json(response, 503, { error: 'temporarily_unavailable' }) }
    const saved = fake.refresh.get(p.token)
    if (saved && saved.client_id !== p.client_id) return violate(response, 'revoke: client_id does not own this token')
    if (saved) saved.used = true
    for (const [key, value] of fake.access) if (saved && value.client_id === saved.client_id && value.subject === saved.subject) fake.access.delete(key)
    fake.revocations.push(p.client_id)
    response.writeHead(200); response.end()
  }

  function bearer(request, response) {
    const value = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '')?.[1]
    const saved = value && fake.access.get(value)
    if (!saved || saved.exp < now()) { json(response, 401, { error: { code: 'invalid_api_key', message: 'Invalid token' } }); return null }
    if (!saved.scopes.includes('chatgpt.tokens.use.direct')) { json(response, 403, { error: { code: 'chatpass_v2_scope_not_authorized', message: 'Not authorized' } }); return null }
    return saved
  }

  // Validates a Responses body against preview-limitations, then plays the next scripted turn.
  async function responsesEndpoint(request, response) {
    if (!bearer(request, response)) return
    let body
    try { body = JSON.parse(await readBody(request)) } catch { return violate(response, 'responses: body must be JSON') }
    fake.responseBodies.push(body)
    if (body.store !== false || body.stream !== true) return violate(response, 'responses: set store:false and stream:true')
    if (!Array.isArray(body.input)) return violate(response, 'responses: input must be an array')
    for (const field of UNSUPPORTED_FIELDS) if (field in body) return violate(response, `responses: unsupported field ${field}`)
    if (body.input.some(item => item?.role === 'system')) return violate(response, 'responses: system-role items are rejected; use instructions')
    if (typeof body.instructions !== 'string' || !body.instructions) return violate(response, 'responses: expected instructions')
    if (!fake.models.some(item => item.slug === body.model && item.visibility === 'list')) return violate(response, `responses: model ${body.model} is not a listed slug`)
    for (const tool of body.tools ?? []) {
      if (UNSUPPORTED_TOOLS.includes(tool?.type)) return violate(response, `responses: unsupported tool ${tool.type}`)
      if (tool?.type !== 'namespace' || !Array.isArray(tool.tools) || tool.tools.some(item => item.type !== 'function' || typeof item.name !== 'string' || !item.parameters)) return violate(response, 'responses: function tools must be grouped in a namespace')
    }
    // Replay must be append-only: earlier output items return unchanged, in order.
    const outputs = body.input.filter(item => ['reasoning', 'function_call', 'message'].includes(item?.type) && item.role !== 'user')
    for (const item of outputs) if (item.type === 'reasoning' && typeof item.encrypted_content !== 'string') return violate(response, 'responses: replay reasoning items with encrypted_content')
    const turn = fake.responses.shift() ?? (() => [{ type: 'response.output_text.delta', delta: 'Done.' }, { type: 'response.completed', response: { status: 'completed', output: [] } }])
    const script = await turn(body)
    // Each reply carries a request ID, as OpenAI's do, so clients can show it.
    const requestID = `req_fake${fake.responseBodies.length}`
    if (script?.status) { response.writeHead(script.status, { 'content-type': 'application/json', 'x-request-id': requestID }); response.end(JSON.stringify(script.body)); return }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-request-id': requestID })
    for (const event of script) {
      // 'cut' drops the connection after the earlier events reach the client.
      if (event === 'cut') { await new Promise(resolve => setTimeout(resolve, 50)); response.socket.destroy(); return }
      response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: 0 })}\n\n`)
    }
    response.end()
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/.well-known/jwks.json') return json(response, 200, { keys: [...signing.values()].map(item => item.jwk) })
      if (request.method === 'GET' && url.pathname === '/api/accounts/authorize') return authorize(url, response)
      if (request.method === 'POST' && url.pathname === '/api/accounts/oauth/token') return await tokenEndpoint(request, response)
      if (request.method === 'POST' && url.pathname === '/api/accounts/oauth/revoke') return await revokeEndpoint(request, response)
      if (request.method === 'GET' && url.pathname === '/v1/models') { if (bearer(request, response)) json(response, 200, { models: fake.models }); return }
      if (request.method === 'POST' && url.pathname === '/v1/responses') return await responsesEndpoint(request, response)
      violate(response, `unexpected route ${request.method} ${url.pathname}`)
    } catch (error) { if (!response.headersSent) json(response, 500, { error: 'fake_failure', error_description: error.message }) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  fake.origin = origin
  fake.endpoints = { authorize: `${origin}/api/accounts/authorize`, token: `${origin}/api/accounts/oauth/token`, revoke: `${origin}/api/accounts/oauth/revoke`, jwks: `${origin}/.well-known/jwks.json`, api: `${origin}/v1` }
  // The "browser": follows the loopback start link through authorize to the callback page.
  fake.browser = async url => { const response = await fetch(url); fake.lastPage = { status: response.status, headers: Object.fromEntries(response.headers), text: await response.text() }; return true }
  fake.close = () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) })
  return fake
}

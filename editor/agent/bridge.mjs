#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import http from 'node:http'
import { pathToFileURL } from 'node:url'
import { outputEvent, prepareAdapter, providerStatus, PROVIDERS } from './adapters.mjs'
import { UUID, validateCall, redact } from './protocol.mjs'
import { createOutputStream } from './output-stream.mjs'
import { createAssistantCatalog } from './assistant-catalog.mjs'
import { validateRoutingPreferences } from '../core/assistant-routing.mjs'
import { SHARING_VERSION, canonicalCompanion, normalizeSharingEnvelope, assertSharingRoute } from '../core/assistant-sharing.mjs'

const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
const secretEqual = (a, b) => {
  if (typeof a !== 'string' || a.length !== b.length) return false
  const bytes = Buffer.from(a), expected = Buffer.from(b)
  return bytes.length === expected.length && timingSafeEqual(bytes, expected)
}
const failure = (message, status = 400) => Object.assign(new Error(message), { status })
const GLOBAL_BYTES = 64 * 1024 * 1024, RUN_BYTES = 12 * 1024 * 1024, EVENT_BYTES = 8 * 1024 * 1024
const RESERVE = 4096, GLOBAL_RESERVE = 32 * RESERVE

export async function startBridge(options = {}) {
  const advertisedEndpoint = options.publicEndpoint === undefined ? null : canonicalCompanion(options.publicEndpoint)
  if (advertisedEndpoint && !advertisedEndpoint.startsWith('https:')) throw failure('A public companion identity requires a credential-free HTTPS root address.')
  const token = randomBytes(32).toString('hex'), runs = new Map()
  let endpoint, sharingCompanion, retainedBytes = 0, closed = false, closePromise
  const catalog = createAssistantCatalog({ custom: options.custom, ...(options.catalogOptions ?? {}) })
  const account = (run, size) => { run.retainedBytes += size; retainedBytes += size }
  const evictDelivered = (run, size) => {
    const candidates = [run, ...runs.values()].flatMap(owner => [...owner.calls.values()].filter(call => call.delivered && call.result).map(call => ({ owner, call })))
    for (const { owner, call } of candidates) {
      if (run.retainedBytes + size <= RUN_BYTES - RESERVE && retainedBytes + size <= GLOBAL_BYTES - GLOBAL_RESERVE) break
      account(owner, -call.bytes); call.result = null; call.bytes = 0; call.evicted = true
    }
    return run.retainedBytes + size <= RUN_BYTES - RESERVE && retainedBytes + size <= GLOBAL_BYTES - GLOBAL_RESERVE
  }
  const terminate = run => {
    if (run.child && run.child.exitCode === null && run.child.signalCode === null && !run.killTimer) {
      run.child.kill('SIGTERM')
      const child = run.child
      run.killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 1500)
      run.killTimer.unref()
    }
  }
  const finish = (run, value) => {
    if (run.terminal) return
    run.terminal = true; run.finished = Date.now(); clearTimeout(run.timer)
    const safe = { type: value.type, seq: ++run.seq }
    if (value.message) safe.message = redact(String(value.message).slice(0, 500), [token, run.token])
    if (value.text) safe.text = redact(value.text, [token, run.token])
    const size = Buffer.byteLength(JSON.stringify(safe))
    account(run, size); run.eventBytes += size; run.events.push(safe)
    run.finishTimer = setTimeout(() => terminate(run), value.type === 'done' ? 5000 : 0); run.finishTimer.unref()
  }
  const event = (run, value) => {
    if (run.terminal) return
    const safe = { ...value, seq: run.seq + 1 }
    for (const field of ['text', 'message']) if (safe[field] !== undefined) safe[field] = redact(safe[field], [token, run.token])
    const size = Buffer.byteLength(JSON.stringify(safe))
    if (run.eventBytes + size > EVENT_BYTES - RESERVE || run.seq >= 4095 || value.type === 'done' && size > 512 * 1024 || !evictDelivered(run, size)) {
      finish(run, { type: 'error', message: 'Agent output exceeded its retained-memory or event limit' }); terminate(run); return
    }
    if (['done', 'error'].includes(value.type)) { finish(run, safe); return }
    run.seq++; account(run, size); run.eventBytes += size; run.events.push(safe)
  }
  const stop = (run, reason = 'Agent run cancelled') => {
    if (!run.terminal) finish(run, { type: 'error', message: reason })
    terminate(run)
  }
  const launch = async run => {
    let adapter
    try {
      // Reserve the UUID before discovery so Stop also owns metadata preflight.
      const preferences = run.request.routing ?? { provider: run.request.provider, model: run.request.model ?? '', agent: run.request.agent ?? '' }
      const route = await catalog.resolve(preferences, { text: run.request.text, selectionCount: Array.isArray(run.request.context?.selection) ? run.request.context.selection.length : 0, inputKind: run.request.context?.inputKind, requiresImage: true })
      if (run.terminal) return
      if (!route.ok) throw new Error(route.reason)
      run.sharing = assertSharingRoute(run.request.sharing, route, run.request.sharing.scope.companion)
      run.request = { ...run.request, provider: route.provider, ...(route.model ? { model: route.model } : {}), agent: route.agent, effort: route.effort }
      run.routingReceipt = route
      event(run, { type: 'route', routing: route })
      if (run.terminal) return
      adapter = await (options.prepareAdapter ?? prepareAdapter)(run.request, { endpoint, token: run.token }, options.custom)
      if (run.terminal) return
      const child = spawn(adapter.command, adapter.args, { cwd: adapter.cwd, env: adapter.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      run.child = child
      let stderr = '', partial = false
      const output = createOutputStream(line => {
        const item = outputEvent(run.request.provider, line)
        if (line.includes('text_delta')) partial = true
        if (item && !(partial && line.includes('"assistant"'))) event(run, item)
        return !run.terminal
      })
      child.stdout.on('data', chunk => {
        if (run.terminal) { output.discard(); return }
        try { output.push(chunk) }
        catch (error) { output.discard(); stop(run, error.message) }
      })
      child.stderr.on('data', chunk => { stderr = (stderr + redact(chunk.toString(), [token, run.token])).slice(-8000) })
      child.stdin.on('error', () => {})
      await new Promise(resolve => {
        child.once('error', error => { if (!run.terminal) event(run, { type: 'error', message: `Could not launch the agent: ${error.message}` }); resolve() })
        child.once('close', code => {
          if (!run.terminal) {
            try { output.finish() } catch (error) { output.discard(); stop(run, error.message) }
            if (!run.terminal) event(run, code === 0 ? { type: 'done' } : { type: 'error', message: `Agent exited with status ${code}. ${stderr.slice(-2000) || 'Check the CLI sign-in and permitted Reel MCP tools in Terminal.'}` })
          }
          output.discard()
          resolve()
        })
        child.stdin.end(adapter.prompt)
      })
    } catch (error) { if (!run.terminal) event(run, { type: 'error', message: error.message }) }
    finally {
      clearTimeout(run.finishTimer); clearTimeout(run.killTimer); clearTimeout(run.timer)
      account(run, -run.requestBytes); run.requestBytes = 0; run.request = null
      for (const call of run.calls.values()) { account(run, -(call.bytes ?? 0)); call.bytes = 0; call.result = null; call.evicted = true }
      if (adapter) { try { await adapter.cleanup() } catch { process.stderr.write('The private agent working directory could not be removed.\n') } }
    }
  }
  async function readBody(request, limit) {
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) throw failure('Use application/json', 415)
    const chunks = []; let size = 0
    for await (const chunk of request) { size += chunk.length; if (size > limit) throw failure('Request body exceeded its limit', 413); chunks.push(chunk) }
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw failure('Unreadable JSON body') }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Request body must be an object')
    return value
  }
  const server = http.createServer(async (request, response) => {
    const reply = (status, data) => { if (response.destroyed) return; response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(data)) }
    try {
      if (closed) throw failure('Bridge has stopped', 410)
      const port = server.address().port
      if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(request.headers.host)) throw failure('Loopback clients only', 403)
      if (request.headers.origin) {
        let origin
        try { origin = new URL(request.headers.origin) } catch { throw failure('Untrusted Origin', 403) }
        if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname) || Number(origin.port) !== port || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw failure('Untrusted Origin', 403)
      }
      const url = new URL(request.url, endpoint)
      if (url.origin !== endpoint.slice(0, -1) || /%|\.\.|\\/.test(url.pathname)) throw failure('Invalid route')
      const match = /^\/v1\/runs\/([^/]+)(?:\/(events|cancel|tools|calls)(?:\/([^/]+))?)?$/.exec(url.pathname)
      const run = match && runs.get(match[1])
      const master = secretEqual((request.headers.authorization ?? '').replace(/^Bearer /, ''), token)
      const ownRun = run && secretEqual((request.headers.authorization ?? '').replace(/^Bearer /, ''), run.token)
      if (!master && !(ownRun && match[2] === 'calls')) throw failure('Unauthorized', 401)
      if (request.method === 'POST' && url.pathname === '/v1/shutdown') {
        await readBody(request, 1024)
        if ([...runs.values()].some(run => !run.terminal || run.child && run.child.exitCode === null && run.child.signalCode === null)) throw failure('Wait for the active request to stop before restarting the helper.', 409)
        closed = true // Refuse any pipelined request before the response finishes.
        response.once('finish', () => { void close() })
        return reply(200, { stopped: true })
      }
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        const metadata = await catalog.status({ wait: true, refresh: url.searchParams.get('refresh') === '1' })
        if (closed) throw failure('Bridge has stopped', 410)
        return reply(200, { version: 1, ...metadata, routingSupported: true, sharingConsentVersion: SHARING_VERSION, sharingCompanion, localCompanion: canonicalCompanion(endpoint), authentication: 'installed-cli-sign-in', defaultProvider: 'claude-code' })
      }
      if (request.method === 'POST' && url.pathname === '/v1/runs') {
        const body = await readBody(request, 1024 * 1024)
        if (closed) throw failure('Bridge has stopped', 410)
        if (!UUID.test(body.id ?? '') || !PROVIDERS.includes(body.provider) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 128000) throw failure('Run requires a UUID id, supported provider and nonempty text')
        for (const value of [body.model, body.agent]) if (value !== undefined && (typeof value !== 'string' || !value || value.length > 128 || /[\0\r\n]/.test(value))) throw failure('Invalid model or agent')
        body.sharing = normalizeSharingEnvelope(body.sharing)
        if (![sharingCompanion, canonicalCompanion(endpoint)].includes(body.sharing.scope.companion)) throw failure('This sharing permission names a different companion. Review the current companion destination.', 403)
        if (!['claude-code', 'codex'].includes(body.provider) && body.routing?.mode !== 'auto') throw failure('This custom or unsupported agent has no verified AI recipient. Choose Claude Code or Codex before sharing.', 403)
        if (body.routing !== undefined) body.routing = validateRoutingPreferences(body.routing)
        if (body.effort !== undefined) throw failure('Effort is chosen from the verified model catalog by Auto.')
        for (const value of [body.context, body.outline]) if (value !== undefined && (!value || typeof value !== 'object')) throw failure('Context and outline must be objects or arrays')
        const hash = createHash('sha256').update(canonical(body)).digest('hex')
        if (runs.has(body.id)) { if (runs.get(body.id).hash !== hash) throw failure('This run ID already belongs to a different request', 409); return reply(200, { id: body.id }) }
        for (const [id, previous] of runs) if (previous.terminal && Date.now() - previous.finished > 1800000 && (!previous.child || previous.child.exitCode !== null || previous.child.signalCode !== null)) { retainedBytes -= previous.retainedBytes; runs.delete(id) }
        if (runs.size >= 32 || [...runs.values()].filter(value => !value.terminal || value.child && value.child.exitCode === null && value.child.signalCode === null).length >= 4) throw failure('The bridge run limit is reached. Wait for a current run to finish.', 429)
        const requestBytes = Buffer.byteLength(JSON.stringify(body))
        if (retainedBytes + requestBytes > GLOBAL_BYTES - GLOBAL_RESERVE) throw failure('The bridge retained-memory limit is reached', 429)
        const current = { request: body, requestBytes, retainedBytes: 0, hash, token: randomBytes(32).toString('hex'), events: [], eventBytes: 0, seq: 0, calls: new Map(), terminal: false }
        account(current, requestBytes)
        runs.set(body.id, current)
        current.timer = setTimeout(() => stop(current, 'Agent exceeded 30 minutes. Review its edits before continuing.'), 1800000); current.timer.unref()
        current.launch = launch(current)
        return reply(201, { id: body.id })
      }
      if (!match || !run) throw failure('Run not found', 404)
      if (request.method === 'GET' && match[2] === 'events') {
        const after = Number(url.searchParams.get('after') ?? 0)
        if (!Number.isSafeInteger(after) || after < 0) throw failure('Invalid event cursor')
        return reply(200, { events: run.events.filter(item => item.seq > after).slice(0, 256) })
      }
      if (request.method === 'POST' && match[2] === 'cancel') { await readBody(request, 1024); stop(run); return reply(200, { id: match[1], cancelled: true }) }
      if (request.method === 'POST' && match[2] === 'calls' && !match[3]) {
        if (run.terminal) throw failure('Run has finished', 410)
        if (run.calls.size >= 128 || [...run.calls.values()].filter(call => !call.resultHash).length >= 8) throw failure('Reel tool-call limit reached', 429)
        const body = await readBody(request, 512 * 1024)
        const call = body.frame ? validateCall('reel_frame', body.frame) : validateCall('reel_api', body)
        if (run.terminal) throw failure('Run has finished', 410)
        const callID = randomUUID(); run.calls.set(callID, { created: Date.now(), result: null, resultHash: null, bytes: 0 })
        event(run, { type: 'tool', callID, ...call })
        return reply(202, { callID })
      }
      if (request.method === 'GET' && match[2] === 'calls' && match[3]) {
        if (run.terminal) throw failure('Run has finished', 410)
        const call = run.calls.get(match[3]); if (!call) throw failure('Tool call not found', 404)
        if (call.evicted) return reply(410, { error: 'This tool result was already delivered or its run has finished' })
        if (!call.result && (run.terminal || Date.now() - call.created > 120000)) return reply(200, { error: run.terminal ? 'Run has finished' : 'Reel tool exceeded two minutes' })
        call.delivered = !!call.result
        return reply(200, call.result ?? { pending: true })
      }
      if (request.method === 'POST' && match[2] === 'tools' && match[3]) {
        const call = run.calls.get(match[3]); if (!call) throw failure('Tool call not found', 404)
        const body = await readBody(request, 6 * 1024 * 1024)
        if (Object.keys(body).length !== 1 || !['result', 'error', 'image'].some(key => Object.hasOwn(body, key))) throw failure('Tool result must contain result, error or image')
        const resultHash = createHash('sha256').update(canonical(body)).digest('hex')
        if (call.resultHash) { if (call.resultHash !== resultHash) throw failure('Tool result already supplied', 409); return reply(200, { accepted: true }) }
        if (run.terminal) throw failure('Run has finished', 410)
        if (body.image) {
          if (!['image/png', 'image/jpeg', 'image/webp'].includes(body.image.mediaType) || typeof body.image.data !== 'string' || body.image.data.length > 5592408 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.image.data)) throw failure('Invalid frame image')
        } else if (Buffer.byteLength(JSON.stringify(body)) > 512 * 1024) throw failure('Tool result exceeded 512 KiB', 413)
        const size = Buffer.byteLength(JSON.stringify(body))
        if (!evictDelivered(run, size)) throw failure('Retained tool results exceeded the run or bridge memory limit', 413)
        account(run, size); call.bytes = size; call.result = body; call.resultHash = resultHash
        return reply(200, { accepted: true })
      }
      throw failure('Route not found', 404)
    } catch (error) { if (!response.headersSent) reply(error.status ?? 400, { error: redact(error.message, [token]) }) }
  })
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 32
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve) })
  endpoint = `http://127.0.0.1:${server.address().port}/`
  sharingCompanion = advertisedEndpoint ?? canonicalCompanion(endpoint)
  const pairURL = `reelagent://connect?port=${server.address().port}&token=${token}${options.pairNonce ? `&nonce=${options.pairNonce}` : ''}`
  const close = () => {
    if (closePromise) return closePromise
    // Close admission synchronously, including requests currently reading a body.
    closed = true
    catalog.close()
    const stoppedListening = new Promise(resolve => server.close(resolve))
    server.closeAllConnections()
    for (const run of runs.values()) stop(run, 'Bridge stopped')
    closePromise = (async () => {
      await Promise.allSettled([...runs.values()].map(run => run.launch))
      await stoppedListening
    })()
    return closePromise
  }
  return { server, endpoint, token, catalog, pairing: { version: 1, port: server.address().port, token, pairURL }, close }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), options = {}, customArgs = []
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--port') { options.port = Number(args[++i]); if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535 || options.port > 0 && options.port < 1024) throw new Error('Port must be 0 or 1024 through 65535') }
    else if (flag === '--public-endpoint') { options.publicEndpoint = canonicalCompanion(args[++i]); if (!options.publicEndpoint.startsWith('https:')) throw new Error('--public-endpoint requires a credential-free HTTPS root address') }
    else if (flag === '--pair-nonce') { options.pairNonce = args[++i]; if (!/^[a-f0-9]{64}$/.test(options.pairNonce ?? '')) throw new Error('Pair nonce must be 64 hex characters') }
    else if (flag === '--custom-executable') options.custom = { executable: args[++i], args: customArgs }
    else if (flag === '--custom-arg') customArgs.push(args[++i])
    else if (!['--pair', '--open'].includes(flag)) throw new Error(`Unknown bridge option: ${flag}`)
  }
  if (args.includes('--open') && !options.pairNonce) throw new Error('--open requires the app-issued --pair-nonce')
  const bridge = await startBridge(options)
  process.stdout.write(`${JSON.stringify(bridge.pairing)}\n`)
  if (args.includes('--open')) { spawn('/usr/bin/open', [bridge.pairing.pairURL], { stdio: 'ignore' }).on('error', () => process.stderr.write('Open Reel and pair the printed localhost address manually.\n')) }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void bridge.close().then(() => process.exit(0)) })
}

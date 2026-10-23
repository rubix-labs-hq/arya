import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { startBridge } from './bridge.mjs'
import { executable, providerStatus, PROVIDERS, subscriptionEnvironment } from './adapters.mjs'
import { identifier, redact, validateCall } from './protocol.mjs'
import { guardedOutput } from '../core/output-path.js'
import { PREVIEW_STEP_ROUTES } from '../core/assistant-steps.js'
import { validateRoutingPreferences, selectRoute } from '../core/assistant-routing.mjs'
import { createAssistantCatalog } from './assistant-catalog.mjs'
import { fileURLToPath } from 'node:url'
import { SHARING_VERSION, normalizeSharingEnvelope, sharingScopeForRoute, sameSharingScope, canonicalCompanion, sharingDisclosure } from '../core/assistant-sharing.mjs'
import { createToolOutcomes, recordToolOutcome, recordCompletedJobOutcome, unresolvedToolOutcome } from './tool-outcomes.mjs'

const exec = promisify(execFile)
const names = { 'claude-code': 'Claude Code', codex: 'Codex', antigravity: 'Google Antigravity', 'gemini-cli': 'Gemini CLI · retired', custom: 'Custom agent' }
const installs = { 'claude-code': 'https://code.claude.com/docs/en/setup', codex: 'https://developers.openai.com/codex/cli/', antigravity: 'https://antigravity.google/download', 'gemini-cli': 'https://geminicli.com/docs/get-started/installation/' }
const loginArgs = { 'claude-code': ['auth', 'login', '--claudeai'], codex: ['login'], antigravity: [] }
const apiOverrides = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AGY_GATEWAY_API_KEY', 'AGY_GATEWAY_URL', 'AGY_ADC_AUTH', 'GOOGLE_GENAI_USE_VERTEXAI', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
const failure = (message, status = 400) => Object.assign(new Error(message), { status })
// What the last request's preview became. The pending text matches the outcome drive()
// publishes for a preview run, and stays until the user decides.
const PREVIEW_OUTCOMES = {
  pending: 'Preview mode was on. Proposed edits are applied only when you choose Apply.',
  applied: 'You applied the preview. Use Undo this change to remove it.',
  failed: 'The preview stopped before every step finished. Edits made before the failure stay in the project.',
  discarded: 'You discarded the preview. No edits were applied.',
  undone: 'You undid the applied preview.',
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const bounded = (value, bytes, message) => { if (Buffer.byteLength(JSON.stringify(value)) > bytes) throw failure(message); return value }

function preferences(value) {
  if (!object(value) || Object.keys(value).some(key => !['provider', 'model', 'agent', 'effort', 'mode', 'priority', 'enabledModels', 'allowAdditionalSpend', 'allowAPIBilling', 'catalogBound'].includes(key))) throw failure('Use only provider, model, agent and routing preferences.')
  bounded(value, 64 * 1024, 'Assistant preferences exceeded 64 KiB.')
  if (value.provider !== undefined && !PROVIDERS.includes(value.provider)) throw failure('Choose a supported agent provider.')
  if (value.provider !== undefined && value.provider !== 'claude-code' && value.agent) throw failure('The Agent selector is supported by Claude Code. Leave it empty for this provider.')
  return validateRoutingPreferences(value)
}


// An agent run could otherwise turn a Figma import into a request to any web or loopback
// address, carrying project data in the URL. Allow Figma's hosts and the desktop app's server.
function figmaAssetURL(source) {
  let url
  try { url = new URL(source) } catch { return false }
  if (url.username || url.password) return false
  if (url.protocol === 'https:') return url.hostname === 'figma.com' || url.hostname.endsWith('.figma.com') || url.hostname === 'figma-alpha-api.s3.us-west-2.amazonaws.com'
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname) && url.port === '3845'
}

export function confinedFile(root, value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\0\\]/.test(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) throw failure('Use a file inside this project.')
  const base = fs.realpathSync(root), file = path.resolve(root, value)
  if (file !== path.resolve(root) && !file.startsWith(path.resolve(root) + path.sep)) throw failure('Agent files must stay inside the project.')
  let existing = file
  for (;;) {
    try { fs.lstatSync(existing); break }
    catch (error) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(existing); if (parent === existing) throw failure('The project file cannot be resolved.'); existing = parent }
  }
  let actual
  try { actual = fs.realpathSync(existing) } catch { throw failure('Agent files cannot use unresolved symbolic links.') }
  if (actual !== base && !actual.startsWith(base + path.sep)) throw failure('Agent files cannot follow a link outside the project.')
  return file
}

// A preview step's path names a processing route, not a file. Only the listed routes are
// exempt, and each step's body is checked like any other request body.
function checkProposal(root, body) {
  if (!object(body)) return checkFiles(root, body)
  const { steps, ...rest } = body
  checkFiles(root, rest)
  if (!Array.isArray(steps)) return checkFiles(root, steps, 'steps')
  for (const step of steps) {
    if (!object(step)) { checkFiles(root, step, 'steps'); continue }
    const { path: route, ...fields } = step
    if (!PREVIEW_STEP_ROUTES.includes(route)) throw failure(`Preview step paths are ${PREVIEW_STEP_ROUTES.join(', ')}.`)
    checkFiles(root, fields)
  }
}

function checkFiles(root, value, key = '', depth = 0) {
  if (depth > 40) throw failure('Tool arguments are nested too deeply.')
  if (typeof value === 'string' && ['src', 'path', 'dir', 'proxy', 'out'].includes(key)) confinedFile(root, value)
  if (Array.isArray(value)) {
    for (const child of value) {
      if (typeof child === 'string' && ['srcs', 'paths'].includes(key)) confinedFile(root, child)
      else checkFiles(root, child, key, depth + 1)
    }
  } else if (object(value)) for (const [field, child] of Object.entries(value)) {
    if (field === 'assets' && object(child)) for (const source of Object.keys(child)) confinedFile(root, source)
    checkFiles(root, child, field, depth + 1)
  }
}

export function createBrowserAssistant(options) {
  const root = path.resolve(options.root), settingsFile = path.join(root, '.reel', 'assistant-settings.json'), sharingFile = path.join(root, '.reel', 'assistant-sharing.json')
  // Host-only bounds also let fixture tests exercise timeout cleanup without waiting 15s.
  const requestTimeoutMs = options.requestTimeoutMs ?? 15000, cleanupTimeoutMs = options.cleanupTimeoutMs ?? 18000
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 15000 || !Number.isInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1 || cleanupTimeoutMs > 18000) throw new TypeError('Assistant host timeouts must be positive and within their default limits.')
  const ownerClosures = new WeakMap()
  let sharingGeneration = 0, grantRecord = null
  const reviews = new Map()
  let settings = preferences({}), bridge = null, bridgePromise = null, closed = false, active = null
  let configurationRevision = 0
  let providerCache = null, providerCheckedAt = null, statusPromise = null, explicitStatusPromise = null, catalogCache = []
  let publicStatus = { available: false, configured: false, reason: 'Checking the installed CLI account status.' }
  let state = { state: 'idle', text: '', runId: null, phase: '', startedAt: null, updatedAt: null, finishedAt: null }
  const platform = options.platform ?? process.platform
  const statusProvider = options.providerStatus ?? providerStatus
  const resolveExecutable = options.executable ?? executable
  const catalogHost = createAssistantCatalog({ custom: options.custom, providerStatus: statusProvider, executable: resolveExecutable, ...(options.catalogOptions ?? {}) })
  const launchLogin = options.launchLogin ?? ((command, args, env) => exec(command, args, { env, timeout: 10000, maxBuffer: 64 * 1024 }))
  try {
    const file = guardedOutput(root, settingsFile)
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 64 * 1024) throw failure('Saved assistant preferences exceeded 64 KiB.')
      settings = preferences(JSON.parse(fs.readFileSync(file, 'utf8')))
    }
  } catch (error) { options.diagnostic?.(redact(error.message)) }
  try {
    const file = guardedOutput(root, sharingFile)
    if (fs.existsSync(file)) {
      if (fs.statSync(file).size > 64 * 1024) throw failure('Saved sharing permission exceeded 64 KiB.')
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof saved.credentialDigest !== 'string' || !/^[a-f0-9]{64}$/.test(saved.credentialDigest)) throw failure('Saved sharing permission cannot be verified.')
      grantRecord = { sharing: normalizeSharingEnvelope(saved.sharing), credentialDigest: saved.credentialDigest }
    }
  } catch (error) { options.diagnostic?.(redact(error.message)) }
  const invalidateReviews = () => { sharingGeneration++; reviews.clear() }
  const persistGrant = () => {
    fs.mkdirSync(guardedOutput(root, path.dirname(sharingFile)), { recursive: true })
    if (!grantRecord) { try { fs.unlinkSync(guardedOutput(root, sharingFile)) } catch (error) { if (error.code !== 'ENOENT') throw error }; return }
    const temporary = path.join(path.dirname(sharingFile), `assistant-sharing-${randomUUID()}.part.json`)
    try {
      fs.writeFileSync(guardedOutput(root, temporary), `${JSON.stringify(grantRecord)}\n`, { mode: 0o600, flag: 'wx' })
      fs.renameSync(guardedOutput(root, temporary), guardedOutput(root, sharingFile))
    } finally { try { fs.unlinkSync(guardedOutput(root, temporary)) } catch {} }
  }
  const publish = next => {
    const at = Date.now()
    state = { ...state, ...next, updatedAt: at, ...(['done', 'error', 'cancelled'].includes(next.state) ? { finishedAt: at } : {}) }
    options.onState?.({ ...state, provider: settings.provider, providerName: names[settings.provider] })
  }
  const assertOpen = () => { if (closed) throw failure('The browser assistant has closed.', 410) }
  const assertRun = run => {
    assertOpen()
    if (active !== run || run.cancelled || run.terminal) throw failure('This assistant run is no longer active.', 410)
    if (run.sharingGeneration !== sharingGeneration) throw failure('Sharing permission changed. Review assistant sharing before sending.', 403)
    if (options.getIdentity() !== run.identity) throw failure('The project changed. Start a new assistant request.', 409)
  }
  const registerJob = (run, job) => {
    assertRun(run)
    if (!identifier(job.id) || !['/api/jobs/cancel', '/api/analysis/jobs/cancel', '/api/video/jobs/cancel'].includes(job.path)) throw failure('Invalid owned processing job.')
    if (run.jobs.size >= 128 && !run.jobs.has(`${job.path}:${job.id}`)) throw failure('The assistant created too many processing jobs.')
    run.jobs.set(`${job.path}:${job.id}`, job)
  }
  const cancelJobs = async run => {
    if (run.jobCancellation) return run.jobCancellation
    run.jobCancellation = (async () => {
    const jobs = [...run.jobs.values()]
    const results = await Promise.allSettled(jobs.map(async job => {
      const current = options.jobState?.(job)
      if (['done', 'failed', 'cancelled'].includes(current)) return
      if (!options.cancelJob) throw failure('Processing cancellation is unavailable.')
      const result = await options.cancelJob(job)
      if (result?.error) throw failure('Processing did not confirm cancellation.')
    }))
    results.forEach((result, i) => { if (result.status === 'fulfilled') run.jobs.delete(`${jobs[i].path}:${jobs[i].id}`) })
    if (results.some(result => result.status === 'rejected')) run.stopUnconfirmed = true
    return !run.stopUnconfirmed
    })()
    return run.jobCancellation
  }
  const loadProviders = refresh => {
    statusPromise = Promise.resolve().then(() => catalogHost.status({ wait: true, refresh })).then(value => {
      providerCache = value.providers; catalogCache = value.catalogs; providerCheckedAt = Date.now()
    }).catch(() => { providerCache = []; catalogCache = []; providerCheckedAt = Date.now() }).finally(() => { statusPromise = null })
    return statusPromise
  }
  const refreshProviders = (refresh = false) => {
    if (refresh) {
      if (!explicitStatusPromise) explicitStatusPromise = (async () => {
        if (statusPromise) await statusPromise
        await loadProviders(true)
      })().finally(() => { explicitStatusPromise = null })
      return explicitStatusPromise
    }
    if (!statusPromise && (!providerCache || Date.now() - providerCheckedAt > 15000)) loadProviders(false)
    return statusPromise
  }
  const status = async ({ wait = false, refresh = false } = {}) => {
    assertOpen()
    const pending = refreshProviders(refresh)
    if ((wait || refresh) && pending) await pending
    assertOpen()
    const raw = providerCache ?? []
    const providers = PROVIDERS.map(id => {
      const item = raw.find(value => value.id === id) ?? { id, installed: null, authenticated: null }
      const custom = id === 'custom', installed = item.installed === true
      const available = !custom && installed && item.available !== false && item.authenticated === true
      return { id, name: names[id], available, installed: item.installed ?? null, authenticated: custom ? null : item.authenticated ?? null,
        modelSelectionSupported: item.modelSelectionSupported === true, billingMode: item.billingMode ?? 'unknown', adapterManaged: item.adapterManaged === true, adapterSupported: custom ? false : item.adapterSupported ?? ['claude-code', 'codex', 'antigravity'].includes(id), catalogReason: item.catalogReason ?? null, productLoginApproval: item.productLoginApproval ?? 'unknown',
        reason: custom ? options.custom ? 'Custom editing is unavailable on this host. Choose Claude Code or Codex. Your custom preferences are saved.' : 'Custom editing is unavailable on this host. Choose Claude Code or Codex.' : String(item.reason ?? (statusPromise ? 'Checking the installed CLI account status.' : 'Provider account status is unavailable.')).slice(0, 500),
        installURL: installs[id] ?? null, loginCommand: id === 'antigravity' ? 'Use Sign in to open Arya’s separate Antigravity profile.' : loginArgs[id] ? `${id === 'claude-code' ? 'claude' : 'codex'} ${loginArgs[id].join(' ')}` : null,
        canLogin: platform === 'darwin' && installed && !!loginArgs[id] }
    })
    const selected = providers.find(value => value.id === settings.provider)
    const autoPreview = settings.mode === 'auto' ? selectRoute({ preferences: settings, catalogs: catalogCache, providers: raw, request: { requiresImage: true }, now: options.now?.() ?? Date.now() }) : null
    const manualPreview = settings.mode === 'manual' && (settings.catalogBound || settings.effort) ? selectRoute({ preferences: settings, catalogs: catalogCache, providers: raw, now: options.now?.() ?? Date.now() }) : null
    const currentRoute = autoPreview ?? manualPreview
    publicStatus = { available: currentRoute ? currentRoute.ok : selected.available, configured: currentRoute ? currentRoute.ok : selected.available, ...settings, providerName: settings.mode === 'auto' ? 'Auto' : names[settings.provider], reason: currentRoute ? currentRoute.ok ? settings.mode === 'auto' ? 'Auto is ready to choose from your enabled verified models.' : 'Your verified Manual model is ready.' : currentRoute.reason : selected.reason,
      routingSupported: true, sharingConsentVersion: SHARING_VERSION, catalogs: catalogCache, autoPreview, manualPreview, bridgeConnected: !!bridge, providers, sharing: { approved: !!grantRecord }, usage: null, loading: !!statusPromise || !!explicitStatusPromise, checkedAt: providerCheckedAt, ...state }
    return publicStatus
  }
  const configure = async body => {
    assertOpen()
    if (active) throw failure('Cancel or finish the current assistant request before changing providers.', 409)
    const next = preferences(body)
    if (next.provider === 'custom' && !options.custom) throw failure('Custom agents must be configured when the server starts.')
    const currentConfigurationRevision = ++configurationRevision
    const addedModels = next.enabledModels.filter(item => !settings.enabledModels.some(previous => previous.provider === item.provider && previous.model === item.model))
    if (addedModels.length || next.mode === 'manual' && (next.effort || next.catalogBound)) {
      const metadata = await catalogHost.status({ wait: true })
      assertOpen()
      if (active) throw failure('Cancel or finish the current assistant request before changing providers.', 409)
      if (currentConfigurationRevision !== configurationRevision) throw failure('A newer assistant preference request replaced this save. Review the current settings.', 409)
      for (const item of addedModels) {
        const model = metadata.catalogs.find(row => row.provider === item.provider)?.models.find(row => row.id === item.model)
        if (!model || !model.listed || model.hidden || model.available === false) throw failure('Enable only exact models from the host’s verified catalog. Refresh status first.')
      }
      if (next.mode === 'manual' && (next.effort || next.catalogBound)) {
        const route = selectRoute({ preferences: next, catalogs: metadata.catalogs, providers: metadata.providers, now: options.now?.() ?? Date.now() })
        if (!route.ok) throw failure(route.reason)
      }
    }
    fs.mkdirSync(guardedOutput(root, path.dirname(settingsFile)), { recursive: true })
    const temporary = path.join(path.dirname(settingsFile), `assistant-settings-${randomUUID()}.part.json`)
    try {
      fs.writeFileSync(guardedOutput(root, temporary), `${JSON.stringify(Object.keys(body).some(key => !['provider', 'model', 'agent'].includes(key)) ? next : { provider: next.provider, model: next.model, agent: next.agent })}\n`, { mode: 0o600, flag: 'wx' })
      fs.renameSync(guardedOutput(root, temporary), guardedOutput(root, settingsFile))
    } finally { try { fs.unlinkSync(guardedOutput(root, temporary)) } catch {} }
    settings = next
    invalidateReviews()
    publish({ state: 'idle', text: '', runId: null, phase: '', startedAt: null, finishedAt: null, routing: null })
    return status({ wait: true })
  }
  const login = async body => {
    assertOpen()
    if (!object(body) || Object.keys(body).some(key => key !== 'provider')) throw failure('Sign-in accepts only a provider.')
    const provider = body.provider ?? settings.provider
    if (platform !== 'darwin' || !loginArgs[provider]) throw failure('Use the provider sign-in on the companion Mac running macOS. Gemini CLI individual sign-in is retired; choose Google Antigravity.')
    const command = await resolveExecutable(provider === 'claude-code' ? 'claude' : provider === 'antigravity' ? 'agy' : 'codex')
    assertOpen()
    if (!command) throw failure(`Install ${names[provider]} before signing in.`)
    const resolved = fs.realpathSync(command)
    if (!fs.statSync(resolved).isFile()) throw failure('The provider CLI is not an executable file.')
    fs.accessSync(resolved, fs.constants.X_OK)
    const directory = guardedOutput(root, path.join(root, '.reel', 'cache', 'assistant-login'))
    fs.mkdirSync(directory, { recursive: true })
    const file = guardedOutput(root, path.join(directory, `${provider}-${randomUUID()}.command`))
    const original = process.env, cleaned = subscriptionEnvironment(original)
    // Terminal runs a fixed provider login. Preferences never become shell arguments.
    const invocation = provider === 'antigravity' ? [process.execPath, fileURLToPath(new URL('./antigravity.mjs', import.meta.url)), '--login', resolved] : [resolved, ...loginArgs[provider]]
    const script = `#!/bin/sh\nexec /usr/bin/env ${[...apiOverrides, 'NODE_OPTIONS', 'NODE_PATH'].flatMap(key => ['-u', shellQuote(key)]).join(' ')} ${invocation.map(shellQuote).join(' ')}\n`
    fs.writeFileSync(file, script, { mode: 0o700, flag: 'wx' })
    try { await launchLogin('/usr/bin/open', ['-a', 'Terminal', guardedOutput(root, file)], cleaned) }
    catch { try { fs.unlinkSync(guardedOutput(root, file)) } catch {}; throw failure('Terminal could not open the provider sign-in. Run the displayed login command in Terminal.') }
    assertOpen()
    invalidateReviews(); grantRecord = null; persistGrant()
    providerCache = null; providerCheckedAt = null; catalogHost.invalidate()
    return { started: true, provider, authenticated: false, reason: 'Complete the provider sign-in in Terminal, then refresh account status.' }
  }
  const companion = async () => {
    assertOpen()
    if (!bridgePromise) bridgePromise = (options.startBridge ?? startBridge)({ custom: options.custom, ...(options.bridgeOptions ?? {}) }).then(value => { bridge = value; return value })
    const value = await bridgePromise
    if (closed) { await value.close(); throw failure('The browser assistant has closed.', 410) }
    return value
  }
  const credentialDigest = owner => createHash('sha256').update(owner.token).digest('hex')
  const currentSharing = async () => {
    const generation = sharingGeneration, identity = options.getIdentity(), configuration = JSON.stringify(settings)
    const owner = await companion()
    const route = await catalogHost.resolve(settings, { requiresImage: true })
    assertOpen()
    if (generation !== sharingGeneration || identity !== options.getIdentity() || configuration !== JSON.stringify(settings)) throw failure('The project or assistant settings changed during sharing review. Review again.', 409)
    return { scope: sharingScopeForRoute(route, canonicalCompanion(owner.endpoint)), credentialDigest: credentialDigest(owner), generation, identity, configuration }
  }
  const approvedScope = value => !!grantRecord && grantRecord.credentialDigest === value.credentialDigest && sameSharingScope(grantRecord.sharing.scope, value.scope)
  const reviewResponse = (value, reviewID) => {
    const approved = approvedScope(value)
    return { version: SHARING_VERSION, approved, required: !approved, scope: value.scope, sharing: approved ? grantRecord.sharing : null, reviewID, disclosure: sharingDisclosure(value.scope), reason: approved ? 'Sharing permission covers the current recipients and model pool.' : 'Review these recipients and project data categories before sending.' }
  }
  const sharing = async () => {
    assertOpen()
    const value = await currentSharing(), reviewID = randomUUID()
    while (reviews.size >= 32) reviews.delete(reviews.keys().next().value)
    reviews.set(reviewID, { ...value, expiresAt: Date.now() + 5 * 60 * 1000 })
    return reviewResponse(value, reviewID)
  }
  const grantSharing = async body => {
    assertOpen()
    if (!object(body) || Object.keys(body).some(key => !['sharing', 'reviewID'].includes(key)) || typeof body.reviewID !== 'string' || body.reviewID.length > 128) throw failure('Review assistant sharing again before allowing it.', 403)
    const review = reviews.get(body.reviewID)
    if (!review || review.generation !== sharingGeneration || review.identity !== options.getIdentity() || review.expiresAt < Date.now()) throw failure('This sharing review expired or was withdrawn. Review again.', 403)
    const envelope = normalizeSharingEnvelope(body.sharing)
    if (!sameSharingScope(envelope.scope, review.scope)) throw failure('Allow only the exact recipients and data categories shown in this review.', 403)
    const value = await currentSharing()
    if (reviews.get(body.reviewID) !== review || review.generation !== sharingGeneration || review.expiresAt < Date.now() || review.configuration !== value.configuration || review.credentialDigest !== value.credentialDigest || !sameSharingScope(review.scope, value.scope)) throw failure('The assistant destination or model pool changed during review. Review again.', 403)
    grantRecord = { sharing: envelope, credentialDigest: value.credentialDigest }
    try { persistGrant() } catch (error) { grantRecord = null; throw error }
    reviews.delete(body.reviewID)
    return reviewResponse(value, null)
  }
  const revokeSharing = async () => {
    assertOpen()
    // Invalidate pending metadata and grant continuations before cancellation awaits.
    invalidateReviews(); grantRecord = null
    const stopping = cancel()
    let persistenceError
    try { persistGrant() } catch (error) { persistenceError = error }
    const result = await stopping
    if (persistenceError) throw persistenceError
    return { version: SHARING_VERSION, approved: false, required: true, revoked: true, ...result }
  }
  const request = async (owner, method, route, body) => {
    const response = await fetch(new URL(route, owner.endpoint), { method, headers: { authorization: `Bearer ${owner.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(requestTimeoutMs) })
    const chunks = []; let bytes = 0
    for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 9 * 1024 * 1024) throw failure('The companion response exceeded its limit.'); chunks.push(chunk) }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!response.ok) throw failure(redact(value.error ?? `Agent bridge returned ${response.status}`, [owner.token]), response.status)
    return value
  }
  const closeOwner = owner => {
    if (!ownerClosures.has(owner)) ownerClosures.set(owner, (async () => {
      let timer
      try {
        await Promise.race([Promise.resolve().then(() => owner.close()), new Promise((_, reject) => { timer = setTimeout(() => reject(failure('Agent shutdown did not finish within its limit.')), cleanupTimeoutMs) })])
        return true
      } catch { return false }
      finally { clearTimeout(timer) }
    })())
    return ownerClosures.get(owner)
  }
  const cancelRemote = run => {
    if (run.remoteCancellation) return run.remoteCancellation
    const owner = run.owner
    if (!owner) return Promise.resolve(true)
    const acknowledge = async () => {
      const receipt = await request(owner, 'POST', `/v1/runs/${run.id}/cancel`, {})
      if (!object(receipt) || receipt.id !== run.id || receipt.cancelled !== true) throw failure('The companion did not confirm cancellation of this assistant run.', 502)
      return true
    }
    run.remoteCancellation = (async () => {
      try { return await acknowledge() }
      catch (error) {
        if (error.status === 404) {
          // A missing UUID is safe only when no submission can still admit it.
          if (!run.submission) return true
          try {
            await run.submission
            try { return await acknowledge() }
            catch (retry) { if (retry.status !== 404) run.stopUnconfirmed = true }
          } catch { /* A lost submission response may still hide an accepted run. */ }
        } else run.stopUnconfirmed = true
        if (bridge === owner) { bridge = null; bridgePromise = null }
        const stopped = await closeOwner(owner)
        if (!stopped) { run.stopUnconfirmed = true; run.admissionUnconfirmed = true }
        return stopped
      }
    })()
    return run.remoteCancellation
  }
  const image = async (frame, run) => {
    assertRun(run)
    const result = frame.src ? { path: confinedFile(root, frame.src) } : await options.renderFrame(frame, () => assertRun(run), job => registerJob(run, job))
    assertRun(run)
    const file = confinedFile(root, result.path)
    const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()]
    if (!type || fs.statSync(file).size > 4 * 1024 * 1024) throw failure('An Arya frame must be a PNG, JPEG or WebP image smaller than 4 MiB.')
    const data = fs.readFileSync(file)
    if (data.length > 4 * 1024 * 1024) throw failure('The frame changed or exceeded 4 MiB.')
    assertRun(run)
    return { image: { mediaType: type, data: data.toString('base64') } }
  }
  const tool = async (event, run) => {
    assertRun(run)
    const call = event.frame ? validateCall('reel_frame', event.frame) : validateCall('reel_api', event)
    if (call.frame) return image(call.frame, run)
    const url = new URL(call.path, 'http://127.0.0.1')
    if (call.method === 'POST' && ['/api/jobs/cancel', '/api/analysis/jobs/cancel', '/api/video/jobs/cancel'].includes(url.pathname) && !run.jobs.has(`${url.pathname}:${call.body?.id}`)) throw failure('Agents can cancel only processing jobs created by their own run.')
    if (url.pathname === '/api/figma/import-mcp') {
      const { assets, ...body } = call.body ?? {}
      checkFiles(root, body)
      for (const source of Object.values(assets ?? {})) {
        // The import reads String(value), so only a string can be checked exactly as it will be used.
        if (typeof source !== 'string') throw failure('Figma asset values must be URLs, data: URLs or project file paths.')
        if (/^https?:/i.test(source)) { if (!figmaAssetURL(source)) throw failure('Agents can download Figma assets only from Figma or the Figma desktop app.') }
        else if (!/^data:/i.test(source)) confinedFile(root, source)
      }
    } else if (url.pathname === '/api/assistant/propose') checkProposal(root, call.body ?? {})
    else checkFiles(root, call.body ?? {})
    for (const [key, value] of url.searchParams) checkFiles(root, value, key)
    // Rendering first and failing at commit would waste minutes of processing on a preview.
    if (run.review && call.method === 'POST' && PREVIEW_STEP_ROUTES.includes(url.pathname)) throw failure(`Preview changes is on, so ${url.pathname} runs only when the user applies. Send it as a step: POST /api/assistant/propose {steps:[{path:"${url.pathname}",body:{...}}],summary}.`, 409)
    if (url.pathname === '/api/transcript') { if (!url.searchParams.has('offset')) url.searchParams.set('offset', '0'); if (!url.searchParams.has('limit')) url.searchParams.set('limit', '500'); call.path = url.pathname + url.search }
    if (run.review && call.method === 'POST' && url.pathname === '/api/transcript') throw failure('Preview changes is on, and saved transcript corrections have no preview or undo. Describe the corrections in your reply, or ask the user to turn off Preview changes.', 409)
    if (url.pathname === '/api/ops') call.body = { ...call.body, who: 'agent', returnProject: false }
    const result = await options.dispatch(call, () => assertRun(run), identity => { run.identity = identity }, job => registerJob(run, job), { runId: run.id, review: run.review === true })
    assertRun(run)
    recordToolOutcome(run.outcomes, { ...call, path: url.pathname }, result)
    // Edits that answer with the whole committed project can exceed the result budget after the
    // edit has landed; agents read the project with GET instead. Other routes keep their
    // project field, such as an interchange import preview the agent must inspect.
    const reply = call.method === 'POST' && ['/api/ops', '/api/undo', '/api/redo', '/api/new', '/api/luts/apply'].includes(url.pathname) && result && typeof result === 'object' && !Array.isArray(result) ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== 'project')) : result
    return bounded({ result: reply ?? {} }, 512 * 1024, 'The tool result exceeded 512 KiB. Use outline or bounded transcript pages.')
  }
  const drive = async (owner, run) => {
    let cursor = 0, text = ''
    try {
      while (!run.cancelled && !run.terminal && !closed) {
        assertRun(run)
        const page = await request(owner, 'GET', `/v1/runs/${run.id}/events?after=${cursor}`)
        for (const event of page.events) {
          if (!Number.isSafeInteger(event.seq) || event.seq <= cursor) throw failure('The companion returned an invalid event cursor.')
          cursor = event.seq
          assertRun(run)
          if (event.type === 'tool') {
            publish({ state: 'working', phase: event.frame ? 'Inspecting a rendered frame' : 'Working with the project' })
            let reply
            try { reply = await tool(event, run) }
            catch (error) { reply = { error: redact(error.message, [owner.token]).slice(0, 2000) } }
            assertRun(run)
            await request(owner, 'POST', `/v1/runs/${run.id}/tools/${event.callID}`, reply)
            publish({ state: 'thinking', phase: 'Waiting for the agent’s next step' })
          } else if (event.type === 'route') {
            run.routing = event.routing
            publish({ routing: event.routing, phase: `Requested route: ${event.routing.modelName ?? event.routing.model ?? names[event.routing.provider]}` })
          } else if (event.type === 'text') {
            text += String(event.text ?? '')
            if (Buffer.byteLength(text) > 512 * 1024) throw failure('The assistant reply exceeded 512 KiB.')
            publish({ state: 'thinking', text, phase: 'Generating a response' })
          } else if (event.type === 'done' || event.type === 'error') {
            const unfinished = event.type === 'done' && [...run.jobs.values()].some(job => options.jobState?.(job) === 'queued' || options.jobState?.(job) === 'running')
            run.terminal = true
            const final = unfinished ? 'The agent stopped before its processing jobs finished. Review the jobs and retry the unfinished work.' : event.type === 'done' ? String(event.text || text || 'The agent finished.') : String(event.message || 'The agent could not complete the request.')
            for (const job of run.jobs.values()) recordCompletedJobOutcome(run.outcomes, options.jobOutcome?.(job))
            const failedJobs = [...run.jobs.values()].filter(job => ['failed', 'cancelled'].includes(options.jobState?.(job)))
            const currentVersion = options.getOutline().version
            const outcome = unresolvedToolOutcome(run.outcomes) ?? (failedJobs.length ? `${failedJobs.length} processing job${failedJobs.length === 1 ? '' : 's'} did not finish. Review any committed edits.` : run.review ? 'Preview mode was on. Proposed edits are applied only when you choose Apply.' : currentVersion !== run.initialVersion ? 'The project changed during this request. Review edits in the timeline.' : 'No project edits were applied during this request.')
            publish({ state: event.type === 'done' && !unfinished ? 'done' : 'error', text: redact(final, [owner.token]).slice(0, 512 * 1024), outcome })
            options.onReply?.(state.text, event.type === 'error' || unfinished)
            if (event.type === 'error' || unfinished) await cancelJobs(run)
            break
          }
        }
        if (!run.terminal) await sleep(75)
      }
    } catch (error) {
      if (!run.cancelled && !closed) { run.terminal = true; publish({ state: 'error', text: redact(error.message, [owner.token]).slice(0, 2000) }); options.onReply?.(state.text, true) }
      await cancelJobs(run)
      await cancelRemote(run)
    } finally { if (active === run && !run.cancelled && !run.admissionUnconfirmed) active = null }
  }
  const send = async body => {
    assertOpen()
    if (active) throw failure('The assistant is still working. Cancel or wait before sending another prompt.', 409)
    if (!object(body) || typeof body.text !== 'string' || !body.text.trim() || body.text.length > 128000) throw failure('Send a nonempty prompt shorter than 128000 characters.')
    const inputKind = body.inputKind === undefined ? 'prompt' : body.inputKind
    if (!['prompt', 'script', 'screenplay'].includes(inputKind)) throw failure('Choose Prompt, Script or Screenplay.')
    bounded(body, 256 * 1024, 'The assistant request exceeded 256 KiB.')
    const selection = body.ids ?? []
    if (!Array.isArray(selection) || selection.length > 256 || selection.some(id => !identifier(id) && !(typeof id === 'string' && id.startsWith('tr:') && identifier(id.slice(3))))) throw failure('Invalid selected clip or transition IDs.')
    if (body.comp != null && !identifier(body.comp)) throw failure('Invalid composition ID.')
    if (body.playhead !== undefined && (!Number.isFinite(body.playhead) || body.playhead < 0 || body.playhead >= 1000000)) throw failure('Invalid playhead time.')
    const refs = body.refs ?? []
    if (!Array.isArray(refs) || refs.length > 64) throw failure('Use at most 64 attached references.')
    bounded(refs, 64 * 1024, 'Attached references exceeded 64 KiB.')
    // Reserve before status or model discovery can await, so Stop also owns setup.
    if (active) throw failure('The assistant is still working.', 409)
    const run = { sharingGeneration, id: randomUUID(), identity: options.getIdentity(), cancelled: false, terminal: false, jobs: new Map(), outcomes: createToolOutcomes(), review: body.review === true }
    active = run
    publish({ state: 'thinking', text: '', runId: run.id, phase: 'Connecting to your agent', startedAt: Date.now(), finishedAt: null, outcome: '', stopUnconfirmed: false, routing: null })
    let owner
    try {
      const current = await status({ wait: true })
      assertRun(run)
      if (!current.configured) throw failure(current.reason, 409)
      owner = await companion()
      run.owner = owner
      assertRun(run)
      const route = await catalogHost.resolve(settings, { text: body.text, selectionCount: selection.length, inputKind, requiresImage: true })
      assertRun(run)
      const scope = sharingScopeForRoute(route, owner.endpoint), envelope = normalizeSharingEnvelope(body.sharing)
      if (!sameSharingScope(envelope.scope, scope) || !approvedScope({ scope, credentialDigest: credentialDigest(owner) })) throw failure('Sharing permission is required for the current recipients. Review assistant sharing before sending.', 403)
      options.onPrompt?.(body.text, refs)
      assertRun(run)
      const outline = bounded(options.getOutline({ selection, comp: body.comp ?? null, playhead: body.playhead ?? 0 }), 512 * 1024, 'The project outline exceeded 512 KiB.')
      assertRun(run)
      run.initialVersion = outline.version
      const context = { inputKind, projectRoot: root, projectID: String(run.identity), projectEpoch: run.identity, version: outline.version, selection, selectedTransitions: selection.filter(id => id.startsWith('tr:')).map(id => ({ id, clip: id.slice(3) })), ...(body.comp ? { comp: body.comp } : {}), playhead: body.playhead ?? 0, refs, ...(run.review ? { review: true } : {}) }
      const requestBody = { id: run.id, sharing: envelope, provider: settings.provider, ...(settings.mode === 'auto' || settings.effort || settings.catalogBound ? { routing: settings.mode === 'auto' ? { ...settings, enabledModels: envelope.scope.models } : settings } : {}), text: body.text, context, outline, ...(settings.model ? { model: settings.model } : {}), ...(settings.agent ? { agent: settings.agent } : {}) }
      run.submission = request(owner, 'POST', '/v1/runs', requestBody)
      await run.submission
      assertRun(run)
      publish({ state: 'thinking', phase: 'Thinking about your request' })
      run.work = drive(owner, run)
      return { queued: run.id, runId: run.id, state: 'thinking', provider: settings.provider }
    } catch (error) {
      if (run.submission) await cancelRemote(run)
      await cancelJobs(run)
      if (!run.cancelled && !closed) { publish({ state: 'error', text: run.admissionUnconfirmed ? 'Agent shutdown could not be confirmed. Restart the assistant before sending another request.' : redact(error.message, [owner?.token]).slice(0, 2000), stopUnconfirmed: !!run.stopUnconfirmed }); options.onReply?.(state.text, true) }
      if (active === run && !run.cancellation && !run.admissionUnconfirmed) active = null
      run.cancelled = true
      throw error
    }
  }
  const cancel = async () => {
    assertOpen()
    const run = active
    if (!run) return { cancelled: false, state: state.state }
    if (run.cancellation) return run.cancellation
    run.cancelled = true
    publish({ state: 'cancelling', phase: 'Stopping the agent and its processing' })
    run.cancellation = (async () => {
      await cancelJobs(run)
      await cancelRemote(run)
      if (active === run) {
        if (!run.admissionUnconfirmed) active = null
        if (!closed) publish({ state: run.stopUnconfirmed ? 'error' : 'cancelled', text: run.admissionUnconfirmed ? 'Agent shutdown could not be confirmed. Restart the assistant before sending another request.' : run.stopUnconfirmed ? 'Some processing could not confirm cancellation. Review the jobs before continuing.' : state.text ? `${state.text}\n\nStopped before the reply finished.` : 'The assistant request was stopped.', phase: '', stopUnconfirmed: !!run.stopUnconfirmed })
      }
      return { cancelled: !run.stopUnconfirmed, runId: run.id, state: run.stopUnconfirmed ? 'error' : 'cancelled', stopUnconfirmed: !!run.stopUnconfirmed }
    })()
    return run.cancellation
  }
  // The finished request's outcome still describes its preview after the user applies,
  // discards or undoes it, so the chat would claim nothing was applied. Update it then.
  const settlePreview = kind => {
    if (closed || active || state.state !== 'done' || !Object.values(PREVIEW_OUTCOMES).includes(state.outcome) || !PREVIEW_OUTCOMES[kind]) return
    publish({ outcome: PREVIEW_OUTCOMES[kind] })
  }
  const close = async () => {
    if (closed) return
    closed = true
    invalidateReviews()
    catalogHost.close()
    if (active) { active.cancelled = true; await cancelJobs(active) }
    const owner = bridge ?? await bridgePromise?.catch(() => null)
    if (owner) await closeOwner(owner)
    active = null
  }
  return { status, configure, login, sharing, grantSharing, revokeSharing, send, cancel, settlePreview, close, snapshot: () => ({ sharingConsentVersion: SHARING_VERSION, ...publicStatus, ...state, ...settings, providerName: settings.mode === 'auto' ? 'Auto' : names[settings.provider], bridgeConnected: !!bridge, sharing: { approved: !!grantRecord }, usage: null }) }
}

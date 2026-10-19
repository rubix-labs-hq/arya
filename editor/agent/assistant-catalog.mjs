import { executable, providerStatus, subscriptionEnvironment } from './adapters.mjs'
import { readCodexCatalog } from './catalog-discovery.mjs'
import { CATALOG_MAX_AGE_MS, normalizeCatalog, PROVIDER_SETUP, selectRoute } from '../core/assistant-routing.mjs'

const boundedDiscovery = async run => {
  let timer
  try { return await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Custom model discovery timed out.')), 5000); timer.unref() })]) }
  finally { clearTimeout(timer) }
}

const safeReason = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) : 'Model discovery is unavailable.'

const canonicalProvider = (row, custom) => {
  const installed = typeof row.installed === 'boolean' ? row.installed : null
  const adapterSupported = ['claude-code', 'codex'].includes(row.id) && row.adapterSupported !== false
  const adapterManaged = row.id === 'custom' && !!custom
  // Configuration is a host trust decision. Keep an unknown custom auth result
  // unknown; neither a configured executable nor a timeout verifies sign-in.
  const authenticated = row.id === 'custom' ? custom ? null : false : typeof row.authenticated === 'boolean' ? row.authenticated : null
  // Older account probes omit available on success. Publish canonical readiness
  // for every client without treating missing/unknown positive facts as ready.
  const blocked = installed === false || authenticated === false || !adapterSupported || row.available === false || row.rateLimited === true
  const available = blocked ? false : installed === true && authenticated === true ? true : null
  return { ...row, installed, authenticated, available, adapterSupported,
    modelSelectionSupported: ['claude-code', 'codex'].includes(row.id),
    billingMode: ['claude-code', 'codex'].includes(row.id) ? 'subscription' : 'unknown',
    adapterManaged,
    productLoginApproval: PROVIDER_SETUP.find(item => item.id === row.id)?.productLoginApproval ?? 'unknown' }
}

// Metadata and adapter readiness are host-owned. The browser supplies preferences,
// never its own claimed models, authentication, pricing or provider capabilities.
export function createAssistantCatalog(options = {}) {
  const now = options.now ?? Date.now
  const accounts = options.providerStatus ?? providerStatus
  const resolveExecutable = options.executable ?? executable
  const discover = options.readCodexCatalog ?? readCodexCatalog
  let snapshot = { providers: [], catalogs: [], checkedAt: null, loading: false }
  let accountTime = null, pending = null, closed = false, revision = 0
  let freshQueue = Promise.resolve(), explicitRefresh = null
  const catalogTimes = new Map()
  const refresh = ({ force = false } = {}) => {
    if (closed) throw new Error('The assistant catalog has closed.')
    if (pending) return pending
    const currentRevision = revision
    pending = (async () => {
      const statuses = await accounts(options.custom)
      if (closed || revision !== currentRevision) return
      const providers = statuses.map(row => canonicalProvider(row, options.custom))
      const catalogs = [], reasons = new Map()
      for (const row of providers) {
        if (closed || revision !== currentRevision) return
        if (row.available !== true) continue
        const previous = snapshot.catalogs.find(item => item.provider === row.id)
        const attempted = catalogTimes.get(row.id)
        if (!force && previous && now() >= previous.checkedAt && now() - previous.checkedAt <= CATALOG_MAX_AGE_MS) { catalogs.push(previous); continue }
        if (!force && attempted !== undefined && now() >= attempted && now() - attempted < 15000) { reasons.set(row.id, 'Model discovery could not complete. Refresh account status shortly to retry.'); continue }
        catalogTimes.set(row.id, now())
        try {
          if (row.id === 'codex') {
            const command = await resolveExecutable('codex')
            if (!command) throw new Error('Install Codex before discovering its models.')
            catalogs.push(await discover({ executable: command, env: subscriptionEnvironment(), timeoutMs: 15000 }))
          } else if (row.id === 'custom' && options.custom?.discoverModels) {
            let records = await boundedDiscovery(() => options.custom.discoverModels())
            // Do not advertise effort that the configured executable never receives.
            if (!(options.custom.args ?? []).some(arg => arg.includes('{effort}'))) records = records.map(record => ({ ...record, supportedReasoningEfforts: [], reasoningEfforts: [], defaultReasoningEffort: null, defaultEffort: null }))
            catalogs.push(normalizeCatalog({ provider: 'custom', records, checkedAt: now(), source: { kind: 'verified-custom-adapter', label: 'Host-configured adapter discovery' } }))
          } else reasons.set(row.id, row.id === 'claude-code' ? 'Use Claude Code manually or through your own MCP connection. This CLI exposes no verified standalone account model list for Auto.' : 'This adapter has not supplied a verified model catalog.')
        } catch (error) { reasons.set(row.id, row.id === 'custom' ? 'The custom adapter could not provide a complete verified catalog. Check its local diagnostics.' : safeReason(error.message)) }
      }
      if (closed || revision !== currentRevision) return
      snapshot = { providers: providers.map(row => ({ ...row, catalogReason: reasons.get(row.id) ?? null })), catalogs, checkedAt: now(), loading: false }
      accountTime = now()
    })().catch(() => {
      if (!closed && revision === currentRevision) { snapshot = { providers: [], catalogs: [], checkedAt: now(), loading: false }; accountTime = now() }
    }).finally(() => { pending = null })
    return pending
  }
  const freshMetadata = () => {
    const fresh = freshQueue.then(async () => {
      if (pending) await pending
      do { await refresh({ force: true }) } while (accountTime === null && !closed)
      if (closed) throw new Error('The assistant catalog has closed.')
      return { ...snapshot, loading: !!pending }
    })
    freshQueue = fresh.then(() => {}, () => {})
    return fresh
  }
  return {
    async status({ wait = false, refresh: force = false } = {}) {
      if (closed) throw new Error('The assistant catalog has closed.')
      if (force) {
        // Explicit UI refreshes share one queued fresh probe; unlike a routed
        // dispatch, they do not need an individually bound account/model choice.
        if (!explicitRefresh) explicitRefresh = freshMetadata().finally(() => { explicitRefresh = null })
        return explicitRefresh
      }
      if (accountTime === null || now() < accountTime || now() - accountTime >= 15000) refresh()
      if (wait && pending) await pending
      if (wait && accountTime === null && !closed) await refresh()
      return { ...snapshot, loading: !!pending }
    },
    async resolve(preferences, request) {
      // Account probes expose sign-in status, not a trusted opaque session ID.
      // A UI cache cannot prove that the same account is still signed in. Each
      // dispatch therefore discovers afresh, after older probes finish. Serialize
      // dispatches so no account/model child processes overlap or share a catalog
      // acquired before a later dispatch was admitted. UI polls still coalesce.
      const value = await freshMetadata()
      return selectRoute({ preferences, request, catalogs: value.catalogs, providers: value.providers, now: now() })
    },
    invalidate() { revision++; accountTime = null; catalogTimes.clear(); snapshot = { ...snapshot, catalogs: [] } },
    close() { closed = true },
  }
}

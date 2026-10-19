import { execFile, spawn } from 'node:child_process'
import os from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import { normalizeCatalog } from '../core/assistant-routing.mjs'

const exec = promisify(execFile)
const message = reason => Object.assign(new Error(reason), { code: 'CATALOG_UNAVAILABLE' })
const LIMIT = 1024 * 1024

// Metadata only: this client has no thread/start, turn/start, login, config-write,
// spending, credit-reset, tool execution, or inference method in its allowlist.
export async function readCodexCatalog({ executable, env, cwd = os.tmpdir(), timeoutMs = 15000 } = {}) {
  if (typeof executable !== 'string' || !executable || !env || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw message('Model discovery needs an installed CLI and a bounded timeout.')
  let signedIn = false
  try {
    const result = await exec(executable, ['login', 'status'], { env, cwd, timeout: Math.min(5000, timeoutMs), maxBuffer: 32 * 1024, windowsHide: true })
    signedIn = /logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`)
  } catch {}
  if (!signedIn) throw message('Codex must report a ChatGPT subscription sign-in before model discovery.')
  const child = spawn(executable, ['app-server', '--stdio'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let sequence = 0, bytes = 0, partial = '', terminal = false, stderr = ''
  const decoder = new StringDecoder('utf8')
  const pending = new Map()
  const stopPending = error => { terminal = true; for (const waiting of pending.values()) waiting.reject(error); pending.clear() }
  const timeout = setTimeout(() => { stopPending(message('Model discovery timed out. Refresh the provider status and retry.')); child.kill('SIGTERM') }, timeoutMs)
  const closePromise = new Promise(resolve => child.once('close', resolve))
  child.once('error', () => stopPending(message('The installed Codex App Server could not start.')))
  child.once('close', () => stopPending(message('The installed Codex App Server closed before completing model discovery.')))
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-2000) })
  child.stdin.on('error', () => stopPending(message('The installed Codex App Server rejected its metadata stream.')))
  child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes > LIMIT) { stopPending(message('The provider catalog exceeded its 1 MiB limit.')); child.kill('SIGTERM'); return }
    partial += decoder.write(chunk)
    for (;;) {
      const split = partial.indexOf('\n')
      if (split < 0) break
      const line = partial.slice(0, split); partial = partial.slice(split + 1)
      let value
      try { value = JSON.parse(line) } catch { stopPending(message('The provider returned unreadable model metadata.')); child.kill('SIGTERM'); return }
      if (!pending.has(value.id)) continue
      const waiting = pending.get(value.id); pending.delete(value.id)
      if (value.error || !value.result || typeof value.result !== 'object') waiting.reject(message('The provider rejected read-only model discovery.'))
      else waiting.resolve(value.result)
    }
  })
  const send = value => child.stdin.write(`${JSON.stringify(value)}\n`)
  const request = (method, params) => {
    if (!['initialize', 'model/list'].includes(method)) throw message('This client accepts metadata methods only.')
    if (terminal) return Promise.reject(message('The catalog connection is no longer active.'))
    const id = ++sequence
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); send({ id, method, params }) })
  }
  try {
    await request('initialize', { clientInfo: { name: 'arya_model_catalog', title: 'Arya model catalog', version: '0.1.0' } })
    send({ method: 'initialized', params: {} })
    const records = [], cursors = new Set()
    let cursor = null
    for (let page = 0; page < 8; page++) {
      const result = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(result.data) || records.length + result.data.length > 256) throw message('The provider catalog exceeded its model limit or returned an invalid page.')
      records.push(...result.data)
      cursor = result.nextCursor ?? null
      if (cursor === null) return normalizeCatalog({ provider: 'codex', records, checkedAt: Date.now(), source: { kind: 'provider-cli', label: 'Codex App Server model/list' } })
      if (typeof cursor !== 'string' || !cursor || cursor.length > 4096 || cursors.has(cursor)) throw message('The provider returned an invalid or repeated model cursor.')
      cursors.add(cursor)
    }
    throw message('The provider catalog exceeded its page limit. No partial catalog was enabled.')
  } finally {
    clearTimeout(timeout)
    stopPending(message('Model discovery ended.'))
    child.stdin.end(); child.kill('SIGTERM')
    let escalation
    await Promise.race([closePromise, new Promise(resolve => { escalation = setTimeout(() => { child.kill('SIGKILL'); resolve() }, 1500) })])
    clearTimeout(escalation)
    // Keep provider diagnostics local. Never expose stdout/stderr or cached credentials.
    stderr = ''
  }
}

// The installed `agy models` prints exact slugs and labels, not verified model
// capabilities or prices. Its editing adapter remains independently unsupported.
export function parseAntigravityModels(output) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 64 * 1024) throw message('Antigravity model metadata exceeded its limit.')
  const records = []
  for (const line of output.split(/\r?\n/)) {
    const match = /^([a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]{0,127})\t([^\t\u0000-\u001f\u007f]+)$/.exec(line)
    if (match) records.push({ id: match[1], displayName: match[2] })
  }
  return records
}

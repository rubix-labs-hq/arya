// A stable, non-reversible name for the account a provider CLI is signed in to. A saved sharing
// permission is tied to it, so the permission holds across server restarts and is not accepted by
// a new server when another account is signed in. A running server does not read the account
// again after Allow. The identifiers are hashed at once and are never logged or stored.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { executable as findExecutable, subscriptionEnvironment } from './adapters.mjs'
import { readCodexAccount } from './catalog-discovery.mjs'

const exec = promisify(execFile)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const identifier = value => typeof value === 'string' && value.trim() !== '' && value.length <= 320 ? value.trim() : null
// An absent optional identifier is null. One of the wrong type makes the account unreadable.
const optional = value => value === undefined || value === null ? { value: null } : identifier(value) ? { value: identifier(value) } : null
const fingerprint = parts => createHash('sha256').update(JSON.stringify(['arya-account-v1', ...parts])).digest('hex')

/** From `claude auth status --json`. null unless it names a signed-in account by its address. */
export function claudeAccountFingerprint(status) {
  if (!object(status) || status.loggedIn !== true) return null
  const email = identifier(status.email), organisation = optional(status.orgId)
  if (!email || !organisation) return null
  return fingerprint(['claude-code', email.toLowerCase(), organisation.value])
}

/** From Codex App Server `account/read`. null unless a ChatGPT sign-in names its user ID. */
export function codexAccountFingerprint(result) {
  if (!object(result) || !object(result.account) || result.account.type !== 'chatgpt') return null
  const user = identifier(result.userId), workspace = optional(object(result.workspaceRouting) ? result.workspaceRouting.chatgptAccountId : undefined)
  if (!user || !workspace) return null
  return fingerprint(['codex', user, workspace.value])
}

/**
 * Returns `provider => Promise<64 hex characters | null>`. null means the account could not be
 * read, and the caller must then not accept a saved permission. Both CLIs are run with API keys
 * and session markers removed, as for a request: Claude Code names the account only then.
 */
export function createAccountFingerprint({ executable = findExecutable, environment = subscriptionEnvironment, readAccount = readCodexAccount, timeoutMs = 8000 } = {}) {
  return async provider => {
    try {
      if (provider === 'claude-code') {
        const command = await executable('claude')
        if (!command) return null
        const result = await exec(command, ['auth', 'status', '--json'], { env: environment(), timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true })
        return claudeAccountFingerprint(JSON.parse(result.stdout))
      }
      if (provider === 'codex') {
        const command = await executable('codex')
        if (!command) return null
        return codexAccountFingerprint(await readAccount({ executable: command, env: environment(), timeoutMs }))
      }
    } catch { /* Not installed, signed out, timed out or unreadable output. */ }
    return null
  }
}

// Antigravity uses a separate provider-owned sign-in profile for Arya. No credentials
// are read or copied, and the user's normal Antigravity configuration is untouched.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { subscriptionEnvironment } from './adapters.mjs'
import { executable } from './adapters.mjs'

const exec = promisify(execFile)

export const ANTIGRAVITY_MIN_VERSION = '1.4.6'
export const ANTIGRAVITY_SIGN_IN = 'Choose Sign in to Google Antigravity to authenticate Arya’s separate profile, then refresh status.'
export const antigravityHome = (home = os.homedir()) => path.join(home, '.arya', 'antigravity')

async function privateDirectory(directory) {
  try { await fs.mkdir(directory, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const stat = await fs.lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw new Error('Arya’s Antigravity profile must be a private directory owned by this user.')
  await fs.chmod(directory, 0o700)
}

async function privateJSON(file, value) {
  const temporary = path.join(path.dirname(file), `.arya-${randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally { await fs.rm(temporary, { force: true }) }
}

export const ANTIGRAVITY_SETTINGS = {
  useG1Credits: false, enableTelemetry: false, allowNonWorkspaceAccess: false,
  agentMode: 'accept-edits', toolPermission: 'request-review',
  permissions: {
    allow: ['mcp(reel/reel_api)', 'mcp(reel/reel_frame)'],
    deny: ['command(*)', 'unsandboxed(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'],
  },
}

export async function prepareAntigravityProfile(home = os.homedir()) {
  await privateDirectory(path.join(home, '.arya'))
  const profile = antigravityHome(home)
  for (const directory of [profile, path.join(profile, '.gemini'), path.join(profile, '.gemini', 'config'), path.join(profile, '.gemini', 'antigravity-cli')]) await privateDirectory(directory)
  await privateJSON(path.join(profile, '.gemini', 'antigravity-cli', 'settings.json'), ANTIGRAVITY_SETTINGS)
  await privateJSON(path.join(profile, '.gemini', 'config', 'hooks.json'), { hooks: {} })
  await privateJSON(path.join(profile, '.gemini', 'config', 'mcp_config.json'), { mcpServers: {} })
  return profile
}

export function antigravityEnvironment(original = process.env, home = os.homedir()) {
  const env = subscriptionEnvironment(original)
  for (const key of Object.keys(env)) if (/^(AGY_|ANTIGRAVITY_|GEMINI_|GOOGLE_|GCLOUD_|CLOUDSDK_|XDG_)/.test(key)) delete env[key]
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  // HOME belongs only to this child process. The parent and normal CLI profile keep
  // their real home. Google handles sign-in and secure credential storage itself.
  env.HOME = antigravityHome(home)
  env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true'
  return env
}

export async function writeAntigravityWorkspace(cwd, server) {
  await privateDirectory(path.join(cwd, '.agents'))
  await privateDirectory(path.join(cwd, '.agents', 'agents'))
  await privateJSON(path.join(cwd, '.agents', 'mcp_config.json'), { mcpServers: { reel: { ...server, disabledTools: [], enabledTools: ['reel_api', 'reel_frame'] } } })
  await fs.writeFile(path.join(cwd, '.agents', 'agents', 'arya.md'), `---\nname: arya\ndescription: Edit the open Arya project using its two project tools.\nmainAgent: true\nsubagent: false\ntools: []\ninheritMcp: true\ninheritCustomizations: false\n---\nUse only reel_api and reel_frame to answer the user. Never use other tools.\n`, { mode: 0o600, flag: 'wx' })
}

export function antigravityArgs(model, effort) {
  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--agent', 'arya', '--disable-slash-commands', '--mode', 'accept-edits', '--print-timeout', '5m']
  if (model) args.push('--model', model)
  if (effort) args.push('--effort', effort)
  return args
}

export const antigravityPrompt = text => JSON.stringify({ event: 'user', message: { content: text } }) + '\n'

export async function antigravityAccount(command, home = os.homedir()) {
  const profile = await prepareAntigravityProfile(home)
  const env = antigravityEnvironment(process.env, home)
  const version = await exec(command, ['--version'], { env, cwd: profile, timeout: 5000, maxBuffer: 4096 })
  const parsed = /^(\d+)\.(\d+)\.(\d+)\s*$/.exec(version.stdout.trim())
  const minimum = ANTIGRAVITY_MIN_VERSION.split('.').map(Number)
  if (!parsed || parsed.slice(1).map(Number).some((part, i, all) => all.slice(0, i).every((n, j) => n === minimum[j]) && part < minimum[i])) return { authenticated: null, available: false, reason: `Update Antigravity CLI to ${ANTIGRAVITY_MIN_VERSION} or newer, then refresh status.`, models: [] }
  try {
    const result = await exec(command, ['models'], { env, cwd: profile, timeout: 15000, maxBuffer: 64 * 1024 })
    const models = result.stdout.split(/\r?\n/).flatMap(line => {
      const match = /^([a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]{0,127})\t([^\t\u0000-\u001f\u007f]+)$/.exec(line)
      return match ? [{ id: match[1], displayName: match[2], inputModalities: ['text'] }] : []
    })
    if (!models.length || models.length > 256) throw new Error('Incomplete catalog')
    return { authenticated: true, available: true, models, reason: 'Antigravity confirmed account access and listed models in Arya’s separate profile. Extra AI credits are disabled.' }
  } catch (error) {
    const signedOut = !error.killed && !error.signal && /authentication required|not (?:signed|logged) in|no active.*(?:session|account)/i.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)
    return { authenticated: signedOut ? false : null, available: false, models: [], reason: signedOut ? ANTIGRAVITY_SIGN_IN : 'Antigravity account access could not be confirmed. Refresh status or check the official CLI.' }
  }
}

export function antigravityFailure(message = '') {
  const text = String(message)
  if (/authenticat|sign.?in|login|keyring/i.test(text)) return ANTIGRAVITY_SIGN_IN
  if (/quota|rate.?limit|credits|resource.exhausted|capacity/i.test(text)) return 'Antigravity could not run with your current allowance or model capacity. Retry later or choose another model. Arya does not enable extra AI credits or API billing.'
  if (/permission|denied|not allowed/i.test(text)) return 'Antigravity denied a tool request. Arya permits only its two project tools; no unrelated command or file access was approved.'
  return 'Antigravity could not complete this request. Check the official CLI, refresh status, and retry.'
}

export function antigravityOutputEvent(value) {
  // Tool validation failures are returned to the model so it can correct its call,
  // just as Claude Code and Codex do. A failed step is not a terminal CLI result.
  // Project edits and previews are recorded by the tool host, not inferred here.
  if (value?.event === 'step_update' && typeof value.step_update?.text_delta === 'string') return { type: 'text', text: value.step_update.text_delta }
  if (value?.event === 'result') return value.result?.status === 'SUCCESS' ? { type: 'done', text: String(value.result.response ?? '') } : { type: 'error', message: antigravityFailure(value.result?.error?.message ?? value.result?.error) }
  return null
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--login') {
  const command = await executable(process.argv[3] ?? 'agy')
  if (!command) throw new Error('Install Antigravity CLI using the official instructions, then sign in again.')
  const profile = await prepareAntigravityProfile()
  const child = spawn(command, [], { cwd: profile, env: antigravityEnvironment(), stdio: 'inherit' })
  child.once('error', () => { process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code ?? 1 })
}

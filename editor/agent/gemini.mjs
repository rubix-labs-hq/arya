// Google Gemini CLI (beta) adapter details. Checked against Gemini CLI 0.64.0 and its
// bundled docs. Arya never reads, copies or edits ~/.gemini; it only checks that the
// saved Google sign-in file exists.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { subscriptionEnvironment } from './adapters.mjs'

// Variables that could move a run off the Google sign-in, to another endpoint, or onto
// different settings, trust or IDE state. API keys are already removed by subscriptionEnvironment.
const STRIPPED = ['GOOGLE_GEMINI_BASE_URL', 'GOOGLE_VERTEX_BASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT_ID',
  'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_QUOTA_PROJECT', 'GOOGLE_CLOUD_ACCESS_TOKEN', 'GOOGLE_GENAI_USE_GCA', 'GEMINI_API_KEY_AUTH_MECHANISM', 'CODE_ASSIST_ENDPOINT',
  'GEMINI_CLI_HOME', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH', 'GEMINI_CLI_TRUST_WORKSPACE', 'GEMINI_CLI_TRUSTED_FOLDERS_PATH',
  'GEMINI_CLI_USE_COMPUTE_ADC', 'GEMINI_CLI_CUSTOM_HEADERS', 'GEMINI_SYSTEM_MD', 'GEMINI_WRITE_SYSTEM_MD', 'GEMINI_MODEL', 'GEMINI_SANDBOX']

export function geminiEnvironment(original = process.env) {
  const env = subscriptionEnvironment(original)
  for (const key of Object.keys(env)) if (STRIPPED.includes(key) || key.startsWith('GEMINI_CLI_IDE_')) delete env[key]
  // Forces Google account sign-in even when settings or the shell select an API key.
  env.GEMINI_CLI_AUTH_OVERRIDE = 'oauth-personal'
  env.NO_BROWSER = 'true'
  return env
}

export const geminiCredentialsPath = (home = os.homedir()) => path.join(home, '.gemini', 'oauth_creds.json')

export async function geminiSignedIn(home) {
  // Existence only. The file's contents are never read.
  try { return (await fs.stat(geminiCredentialsPath(home))).isFile() } catch { return false }
}

export const GEMINI_SIGN_IN = 'Sign in once by running gemini in Terminal and choosing Sign in with Google. Then refresh status here.'

// Admin tier outranks user and workspace policies. A global deny also hides every other
// tool from the model; only the two Reel tools are allowed.
export const GEMINI_POLICY = `[[rule]]
toolName = "*"
decision = "deny"
priority = 100
denyMessage = "Arya allows only the reel_api and reel_frame tools."

[[rule]]
mcpName = "reel"
toolName = ["reel_api", "reel_frame"]
decision = "allow"
priority = 900
`

export function geminiSettings(server) {
  return {
    security: { disableYoloMode: true },
    billing: { overageStrategy: 'never' },
    admin: { extensions: { enabled: false }, skills: { enabled: false } },
    hooksConfig: { enabled: false },
    skills: { enabled: false },
    experimental: { enableAgents: false },
    tools: { core: [] },
    context: { fileFiltering: { respectGeminiIgnore: true, enableRecursiveFileSearch: false } },
    mcp: { allowed: ['reel'] },
    // Gemini CLI redacts inherited variables whose names contain TOKEN, so the run
    // credentials are passed to the Reel MCP server explicitly.
    mcpServers: { reel: { command: server.command, args: server.args, env: server.env, includeTools: ['reel_api', 'reel_frame'], trust: false } },
  }
}

export async function writeGeminiWorkspace(cwd, server) {
  await fs.mkdir(path.join(cwd, '.gemini'), { mode: 0o700 })
  await fs.writeFile(path.join(cwd, '.gemini', 'settings.json'), JSON.stringify(geminiSettings(server)), { mode: 0o600 })
  // @path references in a prompt cannot pull run files into the request.
  await fs.writeFile(path.join(cwd, '.geminiignore'), '*\n.*\n', { mode: 0o600 })
  const policy = path.join(cwd, 'arya-policy.toml')
  await fs.writeFile(policy, GEMINI_POLICY, { mode: 0o600 })
  return policy
}

// Gemini CLI ignores --admin-policy when a system policy folder holds any .toml file,
// so Arya refuses to run rather than run without its tool limits.
export const GEMINI_SYSTEM_POLICIES = '/Library/Application Support/GeminiCli/policies'
export async function geminiSystemPolicyBlocks(directory = GEMINI_SYSTEM_POLICIES) {
  try { return (await fs.readdir(directory)).some(name => name.endsWith('.toml')) } catch { return false }
}
export const GEMINI_SYSTEM_POLICY_MESSAGE = `This Mac has system Gemini CLI policies in ${GEMINI_SYSTEM_POLICIES}, which stop Arya from limiting Gemini to its two editing tools. Use Claude Code or Codex.`

export const GEMINI_PROMPT = 'Complete the request above with the reel tools.'

export function geminiArgs(policy, model) {
  const args = ['-p', GEMINI_PROMPT, '-o', 'stream-json', '--skip-trust', '--approval-mode', 'default', '--admin-policy', policy, '--allowed-mcp-server-names', 'reel', '-e', 'none']
  if (model) args.push('-m', model)
  return args
}

const QUOTA = /\b(quota|RESOURCE_EXHAUSTED|rate.?limit|usage limit|429)\b/i
const SIGN_IN = /\b(manual authorization|authenticat|sign.?in|login required|oauth)\b/i
export const GEMINI_QUOTA_MESSAGE = 'Your Google account has reached its Gemini usage limit. Wait for the limit to reset or choose another provider. Arya does not switch to paid usage or another model.'
export const GEMINI_SIGN_IN_MESSAGE = `Gemini CLI needs you to sign in. ${GEMINI_SIGN_IN}`

function failure(message) {
  const text = String(message ?? '').slice(0, 1000)
  if (QUOTA.test(text)) return { type: 'error', message: GEMINI_QUOTA_MESSAGE }
  if (SIGN_IN.test(text)) return { type: 'error', message: GEMINI_SIGN_IN_MESSAGE }
  return { type: 'error', message: `Gemini CLI stopped: ${text || 'unknown error'}` }
}

// Maps one Gemini CLI stream-json record (headless docs: init, message, tool_use,
// tool_result, error, result) to a bridge event. Tool calls themselves are reported by
// the Reel MCP server, so tool_use adds nothing here.
export function geminiOutputEvent(value) {
  if (!value || typeof value !== 'object') return null
  switch (value.type) {
    case 'message': return value.role === 'assistant' && typeof value.content === 'string' && value.content ? { type: 'text', text: value.content } : null
    // A denied or failed tool call is non-fatal to Gemini CLI and can still exit 0.
    // Arya treats it as a failed run so a blocked edit is never reported as done.
    case 'tool_result': return value.status === 'success' ? null : failure(`A tool call failed or was denied. ${value.error?.message ?? ''}`.trim())
    case 'error': return value.severity === 'warning' ? null : failure(value.message)
    case 'result': return value.status === 'success' ? { type: 'done' } : failure(value.error?.message ?? 'The run failed.')
    default: return null
  }
}

// Exit codes from Gemini CLI 0.64.0: 41 authentication, 42 input, 44 sandbox, 52 config,
// 53 turn limit, 54 tool execution, 55 untrusted workspace, 130 cancelled.
export function geminiExitMessage(code, stderr = '') {
  if (code === 41) return GEMINI_SIGN_IN_MESSAGE
  if (QUOTA.test(stderr)) return GEMINI_QUOTA_MESSAGE
  if (code === 53) return 'Gemini CLI reached its turn limit before finishing. Review any edits, then send a shorter follow-up.'
  if (code === 52) return 'Gemini CLI rejected its run settings. Update Gemini CLI, then retry.'
  if (code === 55) return 'Gemini CLI did not trust the private run folder. Update Gemini CLI, then retry.'
  return null
}

// Fixed list from the model registry in the Gemini CLI 0.64.0 configuration reference.
// The CLI has no model-list command, so availability on a given account is not checked.
// Image input reflects the registry's multimodalToolUse flag (frames from reel_frame).
const MODELS = [
  ['gemini-3.1-pro-preview', 'Gemini 3.1 Pro Preview', 'pro', true, true],
  ['gemini-3-pro-preview', 'Gemini 3 Pro Preview', 'pro', true, true],
  ['gemini-3.8-flash', 'Gemini 3.8 Flash', 'flash', false, true],
  ['gemini-3.5-flash', 'Gemini 3.5 Flash', 'flash', false, true],
  ['gemini-3-flash-preview', 'Gemini 3 Flash Preview', 'flash', true, true],
  ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 'flash-lite', false, true],
  ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 'flash-lite', false, true],
  ['gemini-2.5-pro', 'Gemini 2.5 Pro', 'pro', false, false],
  ['gemini-2.5-flash', 'Gemini 2.5 Flash', 'flash', false, false],
  ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite', 'flash-lite', false, false],
]
const TIER = { pro: 'For complex reasoning tasks.', flash: 'Fast, balanced model for most tasks.', 'flash-lite': 'Fastest model for simple tasks.' }

export function geminiCatalogRecords() {
  return MODELS.map(([model, displayName, tier, preview, image]) => ({ model, displayName,
    description: `${TIER[tier]}${preview ? ' Preview; may not be available on every account.' : ''}${image ? '' : ' Gemini CLI does not pass tool images to this model.'}`,
    inputModalities: image ? ['text', 'image'] : ['text'], supportedReasoningEfforts: [] }))
}

export const GEMINI_CATALOG_SOURCE = { kind: 'provider-docs', label: 'Fixed list from the Gemini CLI 0.64 documentation. Not checked against your account. Google may switch to a Flash model when quota runs out.' }

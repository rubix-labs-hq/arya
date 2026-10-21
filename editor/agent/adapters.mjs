import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { INSTRUCTIONS, promptFor, redact } from './protocol.mjs'

const exec = promisify(execFile)
const directory = path.dirname(fileURLToPath(import.meta.url))
export const PROVIDERS = ['claude-code', 'codex', 'antigravity', 'custom']
const codexDisabledFeatures = ['shell_tool', 'view_image', 'multi_agent', 'multi_agent_v2', 'hooks', 'apps', 'plugins', 'memories', 'shell_snapshot', 'skill_mcp_dependency_install', 'browser_use', 'computer_use', 'image_generation', 'skill_search', 'workspace_dependencies', 'in_app_browser', 'in_app_local_automation', 'daemon_auto_start']

export function subscriptionEnvironment(original = process.env) {
  const env = { ...original }
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_FEDERATION_RULE_ID', 'OPENAI_IDENTITY_TOKEN_FILE', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'AGY_GATEWAY_API_KEY', 'AGY_GATEWAY_URL', 'AGY_ADC_AUTH', 'GOOGLE_GENAI_USE_VERTEXAI', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[key]
  return env
}

export async function executable(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null
  const candidates = name.includes('/') ? [path.resolve(name)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name))
  for (const candidate of candidates) { try { await fs.access(candidate, fs.constants.X_OK); if ((await fs.stat(candidate)).isFile()) return candidate } catch {} }
  return null
}

export async function providerStatus(custom) {
  const values = await Promise.all(PROVIDERS.map(async id => {
    const command = await executable(id === 'claude-code' ? 'claude' : id === 'antigravity' ? 'agy' : id === 'custom' ? custom?.executable ?? '' : 'codex')
    if (!command) return { id, installed: false, authenticated: false, reason: id === 'custom' ? 'Custom editing is unavailable on this host. Choose Claude Code or Codex.' : `Install and sign in to ${id === 'claude-code' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Google Antigravity'} on the computer running Arya.` }
    if (id === 'custom') return { id, installed: true, authenticated: null, available: false, adapterSupported: false, authentication: 'unverified-custom', reason: 'Custom editing is unavailable on this host. A configured executable does not verify account login or subscription access. Choose Claude Code or Codex.' }
    if (id === 'antigravity') return { id, installed: true, authenticated: null, available: false, authentication: 'existing-cli-sign-in', reason: 'Google Antigravity CLI is installed. Arya has not verified its account login or an isolated editing adapter. Check account setup in the official CLI; built-in editing remains unavailable.' }
    try {
      const args = id === 'claude-code' ? ['auth', 'status', '--json'] : id === 'codex' ? ['login', 'status'] : ['models']
      const result = await exec(command, args, { env: subscriptionEnvironment(), timeout: 15000, maxBuffer: 64 * 1024, windowsHide: true })
      if (id === 'claude-code') {
        const status = JSON.parse(result.stdout)
        const authenticated = status.loggedIn === true && /oauth|claude/i.test(status.authMethod ?? '') && status.apiProvider !== 'bedrock' && status.apiProvider !== 'vertex'
        return { id, installed: true, authenticated, authentication: 'existing-cli-sign-in', reason: authenticated ? 'Claude Code reports an existing Claude account login.' : 'Run claude auth login and choose your Claude subscription account.' }
      }
      const authenticated = id === 'codex' ? /logged in using chatgpt/i.test(`${result.stdout}\n${result.stderr}`) : result.stdout.trim().length > 0
      return { id, installed: true, authenticated, authentication: 'existing-cli-sign-in', reason: authenticated ? 'Codex reports an existing ChatGPT login.' : 'Sign in to Codex with your ChatGPT account.' }
    } catch (error) {
      let signedOut = false
      if (!error.killed && !error.signal) {
        if (id === 'claude-code') { try { signedOut = JSON.parse(error.stdout).loggedIn === false } catch {} }
        else if (id === 'codex') signedOut = /not logged in/i.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)
      }
      return { id, installed: true, authenticated: signedOut ? false : null, available: false, authentication: 'existing-cli-sign-in', reason: signedOut ? `Sign in to ${id} in Terminal. Arya never reads or copies the CLI's credentials.` : 'Account status could not be confirmed. Refresh status or check the provider CLI; this does not establish that you are signed out.' }
    }
  }))
  return values
}

export async function prepareAdapter(request, transport, custom) {
  if (request.provider === 'custom') {
    if (request.model && !(custom?.args ?? []).some(value => value.includes('{model}'))) throw new Error('This custom adapter cannot bind an exact requested model. Configure a literal {model} argument or use its explicit provider default.')
    if (request.effort && !(custom?.args ?? []).some(value => value.includes('{effort}'))) throw new Error('This custom adapter cannot bind the requested reasoning effort.')
  }
  if (['antigravity', 'gemini-cli'].includes(request.provider)) throw new Error('Google subscription editing is unavailable in Arya. Account sign-in, isolated tool permissions and additional-credit controls have not been verified for this adapter. Arya does not change global permissions or use an API fallback. Use Claude Code or Codex.')
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'reel-agent-'))
  await fs.chmod(cwd, 0o700)
  try {
    const env = { ...(request.provider === 'custom' ? process.env : subscriptionEnvironment()), REEL_AGENT_ENDPOINT: transport.endpoint, REEL_AGENT_RUN_ID: request.id, REEL_AGENT_RUN_TOKEN: transport.token }
    const server = { command: process.execPath, args: [path.join(directory, 'mcp.mjs')], env: { REEL_AGENT_ENDPOINT: transport.endpoint, REEL_AGENT_RUN_ID: request.id, REEL_AGENT_RUN_TOKEN: transport.token } }
    const mcpConfig = path.join(cwd, 'mcp.json')
    await fs.writeFile(mcpConfig, JSON.stringify({ mcpServers: { reel: server } }), { mode: 0o600 })
    await fs.writeFile(path.join(cwd, 'context.json'), JSON.stringify({ context: request.context, outline: request.outline }), { mode: 0o600 })
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), INSTRUCTIONS, { mode: 0o600 })
    const prompt = promptFor(request)
    let command, args
    if (request.provider === 'claude-code') {
      command = await executable('claude')
      args = ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', '--tools', '', '--allowedTools', 'mcp__reel__reel_api,mcp__reel__reel_frame', '--strict-mcp-config', '--mcp-config', mcpConfig, '--setting-sources', '', '--settings', '{"disableAllHooks":true}', '--disable-slash-commands', '--no-session-persistence', '--permission-mode', 'dontAsk', '--append-system-prompt', INSTRUCTIONS]
      if (request.model) args.push('--model', request.model)
      if (request.agent) args.push('--agent', request.agent)
      if (request.effort) args.push('--effort', request.effort)
    } else if (request.provider === 'codex') {
      command = await executable('codex')
      args = ['exec', '--json', '--strict-config', '--sandbox', 'read-only', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', ...codexDisabledFeatures.flatMap(name => ['--disable', name]), '-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', '-c', `developer_instructions=${JSON.stringify(INSTRUCTIONS)}`, '-c', `mcp_servers.reel.command=${JSON.stringify(process.execPath)}`, '-c', `mcp_servers.reel.args=${JSON.stringify(server.args)}`, '-c', 'mcp_servers.reel.env_vars=["REEL_AGENT_ENDPOINT","REEL_AGENT_RUN_ID","REEL_AGENT_RUN_TOKEN"]', '-c', 'mcp_servers.reel.enabled_tools=["reel_api","reel_frame"]', '-c', 'mcp_servers.reel.required=true', '-c', 'mcp_servers.reel.default_tools_approval_mode="auto"', '-c', 'mcp_servers.reel.tool_timeout_sec=125', '-']
      if (request.model) args.splice(1, 0, '--model', request.model)
      if (request.effort) args.splice(1, 0, '-c', `model_reasoning_effort=${JSON.stringify(request.effort)}`)
      if (request.agent) throw new Error('Codex CLI does not expose an agent selector; leave Agent empty or use a custom executable.')
    } else {
      command = custom && await executable(custom.executable)
      args = (custom?.args ?? []).map(value => value.replaceAll('{mcpConfig}', mcpConfig).replaceAll('{context}', path.join(cwd, 'context.json')).replaceAll('{model}', request.model ?? '').replaceAll('{effort}', request.effort ?? ''))
    }
    if (!command) throw new Error(`The ${request.provider} executable is unavailable. Install and sign in to its CLI, then refresh Assistant settings.`)
    return { command, args, cwd, env, prompt, cleanup: () => fs.rm(cwd, { recursive: true, force: true }) }
  } catch (error) { await fs.rm(cwd, { recursive: true, force: true }); throw error }
}

export function outputEvent(provider, line) {
  let value
  try { value = JSON.parse(line) } catch { return provider === 'custom' && line.trim() ? { type: 'text', text: line } : null }
  if (value.event === 'step_update' && typeof value.step_update?.text_delta === 'string') return { type: 'text', text: value.step_update.text_delta }
  if (value.event === 'result') return value.result?.status === 'SUCCESS' ? { type: 'done', text: String(value.result.response ?? '') } : { type: 'error', message: String(value.result?.error?.message ?? value.result?.error ?? 'Antigravity run failed') }
  if (value.type === 'error' || value.type === 'result' && value.is_error) return { type: 'error', message: value.error?.message ?? value.error ?? value.result ?? value.message ?? 'Agent run failed' }
  if (value.type === 'result' && typeof value.result === 'string') return { type: 'done', text: value.result }
  if (value.type === 'stream_event' && value.event?.delta?.type === 'text_delta') return { type: 'text', text: value.event.delta.text }
  if (value.type === 'assistant' && value.message?.content) return { type: 'text', text: value.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') }
  if (value.type === 'item.completed' && value.item?.type === 'agent_message') return { type: 'text', text: value.item.text }
  if (value.type === 'message' && typeof value.content === 'string') return { type: 'text', text: value.content }
  if (value.type === 'text' && typeof value.text === 'string') return { type: 'text', text: value.text }
  if (value.type === 'done') return { type: 'done', ...(value.text ? { text: String(value.text) } : {}) }
  return null
}

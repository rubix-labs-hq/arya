#!/usr/bin/env node
// Fake Gemini CLI 0.64 for adapter tests. It reads the per-run workspace settings, starts
// the configured Reel MCP server, and prints stream-json records like the real CLI.
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const mode = process.env.FAKE_GEMINI_MODE ?? 'edit'
const stdin = fs.readFileSync(0, 'utf8')
const out = value => process.stdout.write(`${JSON.stringify(value)}\n`)
const settings = JSON.parse(fs.readFileSync('.gemini/settings.json', 'utf8'))
if (process.env.FAKE_GEMINI_RECORD) {
  const policy = fs.readFileSync(argv[argv.indexOf('--admin-policy') + 1], 'utf8')
  const keys = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GEMINI_CLI_HOME',
    'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'GEMINI_CLI_TRUST_WORKSPACE', 'GEMINI_CLI_IDE_SERVER_PORT', 'GEMINI_SYSTEM_MD', 'GEMINI_CLI_AUTH_OVERRIDE', 'NO_BROWSER']
  fs.writeFileSync(process.env.FAKE_GEMINI_RECORD, JSON.stringify({ argv, cwd: process.cwd(), env: Object.fromEntries(keys.map(key => [key, process.env[key] ?? null])),
    request: stdin.includes('<user_request>'), settings, policy, ignore: fs.readFileSync('.geminiignore', 'utf8') }))
}
if (mode === 'auth') { process.stderr.write('Manual authorization is required but the current session is non-interactive.\n'); process.exit(41) }
out({ type: 'init', timestamp: new Date().toISOString(), session_id: 'fixture', model: 'gemini-3-pro-preview' })
out({ type: 'message', timestamp: new Date().toISOString(), role: 'user', content: stdin })
if (mode === 'denied') {
  out({ type: 'tool_use', tool_name: 'run_shell_command', tool_id: 'call-1', parameters: { command: 'ls' } })
  out({ type: 'tool_result', tool_id: 'call-1', status: 'error', output: '', error: { type: 'POLICY_VIOLATION', message: 'Arya allows only the reel_api and reel_frame tools.' } })
  out({ type: 'message', role: 'assistant', content: 'I could not run that.', delta: true })
  out({ type: 'result', status: 'success', stats: {} })
  process.exit(0)
}
const server = settings.mcpServers.reel
const child = spawn(server.command, server.args, { env: { PATH: process.env.PATH, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] })
let buffer = '', next = 1
const waiting = new Map()
child.stdout.on('data', chunk => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
    const message = JSON.parse(line); waiting.get(message.id)?.(message); waiting.delete(message.id)
  }
})
const rpc = (method, params) => new Promise(resolve => { const id = next++; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`) })
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-gemini', version: '0' } })
const tools = (await rpc('tools/list', {})).result.tools.map(tool => tool.name)
out({ type: 'tool_use', tool_name: 'reel_api', tool_id: 'call-1', parameters: { method: 'GET', path: '/api/project' } })
const result = await rpc('tools/call', { name: 'reel_api', arguments: { method: 'GET', path: '/api/project' } })
out({ type: 'tool_result', tool_id: 'call-1', status: result.result && !result.result.isError ? 'success' : 'error', output: JSON.stringify(result.result ?? result.error) })
out({ type: 'error', severity: 'warning', message: 'Loop detection warning from the fixture.' })
out({ type: 'message', role: 'assistant', content: `Read the project with ${tools.join(' and ')}.`, delta: true })
out({ type: 'message', role: 'assistant', content: ' Done.', delta: true })
out({ type: 'result', status: 'success', stats: {} })
child.stdin.end()

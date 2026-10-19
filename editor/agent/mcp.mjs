#!/usr/bin/env node
import { TOOLS, UUID, validateCall } from './protocol.mjs'

const endpoint = process.env.REEL_AGENT_ENDPOINT, runID = process.env.REEL_AGENT_RUN_ID, token = process.env.REEL_AGENT_RUN_TOKEN
const base = endpoint && new URL(endpoint)
if (!base || base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash || !UUID.test(runID ?? '') || !/^[a-f0-9]{64}$/.test(token ?? '')) {
  process.stderr.write('Reel MCP requires a local run endpoint and token. Launch it through the paired bridge.\n'); process.exit(1)
}
let initialized = false, buffer = '', active = 0
const send = message => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)

async function request(method, path, body) {
  const response = await fetch(new URL(path, base), { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(125000) })
  const text = await response.text()
  if (text.length > 6 * 1024 * 1024) throw new Error('Reel tool result exceeded its limit')
  const value = JSON.parse(text)
  if (!response.ok) throw new Error(value.error ?? `Reel HTTP ${response.status}`)
  return value
}

async function tool(name, args) {
  const call = validateCall(name, args)
  const { callID } = await request('POST', `/v1/runs/${runID}/calls`, call)
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const value = await request('GET', `/v1/runs/${runID}/calls/${callID}`)
    if (!value.pending) {
      if (value.error) return { isError: true, content: [{ type: 'text', text: String(value.error) }] }
      if (value.image) {
        const { data, mediaType } = value.image
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(mediaType) || typeof data !== 'string' || data.length > 5592408 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('Invalid Reel frame result')
        return { content: [{ type: 'image', data, mimeType: mediaType }] }
      }
      const result = value.result ?? {}
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(result && typeof result === 'object' && !Array.isArray(result) ? { structuredContent: result } : {}) }
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Reel tool exceeded two minutes; inspect the project before retrying')
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return send({ id: message?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request' } })
  if (!Object.hasOwn(message, 'id')) return
  if (++active > 8) { active--; return send({ id: message.id, error: { code: -32000, message: 'Too many concurrent Reel requests' } }) }
  try {
    let result
    if (message.method === 'initialize') {
      initialized = true
      const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
      result = { protocolVersion: versions.includes(message.params?.protocolVersion) ? message.params.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'reel-mcp-server', version: '1.0.0' }, instructions: 'Native project tools act only on the immutable project associated with this run.' }
    } else if (message.method === 'ping') result = {}
    else if (!initialized) throw new Error('Initialize the MCP session first')
    else if (message.method === 'tools/list') result = { tools: TOOLS }
    else if (message.method === 'tools/call') result = await tool(message.params?.name, message.params?.arguments)
    else { send({ id: message.id, error: { code: -32601, message: 'Method not found' } }); return }
    send({ id: message.id, result })
  } catch (error) { send({ id: message.id, error: { code: -32602, message: String(error.message).slice(0, 2000) } }) }
  finally { active-- }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buffer += chunk
  if (buffer.length > 1024 * 1024) { process.stderr.write('MCP input exceeded 1 MiB\n'); process.exit(1) }
  let boundary
  while ((boundary = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1)
    if (line.trim()) { try { void handle(JSON.parse(line)) } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }) } }
  }
})
process.stdin.once('end', () => process.exit(0))
process.stdin.once('error', () => process.exit(1))

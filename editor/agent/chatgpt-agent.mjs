#!/usr/bin/env node
// Arya's ChatGPT agent. The bridge starts one per run when the user chose ChatGPT.
// stdin: {instructions, input}. stdout: one JSON record per line, {type:'text'|'done'|'error'}.
// Before each OpenAI request it asks the bridge for a current access token, so the parent
// process keeps refresh and storage. Arya's two tools run through the bridge's /calls route.
// Request rules follow OpenAI's Sign in with ChatGPT docs: store:false, stream:true, input as
// an array, rules in instructions, tools in a namespace, success only on response.completed.
import { TOOLS, UUID, validateCall } from './protocol.mjs'

const PRODUCTION_API = 'https://api.openai.com/v1'
const NAMESPACE = 'arya'
const MAX_TURNS = 40, MAX_TOOL_CALLS = 96
const MAX_STDIN = 24 * 1024 * 1024, MAX_STREAM = 32 * 1024 * 1024, MAX_EVENT = 16 * 1024 * 1024, MAX_BODY = 32 * 1024 * 1024
const RETRY_DELAYS = [800, 2400]
const IDLE_MS = 120000
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

const endpoint = process.env.REEL_AGENT_ENDPOINT, runID = process.env.REEL_AGENT_RUN_ID, token = process.env.REEL_AGENT_RUN_TOKEN
const base = endpoint && URL.canParse(endpoint) ? new URL(endpoint) : null
if (!base || base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.username || base.password || base.pathname !== '/' || base.search || base.hash || !UUID.test(runID ?? '') || !/^[a-f0-9]{64}$/.test(token ?? '')) {
  process.stderr.write('The ChatGPT agent requires a local run endpoint and token. Arya starts it through its bridge.\n'); process.exit(1)
}
const requestedModel = process.env.ARYA_CHATGPT_MODEL ?? ''
if (requestedModel && !/^[A-Za-z0-9._:-]{1,128}$/.test(requestedModel)) { process.stderr.write('Invalid ChatGPT model.\n'); process.exit(1) }

class AgentError extends Error {
  constructor(message, code) { super(message); this.code = code }
}

const write = record => process.stdout.write(`${JSON.stringify(record)}\n`)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 240)
const requestNote = id => id ? ` Request ID: ${id}.` : ''

// Text is batched so a long reply stays well inside the bridge's event limit.
let pendingText = '', flushTimer = null, textRecords = 0, wroteText = false, breakBeforeText = false
function flushText() {
  clearTimeout(flushTimer); flushTimer = null
  if (!pendingText) return
  write({ type: 'text', text: pendingText }); pendingText = ''; textRecords++
}
function addText(text) {
  if (!text) return
  if (breakBeforeText && wroteText) pendingText += '\n\n'
  breakBeforeText = false; wroteText = true
  pendingText += text
  const many = textRecords > 1000
  if (pendingText.length >= (many ? 8192 : 2048)) flushText()
  else if (!flushTimer && !many) flushTimer = setTimeout(flushText, 150)
}

async function bridge(method, path, body) {
  const response = await fetch(new URL(path, base), { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(125000) })
  const text = await response.text()
  if (text.length > 6 * 1024 * 1024) throw new Error('Arya tool result exceeded its limit')
  let value
  try { value = JSON.parse(text) } catch { throw new Error(`Arya returned HTTP ${response.status}`) }
  if (!response.ok) { const error = new Error(String(value?.error ?? `Arya HTTP ${response.status}`)); error.status = response.status; error.code = value?.code; throw error }
  return value
}

async function credential() {
  let value
  try { value = await bridge('POST', `/v1/runs/${runID}/credential`, {}) }
  catch (error) {
    if (error.status === 410) throw new AgentError('The request was stopped.', 'chatgpt_failed')
    throw new AgentError(clean(error.message) || 'Sign in with ChatGPT again in Assistant settings.', /^chatgpt_[a-z_]{1,48}$/.test(error.code ?? '') ? error.code : 'chatgpt_sign_in_required')
  }
  const api = typeof value?.api === 'string' && URL.canParse(value.api) ? new URL(value.api) : null
  const local = api && api.protocol === 'http:' && api.hostname === '127.0.0.1' && api.port && api.pathname === '/v1'
  if (!api || !(api.href === `${PRODUCTION_API}` || local) || api.search || api.hash || api.username || api.password) throw new AgentError('Arya received an unexpected ChatGPT endpoint.', 'chatgpt_failed')
  if (typeof value.accessToken !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(value.accessToken)) throw new AgentError('Sign in with ChatGPT again in Assistant settings.', 'chatgpt_sign_in_required')
  return { accessToken: value.accessToken, api: api.href.replace(/\/$/, '') }
}

// Documented recovery for each ChatGPT plan error. Codes and request IDs are kept; bodies are not echoed.
function planError(status, error, requestID) {
  const code = typeof error?.code === 'string' ? error.code : ''
  const note = requestNote(requestID)
  if (code === 'subscription_sharing_usage_limit_exceeded') return new AgentError(`You reached the ChatGPT plan usage limit for Arya. Check Manage usage in ChatGPT settings, then try again later.${note}`, 'chatgpt_usage_limit')
  if (code === 'subscription_sharing_user_not_eligible') return new AgentError(`ChatGPT plan usage is not available for this account, workspace or policy. Manual editing still works.${note}`, 'chatgpt_not_eligible')
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable') return Object.assign(new AgentError(`ChatGPT could not check your plan usage right now. Try again in a few minutes.${note}`, 'chatgpt_unavailable'), { retry: true })
  if (code === 'subscription_sharing_unsupported_capability') return new AgentError(`ChatGPT plan usage does not support part of this request${error?.param ? ` (${clean(error.param).slice(0, 80)})` : ''}. Try another ChatGPT model.${note}`, 'chatgpt_unsupported')
  if (code === 'subscription_sharing_route_not_supported') return new AgentError(`OpenAI did not accept this request route for ChatGPT plan usage.${note}`, 'chatgpt_unsupported')
  if (code === 'subscription_sharing_invalid_user' || status === 401) return new AgentError(`ChatGPT did not accept this sign-in. If it happens again, sign out and continue with ChatGPT again in Assistant settings.${note}`, 'chatgpt_not_authorized')
  if (code.startsWith('chatpass_v2_')) return new AgentError(`OpenAI did not authorize ChatGPT plan usage for this request (${clean(code).slice(0, 64)}). Turn ChatGPT plan usage on again in Assistant settings.${note}`, 'chatgpt_not_authorized')
  if (status === 403) return new AgentError(`OpenAI blocked ChatGPT plan usage for this request${error?.detail ? `: ${clean(error.detail).slice(0, 160)}` : '.'}${note}`, 'chatgpt_not_eligible')
  if (status === 429 || status >= 500) return Object.assign(new AgentError(`ChatGPT is busy or unavailable right now. Try again in a few minutes.${note}`, 'chatgpt_unavailable'), { retry: true })
  return new AgentError(`ChatGPT could not complete the request${code ? ` (${clean(code).slice(0, 64)})` : ''}.${note}`, 'chatgpt_failed')
}

async function* events(response, controller) {
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', total = 0, idle
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => controller.abort(), IDLE_MS) }
  arm()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      arm()
      total += value.length
      if (total > MAX_STREAM) throw new AgentError('The ChatGPT reply exceeded Arya’s size limit.', 'chatgpt_limit')
      buffer += decoder.decode(value, { stream: true })
      let boundary
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '')
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
        if (!data || data === '[DONE]') continue
        let parsed
        try { parsed = JSON.parse(data) } catch { throw new AgentError('ChatGPT sent an unreadable reply.', 'chatgpt_stream_interrupted') }
        yield parsed
      }
      if (buffer.length > MAX_EVENT) throw new AgentError('A ChatGPT reply event exceeded Arya’s size limit.', 'chatgpt_limit')
    }
  } finally { clearTimeout(idle); reader.releaseLock?.() }
}

// One model turn. Returns the output items once response.completed arrives.
async function turn(body) {
  for (let attempt = 0; ; attempt++) {
    const { accessToken, api } = await credential()
    const controller = new AbortController()
    let response
    const connecting = setTimeout(() => controller.abort(), IDLE_MS)
    try {
      response = await fetch(`${api}/responses`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body), redirect: 'error', signal: controller.signal })
    } catch {
      if (attempt < RETRY_DELAYS.length) { await delay(RETRY_DELAYS[attempt]); continue }
      throw new AgentError('Arya could not reach OpenAI. Check your internet connection and try again.', 'chatgpt_network')
    } finally { clearTimeout(connecting) }
    const requestID = /^[A-Za-z0-9_-]{1,128}$/.test(response.headers.get('x-request-id') ?? '') ? response.headers.get('x-request-id') : null
    if (!response.ok) {
      let parsed = null
      try { const text = await response.text(); parsed = text.length <= 65536 ? JSON.parse(text) : null } catch {}
      const error = planError(response.status, parsed?.error ?? (typeof parsed?.detail === 'string' ? { detail: parsed.detail } : null), requestID)
      if (error.retry && attempt < RETRY_DELAYS.length) { await delay(RETRY_DELAYS[attempt]); continue }
      throw error
    }
    const items = []
    let completed = null, streamed = false
    try {
      for await (const event of events(response, controller)) {
        streamed = true
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') addText(event.delta)
        else if (event.type === 'response.output_item.done' && event.item && typeof event.item === 'object') items.push(event.item)
        else if (event.type === 'response.completed') { completed = event.response ?? {}; break }
        else if (event.type === 'response.failed') throw planError(200, event.response?.error, requestID)
        else if (event.type === 'response.incomplete') throw new AgentError(`ChatGPT stopped before finishing${event.response?.incomplete_details?.reason ? ` (${clean(event.response.incomplete_details.reason).slice(0, 64)})` : ''}. Try a shorter request.${requestNote(requestID)}`, 'chatgpt_incomplete')
        else if (event.type === 'error') throw planError(200, event.error ?? event, requestID)
      }
    } catch (error) {
      if (error instanceof AgentError) throw error
      throw new AgentError(`The ChatGPT connection ended early. Try again.${requestNote(requestID)}`, 'chatgpt_stream_interrupted')
    } finally { controller.abort() }
    if (!completed) throw new AgentError(`The ChatGPT connection ended before the reply finished. Try again.${requestNote(requestID)}`, streamed ? 'chatgpt_stream_interrupted' : 'chatgpt_failed')
    return Array.isArray(completed.output) && completed.output.length ? completed.output : items
  }
}

async function chooseModel() {
  if (requestedModel) return requestedModel
  const { accessToken, api } = await credential()
  let response
  try { response = await fetch(`${api}/models`, { headers: { authorization: `Bearer ${accessToken}` }, redirect: 'error', signal: AbortSignal.timeout(20000) }) }
  catch { throw new AgentError('Arya could not reach OpenAI. Check your internet connection and try again.', 'chatgpt_network') }
  let value = null
  try { value = await response.json() } catch {}
  if (!response.ok) throw planError(response.status, value?.error ?? (typeof value?.detail === 'string' ? { detail: value.detail } : null), null)
  const slug = (Array.isArray(value?.models) ? value.models : []).find(item => item?.visibility === 'list' && /^[A-Za-z0-9._:-]{1,128}$/.test(item.slug ?? ''))?.slug
  if (!slug) throw new AgentError('OpenAI lists no ChatGPT models for this account.', 'chatgpt_unsupported')
  return slug
}

// Replayed output keeps every model item in order. Item IDs and status are dropped because
// store:false keeps nothing on OpenAI's side to refer back to.
function replayable(item) {
  if (!item || typeof item !== 'object' || !['reasoning', 'message', 'function_call'].includes(item.type)) return null
  if (item.type === 'message' && item.role !== 'assistant') return null
  const { id, status, ...rest } = item
  if (rest.type === 'reasoning' && !Array.isArray(rest.summary)) rest.summary = []
  return rest
}

async function runTool(call) {
  if (!['reel_api', 'reel_frame'].includes(call.name) || call.namespace !== undefined && call.namespace !== NAMESPACE) return JSON.stringify({ error: 'Use arya.reel_api or arya.reel_frame.' })
  let args
  try {
    if (typeof call.arguments !== 'string' || call.arguments.length > 1024 * 1024) throw new Error('Tool arguments are too large')
    args = validateCall(call.name, JSON.parse(call.arguments || '{}'))
  } catch (error) { return JSON.stringify({ error: clean(error.message) || 'Invalid tool arguments' }) }
  let callID
  try { ({ callID } = await bridge('POST', `/v1/runs/${runID}/calls`, args)) }
  catch (error) {
    if (error.status === 410) throw new AgentError('The request was stopped.', 'chatgpt_failed')
    return JSON.stringify({ error: clean(error.message) || 'Arya could not run the tool' })
  }
  const deadline = Date.now() + 120000
  while (Date.now() < deadline) {
    const value = await bridge('GET', `/v1/runs/${runID}/calls/${callID}`)
    if (!value.pending) {
      if (value.error) return JSON.stringify({ error: String(value.error).slice(0, 2000) })
      if (value.image) {
        const { data, mediaType } = value.image
        if (!IMAGE_TYPES.includes(mediaType) || typeof data !== 'string' || data.length > 5592408 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return JSON.stringify({ error: 'Arya returned an invalid frame image' })
        return [{ type: 'input_image', image_url: `data:${mediaType};base64,${data}` }]
      }
      return JSON.stringify(value.result ?? {})
    }
    await delay(100)
  }
  return JSON.stringify({ error: 'Arya tool exceeded two minutes; inspect the project before retrying' })
}

// Older frames give way first when the request would grow past its size limit.
function fit(body) {
  for (;;) {
    if (Buffer.byteLength(JSON.stringify(body)) <= MAX_BODY) return
    const old = body.input.find(item => item.type === 'function_call_output' && Array.isArray(item.output))
    if (!old) throw new AgentError('This request grew past the ChatGPT request size limit. Start a new request.', 'chatgpt_limit')
    old.output = JSON.stringify({ note: 'An earlier frame image was removed to keep the request within its size limit.' })
  }
}

async function main() {
  const chunks = []; let size = 0
  for await (const chunk of process.stdin) { size += chunk.length; if (size > MAX_STDIN) throw new AgentError('The request was too large for ChatGPT.', 'chatgpt_limit'); chunks.push(chunk) }
  let request
  try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { request = null }
  if (typeof request?.instructions !== 'string' || !Array.isArray(request.input) || !request.input.length) throw new AgentError('The ChatGPT request could not be read.', 'chatgpt_failed')
  const frame = TOOLS.find(tool => tool.name === 'reel_frame'), api = TOOLS.find(tool => tool.name === 'reel_api')
  const tools = [{
    type: 'namespace', name: NAMESPACE, description: 'Tools for the open Arya project. They act only on this project and cannot reach other apps, accounts or the internet.',
    tools: [
      { type: 'function', name: 'reel_api', description: api.description, parameters: api.inputSchema, strict: false },
      // OpenAI rejects oneOf and not at the top level, so the rule is in the description. validateCall still enforces it.
      { type: 'function', name: 'reel_frame', description: `${frame.description} Send either at (with optional width and comp) or src alone.`, parameters: { type: 'object', properties: frame.inputSchema.properties, additionalProperties: false }, strict: false },
    ],
  }]
  const body = { model: await chooseModel(), instructions: request.instructions, input: [...request.input], tools, store: false, stream: true }
  let toolCalls = 0
  for (let turns = 0; turns < MAX_TURNS; turns++) {
    fit(body)
    const output = await turn(body)
    flushText()
    breakBeforeText = true
    for (const item of output) { const replay = replayable(item); if (replay) body.input.push(replay) }
    const calls = output.filter(item => item?.type === 'function_call' && typeof item.call_id === 'string' && item.call_id)
    if (!calls.length) { write({ type: 'done' }); return 0 }
    for (const call of calls) {
      if (++toolCalls > MAX_TOOL_CALLS) throw new AgentError('ChatGPT used more project tool calls than one request allows. Review the edits, then send a narrower request.', 'chatgpt_limit')
      body.input.push({ type: 'function_call_output', call_id: call.call_id, output: await runTool(call) })
    }
  }
  throw new AgentError('ChatGPT took more steps than one request allows. Review the edits, then send a narrower request.', 'chatgpt_limit')
}

// Exit once stdout has flushed; idle keep-alive sockets must not hold the run open.
const exit = code => process.stdout.write('', () => process.exit(code))
main().then(exit, error => {
  flushText()
  const known = error instanceof AgentError
  write({ type: 'error', message: known ? error.message : 'The ChatGPT agent stopped unexpectedly. Try again.', code: known ? error.code : 'chatgpt_failed' })
  if (!known) process.stderr.write(`${clean(error?.message)}\n`)
  exit(1)
})

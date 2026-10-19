import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
if (process.argv[3] === 'hold') { setInterval(() => {}, 1000); await new Promise(() => {}) }
const context = JSON.parse(prompt.match(/<immutable_reel_context>\n([\s\S]*?)\n<\/immutable_reel_context>/)[1]).context
const proxy = spawn(process.execPath, [process.argv[2]], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
const pending = new Map(); let next = 0
readline.createInterface({ input: proxy.stdout }).on('line', line => { const value = JSON.parse(line); const resolve = pending.get(value.id); if (resolve) { pending.delete(value.id); resolve(value) } })
const rpc = (method, params) => new Promise(resolve => { const id = ++next; pending.set(id, resolve); proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n') })
const call = async (name, args) => { const answer = await rpc('tools/call', { name, arguments: args }); if (answer.error || answer.result?.isError) throw new Error(JSON.stringify(answer)); return answer.result }
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'native-project-fixture', version: '1' } })
assert.equal((await rpc('tools/list', {})).result.tools.length, 2)
const denied = await rpc('tools/call', { name: 'reel_api', arguments: { method: 'POST', path: '/api/assistant/config', body: { apiKey: 'unavailable' } } })
assert.ok(denied.error)
await call('reel_api', { method: 'GET', path: '/api/caps' })
await call('reel_api', { method: 'GET', path: '/api/outline' })
const ops = context.selection?.length ? [
  { op: 'update', comp: context.comp, id: context.selection[0], set: { title: { text: 'SELECTED TWEAK' } } },
] : [
  { op: 'add_comp', name: 'Agent scene', width: 160, height: 90, duration: 3 },
  { op: 'add_color', comp: 'k1', track: 'V1', dur: 3, color: '#102030' },
  { op: 'add_title', comp: 'k1', track: 'V2', dur: 3, text: 'EDITABLE SCENE', set: { y: 20 } },
  { op: 'add_shape', comp: 'k1', track: 'V3', dur: 3, shape: { type: 'rect', width: 20, height: 20, fill: { color: '#ff0000' } }, set: { x: 30, y: 60 } },
  { op: 'keyframe', comp: 'k1', id: 'c3', prop: 'x', at: 0, value: 30, local: true },
  { op: 'keyframe', comp: 'k1', id: 'c3', prop: 'x', at: 1, value: 130, local: true },
  { op: 'import', assets: { 'tone.wav': { assetKind: 'audio', hasAudio: true, duration: 3 } } },
  { op: 'append', comp: 'k1', track: 'A1', src: 'tone.wav', in: 0, dur: 3, set: { volume: 0.5 } },
  { op: 'comp_clip', target: 'k1', track: 'V1', dur: 3 },
]
await call('reel_api', { method: 'POST', path: '/api/ops', body: { ops, who: 'agent', summary: context.selection?.length ? 'Tweak selected title' : 'Build editable scene' } })
await call('reel_frame', { at: 0, width: 320 })
await call('reel_frame', { at: 1, width: 320 })
proxy.stdin.end()
console.log(JSON.stringify({ type: 'done', text: context.selection?.length ? 'Updated the selected title.' : 'Created an editable scene and checked its motion.' }))

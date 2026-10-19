import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { Icon, hasIcon } from '../web/ui/icons.js'
import { normalizeCatalog } from '../core/assistant-routing.mjs'

const ui = new URL('../web/ui/', import.meta.url)
const moduleURL = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
// Load the actual templates with inert hooks and host boundaries, as in icons.test.mjs.
async function load(file, stubs) {
  let source = await fs.readFile(new URL(file, ui), 'utf8')
  const imports = {
    preact: import.meta.resolve('preact'), htm: import.meta.resolve('htm'),
    './icons.js': new URL('icons.js', ui).href,
    './assistant-state.js': new URL('assistant-state.js', ui).href,
    './assistant-activity.js': new URL('assistant-activity.js', ui).href,
    './assistant-script.js': new URL('assistant-script.js', ui).href,
    './assistant-panel.js': new URL('assistant-panel.js', ui).href,
    './assistant-status.js': moduleURL((await fs.readFile(new URL('assistant-status.js', ui), 'utf8')).replaceAll("'./store.js'", JSON.stringify(stubs['./store.js']))),
    '/core/assistant-routing.mjs': new URL('../core/assistant-routing.mjs', import.meta.url).href,
    ...stubs,
  }
  for (const [specifier, target] of Object.entries(imports)) source = source.replaceAll("'" + specifier + "'", JSON.stringify(target))
  return import(moduleURL(source))
}
function expand(node) {
  if (Array.isArray(node)) return node.flatMap(expand)
  if (node == null || typeof node !== 'object') return [node]
  if (typeof node.type === 'function') return expand(node.type(node.props))
  return [{ ...node, props: { ...node.props, children: expand(node.props.children) } }]
}
const walk = (tree, out = []) => { for (const node of tree) if (node && typeof node === 'object') { out.push(node); walk(node.props.children, out) } return out }
const text = tree => tree.map(node => node && typeof node === 'object' ? text(node.props.children) : node ?? '').join('')
const find = (tree, cls) => walk(tree).find(node => node.props.class === cls)
const hooks = moduleURL('export const useEffect=()=>{};export const useRef=value=>({current:value});export const useState=value=>[typeof value==="function"?value():value,()=>{}];')
const store = moduleURL('export const useStore=()=>globalThis.__assistantPanelState;export const store=new Proxy({},{get:(_,key)=>globalThis.__assistantPanelState[key]});export const set=patch=>Object.assign(globalThis.__assistantPanelState,patch);export const api=()=>{throw Error("No host calls expected")};export const time={t:0};export const useTime=()=>0;export const toast=()=>{};')
const controls = await load('provider-controls.js', { 'preact/hooks': hooks, './store.js': store })
const { ChatPanel } = await load('chat.js', {
  'preact/hooks': hooks, './store.js': store,
  './provider-controls.js': moduleURL('export const AssistantControls=props=>globalThis.__assistantPanelControls(props);export const RoutingReceipt=()=>null;'),
  './change-receipt.js': moduleURL('export const receiptSelection=()=>null;'),
  './engine-host.js': moduleURL('export const player={};'),
  './settings.js': moduleURL('export const refreshAssistantStatus=()=>{};'),
  './assistant-sharing.js': moduleURL('export const createAssistantSharingGate=()=>({dispose(){}});'),
})
const reason = 'Enable at least one verified model in Auto settings.'
const catalog = normalizeCatalog({ provider: 'codex', checkedAt: Date.now(), source: { kind: 'provider-cli' }, records: [{ id: 'swift', displayName: 'Swift model', inputModalities: ['text', 'image'], isDefault: true }] })
const readyStatus = { provider: 'codex', configured: true, mode: 'auto', routingSupported: true, catalogs: [catalog], providers: [{ id: 'codex', authenticated: true, available: true, adapterSupported: true, modelSelectionSupported: true }], enabledModels: [{ provider: 'codex', model: 'swift' }] }
const setupStatus = { ...readyStatus, configured: false, enabledModels: [], reason }
function render(status = setupStatus, patch = {}) {
  globalThis.__assistantPanelControls = controls.AssistantControls
  globalThis.__assistantPanelState = { root: '/copy-fixture', version: 1, openComp: null, assistantStatus: status, connected: true, caps: {}, claude: { state: 'idle' }, chat: [], activity: [], receipts: [], selection: [], refs: [], project: { comps: {} }, ...patch }
  try { return expand(ChatPanel()) }
  finally { delete globalThis.__assistantPanelState; delete globalThis.__assistantPanelControls }
}

test('not-ready setup reason appears once, only in the setup card', () => {
  const tree = render()
  assert.equal(text(tree).split(reason).length - 1, 1)
  assert.ok(text([find(tree, 'assistant-setup')]).includes(reason))
  assert.ok(text([find(tree, 'chat-head')]).includes('Not connected'))
  assert.equal(find(tree, 'assistant-route-preview'), undefined)
})

test('an expired model catalog reads as Needs refresh in the header, not as disconnected', () => {
  const expired = { ...setupStatus, autoPreview: { ok: false, blocked: [{ reason: 'The model catalog needs a refresh.' }] } }
  const tree = render(expired)
  const head = text([find(tree, 'chat-head')])
  assert.ok(head.includes('Needs refresh'), head)
  assert.equal(head.includes('Not connected'), false)
  assert.ok(text([find(tree, 'assistant-setup')]).includes('Model availability needs a refresh'))
})

test('route previews render when ready and stay hidden when not ready', () => {
  const tree = render(readyStatus)
  assert.equal(find(tree, 'assistant-setup'), undefined)
  assert.equal(text([find(tree, 'assistant-route-preview')]), 'Likely choice: Swift modelPreview only. The host refreshes account and model metadata when you send. Catalog presence does not prove access.')
  assert.equal(find(render(setupStatus), 'assistant-route-preview'), undefined)
  for (const configured of [false, true]) {
    const manual = { ...readyStatus, mode: 'manual', model: 'missing', catalogBound: true, configured }
    assert.equal(Boolean(find(render(manual), 'assistant-route-preview')), configured)
  }
})

test('the empty state has one sentence and Input tips retains the attachment hint', () => {
  const tree = render()
  const empty = find(tree, 'chat-empty'), card = find(tree, 'assistant-composer-card')
  assert.equal(text([empty]).trim(), 'Ask for an edit or a question about this project. With Preview changes on, you see what will change and apply it yourself.')
  assert.equal(text([find(render(setupStatus, { caps: { host: 'native' } }), 'chat-empty')]).trim(), 'Describe the edit you want. Your assistant works with native clips, titles, audio and motion, with undo.')
  assert.equal(walk([empty]).filter(node => node.type === 'p').length, 1)
  const options = find([card], 'assistant-options')
  const help = find([options], 'assistant-input-help')
  assert.ok(help)
  assert.equal(text(help.props.children.filter(node => node?.type === 'summary')), 'Input tips')
  const hint = '⌥-click a clip, keyframe, track, marker or inspector field to attach it.'
  assert.equal(text([help]).split(hint).length - 1, 1)
  assert.ok(text([find(render(readyStatus, { chat: [{ role: 'user', text: 'Earlier edit' }] }), 'assistant-input-help')]).includes(hint))
})

test('not-ready headers preserve active, terminal and disconnected activity labels', () => {
  for (const [patch, label] of [
    [{ claude: { state: 'working' } }, 'Using tools'],
    [{ claude: { state: 'done' } }, 'Response finished'],
    [{ connected: false }, 'Reconnecting'],
  ]) assert.ok(text([find(render(setupStatus, patch), 'chat-head')]).includes(label))
})

test('assistant update cards retain their labels and reference chips use drawn icons with named close buttons', () => {
  for (const name of ['attach', 'close']) {
    assert.ok(hasIcon(name))
    const svg = Icon({ name })
    assert.equal(svg.props.viewBox, '0 0 24 24')
    assert.equal(svg.props.fill, 'none')
    assert.equal(svg.props['aria-hidden'], 'true')
    assert.ok(expand(svg.props.children).every(node => node.type === 'path'))
  }
  const ref = { label: 'Opening clip' }
  const tree = render(readyStatus, { refs: [ref], chat: [{ role: 'user', text: 'Trim this', refs: [ref] }], activity: [{ who: 'assistant', text: 'Inspecting clips' }] })
  const all = walk(tree)
  const iconsIn = node => walk([node]).filter(child => child.type === 'svg')
  const drawing = svg => svg.props.children.map(path => path.props.d)
  const expected = name => drawing(expand(Icon({ name }))[0])
  const update = find(tree, 'assistant-tool-card')
  assert.equal(update.type, 'article')
  assert.equal(update.props['aria-label'], 'Assistant update')
  assert.equal(text([update]), 'Assistant updateInspecting clips')
  const chips = all.filter(node => ['chip', 'chip small'].includes(node.props.class))
  assert.equal(chips.length, 2)
  for (const chip of chips) {
    assert.equal(iconsIn(chip)[0].props.width, 14)
    assert.deepEqual(drawing(iconsIn(chip)[0]), expected('attach'))
  }
  assert.doesNotMatch(text(tree), /✦|📎|✕/)
  const close = all.find(node => node.props['aria-label'] === 'Close assistant')
  const remove = all.find(node => node.props['aria-label'] === 'Remove reference Opening clip')
  assert.equal(close.type, 'button'); assert.equal(iconsIn(close).length, 1)
  assert.equal(remove.type, 'button'); assert.equal(iconsIn(remove).length, 1)
  for (const button of [close, remove]) assert.deepEqual(drawing(iconsIn(button)[0]), expected('close'))
  globalThis.__assistantPanelState = { refs: [ref], chatOpen: true }
  try {
    remove.props.onClick(); assert.deepEqual(globalThis.__assistantPanelState.refs, [])
    close.props.onClick(); assert.equal(globalThis.__assistantPanelState.chatOpen, false)
  } finally { delete globalThis.__assistantPanelState }
})

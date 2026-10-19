import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(process.env.ARYA_RECEIPT_SOURCE_ROOT ?? fileURLToPath(new URL('..', import.meta.url)))
const dependency = createRequire(resolve(process.env.ARYA_RECEIPT_DEPENDENCY_ROOT ?? 'editor', 'package.json'))
const { h } = dependency('preact'), htm = dependency('htm')
const { changeReceipt, receiptSelection } = await import(pathToFileURL(resolve(root, 'web/ui/change-receipt.js')))
const source = readFileSync(resolve(root, 'web/ui/chat.js'), 'utf8')
const receiptSource = source.slice(source.indexOf('function ChangeReceipt'), source.indexOf('export function ChatPanel'))
const component = new Function('html', 'receiptSelection', 'store', 'set', 'toast', 'player', `${receiptSource}\nreturn ChangeReceipt`)
const flatten = value => Array.isArray(value) ? value.flatMap(flatten) : value == null || value === false ? [] : [value]
const children = node => flatten(node?.props?.children)
const nodes = node => node && typeof node === 'object' ? [node, ...children(node).flatMap(nodes)] : []
const text = node => children(node).map(child => typeof child === 'object' ? text(child) : String(child)).join('')
function render(receipt, project) {
  const updates = [], seeks = [], messages = []
  const view = component(htm.bind(h), receiptSelection, { project }, value => updates.push(value), value => messages.push(value), { seek: value => seeks.push(value) })
  return { tree: view({ receipt }), updates, seeks, messages }
}
const recorded = JSON.parse(readFileSync(new URL('./fixtures/asset-receipt-recorded.json', import.meta.url)))
const actualBefore = recorded.before, actualAfter = recorded.after, actualRecord = recorded.record
const path = actualRecord.newAsset, asset = actualAfter.assets[path], prefix = `assets[${JSON.stringify(path)}]`
const saved = () => { const project = structuredClone(actualBefore); project.assets[path] = structuredClone(asset); return project }
const changes = receipt => receipt.scopes.flatMap(scope => scope.changes)

test('the recorded project delta contains exactly one asset and one A3 clip addition', () => {
  assert.deepEqual(Object.keys(actualAfter.assets).filter(key => !Object.hasOwn(actualBefore.assets, key)), [path])
  for (const [key, value] of Object.entries(actualBefore.assets)) assert.deepEqual(actualAfter.assets[key], value)
  const previous = new Map(actualBefore.tracks.flatMap(track => track.clips.map(clip => [clip.id, { track: track.id, clip }])))
  const added = actualAfter.tracks.flatMap(track => track.clips.filter(clip => !previous.has(clip.id)).map(clip => ({ track: track.id, clip })))
  assert.deepEqual(added, [{ track: 'A3', clip: actualRecord.newClip }])
  for (const [id, value] of previous) assert.deepEqual(actualAfter.tracks.flatMap(track => track.clips.filter(clip => clip.id === id).map(clip => ({ track: track.id, clip }))), [value])
  for (const key of Object.keys(actualBefore)) if (!['assets', 'tracks'].includes(key)) assert.deepEqual(actualAfter[key], actualBefore[key])
})

test('saved-only actual asset renders as Media registration and exposes separate local provenance and digest', () => {
  const after = saved(), receipt = changeReceipt(actualBefore, after, { version: 4, who: 'agent', at: 123 })
  assert.equal(receipt.total, 0)
  assert.equal(receipt.totalAssets, 1)
  assert.equal(receipt.scopes[0].asset, path)
  assert.equal(receipt.scopes[0].status, 'added')
  const { tree } = render(receipt, after), displayed = text(tree)
  assert.match(displayed, /Edit 4 · 1 Media asset changed/)
  assert.match(displayed, /Media registration · added/)
  assert.doesNotMatch(displayed, /Project settings changed|Project or composition settings/)
  assert.ok(displayed.includes(path))
  assert.ok(displayed.includes(asset.generated.provenance))
  assert.ok(displayed.includes(asset.generated.contentSHA256))
  assert.ok(displayed.includes(asset.generated.renderer))
  assert.ok(displayed.includes('pcm_s24le'))
  assert.equal(nodes(tree).some(node => node.type === 'button'), false)
  assert.equal(receiptSelection(receipt, after, null), null)
  assert.equal(receipt.truncated, true, 'the bounded score preview must declare truncation')
  assert.equal(changes(receipt).find(change => change.property === `${prefix}.generated.provenance`).after, JSON.stringify(asset.generated.provenance))
  assert.equal(changes(receipt).find(change => change.property === `${prefix}.generated.contentSHA256`).after, JSON.stringify(actualRecord.fileSHA256))
})

test('the actual saved-only component headline does not classify registration as project settings', () => {
  const after = saved(), receipt = changeReceipt(actualBefore, after, { version: 4, who: 'agent' })
  const displayed = text(render(receipt, after).tree)
  assert.match(displayed, /Edit 4 · 1 Media asset changed/)
  assert.doesNotMatch(displayed, /Project settings changed/)
})

test('the actual large asset metadata retains a separate local provenance change', () => {
  const receipt = changeReceipt(actualBefore, saved(), { who: 'agent' })
  const provenance = changes(receipt).find(change => change.property === `${prefix}.generated.provenance`)
  assert.ok(provenance, 'the existing whole-record preview loses this provenance beyond 1 KiB')
  assert.equal(provenance.after, JSON.stringify(asset.generated.provenance))
})

test('the whole recorded registration and placement delta preserves the A3 layer action', () => {
  const receipt = changeReceipt(actualBefore, actualAfter, { version: 5, who: 'agent', at: 123 })
  assert.equal(receipt.total, 1)
  assert.equal(receipt.totalAssets, 1)
  assert.equal(receipt.clips[0].id, 'c17')
  const current = structuredClone(actualAfter), { tree, updates, seeks } = render(receipt, current)
  assert.match(text(tree), /1 layer changed · 1 Media asset changed/)
  const button = nodes(tree).find(node => node.type === 'button')
  assert.equal(button.props.disabled, false)
  button.props.onClick()
  assert.deepEqual(updates, [{ openComp: null, selection: ['c17'], page: 'edit', viewerMode: 'timeline' }])
  assert.deepEqual(seeks, [12])
  current.tracks.find(track => track.id === 'A3').clips = current.tracks.find(track => track.id === 'A3').clips.filter(clip => clip.id !== 'c17')
  const stale = render(receipt, current), staleButton = nodes(stale.tree).find(node => node.type === 'button')
  assert.equal(staleButton.props.disabled, true)
  staleButton.props.onClick()
  assert.deepEqual(stale.updates, [])
  assert.deepEqual(stale.seeks, [])
  assert.deepEqual(stale.messages, ['Those layers are no longer in the project.'])
})

test('placement-only retry leaves asset identity and provenance untouched and reports no new registration', () => {
  const before = saved(), receipt = changeReceipt(before, actualAfter, { version: 6, who: 'agent' })
  assert.equal(receipt.totalAssets, 0)
  assert.equal(receipt.total, 1)
  assert.equal(receipt.scopes.some(scope => scope.asset != null), false)
  assert.deepEqual(before.assets[path], actualAfter.assets[path])
  assert.doesNotMatch(text(render(receipt, actualAfter).tree), /Media registration|Media asset changed/)
})

test('the recorded Undo retains the asset, and user Undo does not create an assistant receipt', () => {
  assert.equal(recorded.undoRedoRecord.undoRedoAccepted, true)
  assert.equal(recorded.undoRedoRecord.redoSHA256, recorded.undoRedoRecord.afterSHA256)
  assert.deepEqual(recorded.undo.assets[path], asset)
  assert.equal(changeReceipt(actualAfter, recorded.undo, { who: 'you' }), null)
  // Replaying these snapshots as an agent edit exercises the deletion diff only.
  const receipt = changeReceipt(actualAfter, recorded.undo, { who: 'agent' })
  assert.equal(receipt.totalAssets, 0)
  assert.equal(receipt.total, 1)
  assert.equal(receipt.clips[0].id, 'c17')
  assert.equal(receipt.clips[0].status, 'deleted')
  assert.equal(receiptSelection(receipt, recorded.undo, null), null)
  assert.doesNotMatch(text(render(receipt, recorded.undo).tree), /Media registration/)
})

test('mixed asset, root and track changes remain explicit without being classified only as Media', () => {
  const after = saved(); after.fps = actualBefore.fps === 24 ? 30 : 24
  after.tracks.find(track => track.id === 'A3').volume = -6
  const receipt = changeReceipt(actualBefore, after, { who: 'agent' }), displayed = text(render(receipt, after).tree)
  assert.match(displayed, /1 Media asset changed · Project or track settings changed/)
  assert.match(displayed, /Project or composition settings/)
  assert.match(displayed, /Track settings/)
  assert.ok(changes(receipt).some(change => change.property === 'fps'))
  assert.ok(receipt.scopes.some(scope => scope.track === 'A3' && scope.changes.some(change => change.property === 'volume')))
})

test('asset update and removal preserve changed and deleted statuses, exact values and no selection', () => {
  const before = saved(), updated = structuredClone(before); updated.assets[path].name = 'Revised cue'
  const update = changeReceipt(before, updated, { who: 'agent' })
  assert.equal(update.totalAssets, 1)
  assert.equal(update.scopes[0].status, 'changed')
  assert.deepEqual(update.scopes[0].changes, [{ property: `${prefix}.name`, before: JSON.stringify(asset.name), after: '"Revised cue"' }])
  const removed = structuredClone(before); delete removed.assets[path]
  const deletion = changeReceipt(before, removed, { who: 'agent' })
  assert.equal(deletion.scopes[0].status, 'deleted')
  assert.ok(changes(deletion).some(change => change.property === `${prefix}.generated.provenance` && change.after === 'Absent'))
  assert.equal(nodes(render(deletion, removed).tree).some(node => node.type === 'button'), false)
  assert.equal(changeReceipt(before, before, { who: 'agent' }), null)
})

test('literal asset keys, null values and empty records preserve actual paths and JSON distinctions', () => {
  const before = { assets: {}, tracks: [] }, after = structuredClone(before)
  const key = 'a.b/"~<img>.wav'; after.assets[key] = { name: '<img src=x onerror=alert(1)>', generated: null }
  const receipt = changeReceipt(before, after, { who: 'agent' }), { tree } = render(receipt, after)
  assert.equal(receipt.scopes[0].asset, key)
  assert.ok(changes(receipt).some(change => change.property === `assets[${JSON.stringify(key)}].generated` && change.after === 'null'))
  assert.equal(nodes(tree).some(node => node.props?.dangerouslySetInnerHTML), false)
  assert.equal(nodes(tree).some(node => node.type === 'img'), false)
  const empty = changeReceipt(before, { assets: { empty: {} }, tracks: [] }, { who: 'agent' })
  assert.deepEqual(empty.scopes[0].changes, [{ property: 'assets.empty', before: 'Absent', after: '{}' }])
})

test('large asset receipts retain counts, valid JSON and existing UTF-8 display bounds', () => {
  const before = { assets: {}, tracks: [] }, after = structuredClone(before)
  for (let index = 0; index < 100; index++) after.assets[`asset${index}.wav`] = { name: '界'.repeat(1000), generated: { provenance: '界'.repeat(1000) } }
  const receipt = changeReceipt(before, after, { who: 'agent' })
  assert.equal(receipt.totalAssets, 100)
  assert.equal(receipt.totalScopes, 100)
  assert.ok(receipt.scopes.length <= 80)
  assert.equal(receipt.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt, null, 2)) <= 128 * 1024)
  for (const scope of receipt.scopes) {
    assert.ok(Buffer.byteLength(scope.name) <= 160)
    assert.ok(scope.changes.length <= 50)
    for (const change of scope.changes) for (const value of [change.before, change.after]) assert.ok(Buffer.byteLength(value) <= 1024)
  }
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(receipt)))
})

test('unrepresentable asset paths omit details without an aliased path or hidden change count', () => {
  const key = 'x'.repeat(600), after = { assets: { [key]: { name: 'Large path' } }, tracks: [] }
  const receipt = changeReceipt({ assets: {}, tracks: [] }, after, { who: 'agent' })
  assert.equal(receipt.totalAssets, 1)
  assert.equal(receipt.totalScopes, 1)
  assert.deepEqual(receipt.scopes, [])
  assert.equal(receipt.truncated, true)
})

test('non-map assets remain exact project metadata rather than fabricated registrations', () => {
  const before = { assets: {}, tracks: [] }, after = { assets: null, tracks: [] }
  const receipt = changeReceipt(before, after, { who: 'agent' })
  assert.equal(receipt.totalAssets, 0)
  assert.deepEqual(receipt.scopes[0].changes, [{ property: 'assets', before: '{}', after: 'null' }])
})

test('retained legacy asset receipts use Media labels without recovering missing truncated metadata', () => {
  const receipt = { version: 4, total: 0, clips: [], totalScopes: 1, projectChanges: ['assets'], truncated: true,
    scopes: [{ comp: null, track: null, name: 'Main timeline', status: 'changed', changes: [{ property: prefix, before: 'Absent', after: '{"score":"shortened…"}' }] }] }
  const displayed = text(render(receipt, saved()).tree)
  assert.match(displayed, /Media assets changed/)
  assert.match(displayed, /Media metadata · changed/)
  assert.doesNotMatch(displayed, /Project settings changed|Locally synthesized/)
  receipt.projectChanges.push('fps'); receipt.scopes[0].changes.push({ property: 'fps', before: '30', after: '24' })
  const mixed = text(render(receipt, saved()).tree)
  assert.match(mixed, /Media assets changed · Project or track settings changed/)
  assert.match(mixed, /Media and project settings · changed/)
})

test('receipt generation and component rendering leave captured projects unchanged', () => {
  const before = structuredClone(actualBefore), after = structuredClone(actualAfter)
  render(changeReceipt(before, after, { who: 'agent' }), after)
  assert.deepEqual(before, actualBefore)
  assert.deepEqual(after, actualAfter)
})

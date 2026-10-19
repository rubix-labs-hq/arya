import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { h } from 'preact'
import htm from 'htm'

const html = htm.bind(h)
const source = fs.readFileSync(new URL('../web/ui/plugins/captions.js', import.meta.url), 'utf8')
const begin = source.indexOf('function ImportConfirm(')
const component = source.slice(begin, source.indexOf('\nfunction ', begin + 1))
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === 'object' ? [node, ...walk(node.props?.children)] : []

test('timeline import confirmation submits the reviewed project version and input hash', async () => {
  const calls = [], updates = []
  let closed = false
  const preview = { version: 7, sourceHash: 'a'.repeat(64), project: { name: 'Reviewed', width: 1920, height: 1080, fps: 30, tracks: [], markers: [], assets: {} }, missing: [], warnings: [] }
  const Confirm = new Function('html', 'useState', 'api', 'set', 'toast', 'tc', `${component}; return ImportConfirm;`)(html, value => [value, () => {}], async (route, body) => { calls.push({ route, body }); return { project: preview.project, version: 8 } }, value => updates.push(value), () => {}, () => '')
  const tree = Confirm({ rel: 'input.otio', preview, onClose: () => { closed = true } })
  await walk(tree).find(node => node.type === 'button' && node.props.class === 'danger').props.onClick()
  assert.deepEqual(calls, [{ route: '/api/interchange/import', body: { path: 'input.otio', apply: true, expectedVersion: 7, expectedInputHash: preview.sourceHash } }])
  assert.equal(updates[0].version, 8)
  assert.equal(closed, true)
})

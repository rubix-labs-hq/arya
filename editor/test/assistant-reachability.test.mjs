import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { OPS_DOC } from '../core/project.js'
import { READS, WRITES, validateCall } from '../agent/protocol.mjs'

const source = name => fs.readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')

// Every op the edit model handles is something an agent can use only if the reference names it.
test('the operation reference names every op the edit model accepts from agents', () => {
  const handled = new Set([
    ...[...source('core/project.js').matchAll(/case '([a-z_]+)':/g)].map(match => match[1]),
    ...[...source('core/library.js').matchAll(/'(library_[a-z]+)'/g)].map(match => match[1]),
  ])
  // import is added by the server for new media; replace is interchange's whole-project swap.
  const internal = new Set(['import', 'replace'])
  const ops = [...handled].filter(op => !internal.has(op) && !['add_clip', 'append', 'insert', 'overwrite', 'connect'].includes(op) && /^[a-z]+(_[a-z]+)*$/.test(op))
  const missing = ops.filter(op => !new RegExp(`(^|[\\s|-])${op}([\\s|{]|$)`, 'm').test(OPS_DOC))
  assert.deepEqual(missing, [], `ops missing from OPS_DOC: ${missing.join(', ')}`)
  for (const op of ['keyframe_ease', 'split', 'paste']) assert.match(OPS_DOC, new RegExp(op))
})

test('the reference explains audio effect chains, keyframe paths and title fields the UI edits', () => {
  for (const type of ['eq', 'compressor', 'gate', 'deesser', 'limiter', 'reverb', 'delay', 'gain']) assert.match(OPS_DOC, new RegExp(`\\b${type} \\{`), type)
  assert.match(OPS_DOC, /update_track \{id, set:\{name,muted,hidden,locked,solo,volume,pan,fx\}\}/)
  assert.match(OPS_DOC, /project \{set:\{master:\{fx, volume, limiter/)
  assert.match(OPS_DOC, /anchorX\|anchorY/); assert.match(OPS_DOC, /fx\.0\.params\.threshold/)
  assert.match(OPS_DOC, /tag \(color label/); assert.match(OPS_DOC, /italic, gradient/)
  assert.match(OPS_DOC, /- append\|insert\|overwrite/, 'the native backend test pins this entry')
})

test('agents can describe clips, propose previews and apply project LUTs with a hash check', () => {
  assert.ok(READS.has('/api/describe'))
  for (const route of ['/api/assistant/propose', '/api/luts/inspect', '/api/luts/apply']) {
    assert.ok(WRITES.has(route), route)
    assert.equal(validateCall('reel_api', { method: 'POST', path: route, body: {} }).path, route)
  }
  for (const route of ['/api/luts/import', '/api/luts/export', '/api/forget', '/api/recovery/restore', '/api/assistant/config']) {
    assert.throws(() => validateCall('reel_api', { method: 'POST', path: route, body: {} }), /unavailable to agents/, route)
  }
})

test('the assistant can show the user a moment, layers, a composition or a page without editing', async () => {
  const { applyOps: apply, newProject } = await import('../core/project.js')
  const { default: assistantRoutes } = await import('../routes/assistant.mjs')
  const project = apply(newProject('Show'), [
    { op: 'add_title', text: 'One', track: 'V3', start: 0, dur: 2 },
    { op: 'add_comp', name: 'Card', duration: 2 },
    { op: 'add_color', comp: 'k1', color: '#000', start: 0, dur: 2 },
  ]).project
  const events = []
  const routes = assistantRoutes({ getProject: () => project, getVersion: () => 1, broadcast: (...args) => events.push(args) }).routes
  const shown = routes['POST /api/ui/show']({ at: 1.5, ids: ['c1', 'tr:c1'], page: 'color' })
  assert.deepEqual(shown, { shown: true, ids: ['c1', 'tr:c1'], at: 1.5, page: 'color' })
  assert.equal(events[0][0], 'uiShow'); assert.equal(events[0][2], 'ui'); assert.equal(events[0][1].at, 1.5)
  assert.deepEqual(routes['POST /api/ui/show']({ comp: 'k1', ids: ['c2'] }), { shown: true, comp: 'k1', ids: ['c2'] })
  assert.throws(() => routes['POST /api/ui/show']({ ids: ['c2'] }), /Pass comp to show clips inside a composition/)
  assert.throws(() => routes['POST /api/ui/show']({ comp: 'k9' }), /No composition k9/)
  assert.throws(() => routes['POST /api/ui/show']({ at: -1 }), /timeline seconds/)
  assert.throws(() => routes['POST /api/ui/show']({ page: 'settings' }), /page must be one of/)
  assert.throws(() => routes['POST /api/ui/show']({}), /Pass at, ids, comp or page/)
  assert.equal(events.length, 2)
  assert.equal(validateCall('reel_api', { method: 'POST', path: '/api/ui/show', body: { at: 2 } }).path, '/api/ui/show')
})

test('the editor store applies a show request to the composition, selection, page and a seek request', () => {
  const store = fs.readFileSync(new URL('../web/ui/store.js', import.meta.url), 'utf8')
  const handler = store.match(/    uiShow: value => set\(\{[^]*?\n    \}\),\n/)
  assert.ok(handler, 'extract the actual uiShow handler')
  const state = { openComp: null, selection: ['c9'], page: 'edit' }
  const set = patch => Object.assign(state, patch)
  const handlers = new Function('set', `return {${handler[0]}}`)(set)
  handlers.uiShow({ comp: 'k1', ids: ['c2'], at: 3, id: 7 })
  assert.deepEqual(state, { openComp: 'k1', selection: ['c2'], page: 'edit', seekRequest: { at: 3, id: 7 } })
  handlers.uiShow({ comp: null, page: 'color' })
  assert.deepEqual(state, { openComp: null, selection: ['c2'], page: 'color', seekRequest: { at: 3, id: 7 } })
  const host = fs.readFileSync(new URL('../web/ui/engine-host.js', import.meta.url), 'utf8')
  assert.match(host, /if \(store\.seekRequest && store\.seekRequest !== lastSeek\) \{\n    lastSeek = store\.seekRequest\n    player\.seek\(store\.seekRequest\.at\)/)
  assert.match(host, /openComp: store\.openComp \?\? null/, 'the server learns which composition is open')
})

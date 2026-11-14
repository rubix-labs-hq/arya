import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { createDeliverRequest } from '../web/ui/deliver-request.js'

function fixture() {
  let scope = { root: '/synthetic/project', version: 4, project: { name: 'Original', width: 64, height: 64, fps: 1, tracks: [] }, comp: null }
  let resolve, reject
  const result = new Promise((yes, no) => { resolve = yes; reject = no })
  const calls = [], changes = [], started = []
  const request = createDeliverRequest({ getScope: () => scope, start: (...args) => { calls.push(args); return result }, changed: value => changes.push(value), started: () => started.push(true) })
  return { request, calls, changes, started, resolve, reject, scope: () => scope, change: patch => { scope = { ...scope, ...patch } } }
}

test('request becomes pending synchronously and refuses same-turn duplicate clicks', async () => {
  const f = fixture(), spec = { name: 'Accepted', range: { in: 0, out: 1 } }, project = f.scope().project
  const first = f.request.run(spec, project)
  assert.equal(f.request.state().phase, 'pending')
  await f.request.run(spec, project)
  assert.equal(f.calls.length, 1)
  spec.range.out = 9; project.name = 'Later mutation'
  assert.equal(f.calls[0][0].range.out, 1); assert.equal(f.calls[0][1].name, 'Original')
  f.resolve(); await first
  assert.equal(f.request.state().phase, 'idle'); assert.equal(f.started.length, 1)
})

test('startup failure remains visible until an explicit retry', async () => {
  const f = fixture(), pending = f.request.run({}, f.scope().project)
  f.reject(new Error('The worker could not start')); await pending
  assert.equal(f.request.state().phase, 'failed')
  assert.equal(f.request.state().error, 'The worker could not start')
  assert.equal(f.started.length, 0)
  const again = f.request.run({}, f.scope().project)
  assert.equal(f.request.state().phase, 'pending'); assert.equal(f.calls.length, 2)
  await again
  assert.equal(f.request.state().phase, 'failed')
})

for (const patch of [{ version: 5 }, { root: '/synthetic/another' }, { comp: 'nested' }, { project: { name: 'Replacement' } }]) test(`late startup result stays in its captured scope: ${Object.keys(patch)[0]}`, async () => {
  const f = fixture(), pending = f.request.run({}, f.scope().project)
  f.change(patch)
  assert.equal(f.calls[0][2].isCurrent(), false)
  assert.equal(f.request.state().phase, 'stale-pending')
  assert.throws(f.calls[0][2].assertCurrent, /project changed/)
  f.resolve(); await pending
  assert.equal(f.started.length, 0); assert.equal(f.request.state().phase, 'idle')
})

test('late failure and prior persistent failure do not leak into another project', async () => {
  const f = fixture(), pending = f.request.run({}, f.scope().project)
  f.change({ root: '/synthetic/another' }); f.reject(new Error('Old project error')); await pending
  assert.equal(f.request.state().phase, 'idle')
  const g = fixture(), failed = g.request.run({}, g.scope().project)
  g.reject(new Error('Current error')); await failed
  assert.equal(g.request.state().phase, 'failed')
  g.change({ version: 5 }); assert.equal(g.request.state().phase, 'idle')
})

test('unmount suppresses late notices and prevents requests from the disposed controller', async () => {
  const f = fixture(), pending = f.request.run({}, f.scope().project)
  f.request.dispose(); const count = f.changes.length
  f.resolve(); await pending
  assert.equal(f.started.length, 0); assert.equal(f.changes.length, count)
  await f.request.run({}, f.scope().project); assert.equal(f.calls.length, 1)
})

function component({ hostKind = 'browser', caps = {} } = {}) {
  const text = fs.readFileSync(new URL('../web/ui/deliver.js', import.meta.url), 'utf8').replace(/^import .*\n/gm, '').replace(/^export /gm, '').replace('const html = htm.bind(h)', '')
  const hooks = [], cleanups = [], toasts = [], calls = []
  let index = 0, resolve, reject
  const response = new Promise((yes, no) => { resolve = yes; reject = no })
  const state = { root: '/synthetic/project', version: 4, project: { name: 'Timeline', width: 64, height: 64, fps: 1, tracks: [] }, openComp: null, jobs: [], caps }
  const context = vm.createContext({ createDeliverRequest, host: { kind: hostKind }, useStore: () => state,
    useState(initial) { const slot = index++; if (!(slot in hooks)) hooks[slot] = initial; return [hooks[slot], value => { hooks[slot] = typeof value === 'function' ? value(hooks[slot]) : value }] },
    useRef(initial) { const slot = index++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot] },
    useEffect(effect) { const slot = index++; if (!(slot in hooks)) { hooks[slot] = true; const cleanup = effect(); if (cleanup) cleanups.push(cleanup) } },
    store: state, set() {}, duration: () => 1, timecode: () => '00:01', viewProject: () => state.project,
    toast: (...args) => toasts.push(args), api: (...args) => { calls.push(args); return response },
    html: (strings, ...values) => ({ strings, values }), Viewer: () => {}, registry: { deliver: [] },
  })
  vm.runInContext(text + '\nthis.page = DeliverPage', context)
  function render() { index = 0; return context.page() }
  function find(root, needle) {
    if (!root || typeof root !== 'object') return null
    if (root.strings?.join('').includes(needle)) return root
    for (const value of Array.isArray(root) ? root : Array.isArray(root.values) ? root.values : []) { const result = find(value, needle); if (result) return result }
    return null
  }
  const button = rendered => {
    const row = find(rendered, 'aria-busy=')
    const offset = row.strings.findIndex(text => text.includes('button class="primary" disabled='))
    return { disabled: row.values[offset], busy: row.values[offset + 1], click: row.values[offset + 2], label: row.values[offset + 3] }
  }
  return { render, find, button, resolve, reject, calls, state, toasts, cleanups }
}

test('actual DeliverPage disables Render and announces preparation before its request resolves', async () => {
  const f = component(), pending = f.button(f.render()).click()
  const rendered = f.render(), busy = f.button(rendered)
  assert.equal(busy.disabled, true); assert.equal(busy.busy, true)
  assert.equal(busy.label, 'Preparing render…')
  assert.ok(f.find(rendered, 'role="status"'))
  assert.equal(f.find(rendered, 'Nothing rendered yet.'), null)
  await busy.click(); assert.equal(f.calls.length, 1)
  f.resolve({ id: 'synthetic-job' }); await pending
  assert.equal(f.button(f.render()).label, 'Render')
  assert.equal(f.toasts.length, 1)
})

test('actual DeliverPage keeps startup failure in an alert and labels the next action Retry render', async () => {
  const f = component(), pending = f.button(f.render()).click()
  f.reject(new Error('Synthetic worker startup failure')); await pending
  const rendered = f.render(), alert = f.find(rendered, 'role="alert"'), retry = f.button(rendered)
  assert.ok(alert.strings.join('').includes('Render could not start: '))
  assert.ok(alert.values.includes('Synthetic worker startup failure'))
  assert.equal(retry.label, 'Retry render')
  assert.equal(retry.disabled, false); assert.equal(retry.busy, false)
  assert.equal(f.toasts.length, 0)
})

test('actual DeliverPage labels an old-scope pending request and keeps duplicate prevention', async () => {
  const f = component(), pending = f.button(f.render()).click()
  f.state.project = { ...f.state.project, name: 'Updated timeline' }; f.state.version++
  const rendered = f.render(), button = f.button(rendered), status = f.find(rendered, 'role="status"')
  assert.equal(button.label, 'Waiting for previous request…'); assert.equal(button.disabled, true)
  assert.ok(status.values.some(value => typeof value === 'string' && value.includes('previous timeline')))
  await button.click(); assert.equal(f.calls.length, 1)
  f.resolve({ id: 'old-scope-job' }); await pending
  assert.equal(f.button(f.render()).disabled, false); assert.equal(f.toasts.length, 0)
})

test('the Mac Web Editor offers only presets its WebCodecs route can render', () => {
  const nativePresets = ['h264-high', 'h264-web', 'h264-fast', 'hevc', 'audio-m4a', 'audio-wav', 'prores-422', 'prores-422hq', 'prores-4444', 'gif', 'png-seq']
  const webPresets = nativePresets.slice(0, 6)
  const offered = rendered => JSON.stringify(rendered, (key, value) => typeof value === 'function' ? undefined : value)
  const mac = offered(component({ hostKind: 'native', caps: { presets: nativePresets, webPresets } }).render())
  assert.ok(mac.includes('YouTube 1080p') && !mac.includes('ProRes 4444') && !mac.includes('palette-optimized'), 'ProRes and GIF are hidden in the Mac Web Editor')
  const full = offered(component({ hostKind: 'server', caps: { presets: nativePresets, webPresets } }).render())
  assert.ok(full.includes('ProRes 4444'), 'the server editor still offers every preset it renders')
})


test('failed queue rows retry the exact spec this tab requested, including the composition, and can be dismissed', async () => {
  const f = component()
  f.state.openComp = 'intro'; f.state.project = { ...f.state.project, comps: { intro: { name: 'Intro', range: { in: 0, out: 1 } } } }
  const started = f.button(f.render()).click()
  f.resolve({ id: 'failed-job' }); await started
  const requested = JSON.parse(JSON.stringify(f.calls[0]))
  assert.equal(requested[1].comp, 'intro')
  // The composition closes before the user retries; the retry must still render the composition.
  f.state.openComp = null
  f.state.jobs = [
    { id: 'failed-job', kind: 'export', state: 'failed', error: 'the render worker did not start', spec: { preset: 'h264-web', out: 'renders/intro.mp4' } },
    { id: 'other-tab-job', kind: 'export', state: 'failed', error: 'Encoder ran out of memory', spec: { preset: 'h264-web', out: 'renders/other.mp4' } },
    { id: 'done-job', kind: 'export', state: 'done', spec: { preset: 'h264-web', out: 'renders/success.mp4' } },
  ]
  const rows = f.render().values.flat(Infinity).filter(value => value?.strings?.join('').includes('job-name'))
  const ours = rows.find(value => JSON.stringify(value).includes('intro.mp4')), theirs = rows.find(value => JSON.stringify(value).includes('other.mp4'))
  assert.ok(ours.values.includes('The render could not start. Try again.'))
  assert.ok(theirs.values.includes('Encoder ran out of memory'))
  assert.ok(f.find(ours, '>Retry</button>'), 'a job this tab started can be retried')
  assert.equal(f.find(theirs, '>Retry</button>'), null, 'a job from elsewhere has no spec to retry')
  await f.find(ours, '>Retry</button>').values[1]()
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[1])), requested)
  f.find(ours, '>Dismiss</button>').values[1]()
  const remaining = f.render().values.flat(Infinity).filter(value => value?.strings?.join('').includes('job-name')).map(value => JSON.stringify(value))
  assert.equal(remaining.length, 2)
  assert.ok(!remaining.some(row => row.includes('intro.mp4')))
})


test('Render has a plain accessible label and hides its decorative arrow', () => {
  const f = component(), rendered = f.render()
  assert.equal(f.button(rendered).label, 'Render')
  assert.match(f.find(rendered, 'deliver-actions').strings.join(''), /<span aria-hidden="true">⇪<\/span>/)
})

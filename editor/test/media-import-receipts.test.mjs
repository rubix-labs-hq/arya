import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { importMediaPaths, uploadMediaFiles } from '../web/ui/media-import.js'
import { isAryaMusicAsset } from '../core/music-score.js'
import { reimportMusicAsset, prepareMusicReimport } from '../music/reimport.mjs'

// Isolated candidates contain only owned UI sources; core/route inputs remain in the repo.
let repo = path.dirname(fileURLToPath(import.meta.url))
while (!fs.existsSync(path.join(repo, 'editor/server.mjs'))) {
  if (repo === path.dirname(repo)) throw Error('Cannot locate shared route/core inputs')
  repo = path.dirname(repo)
}
const { newProject, applyOps } = await import(pathToFileURL(path.join(repo, 'editor/core/project.js')))
const htm = createRequire(path.join(repo, 'editor/package.json'))('htm')
const browserSource = fs.readFileSync(new URL('../web/ui/browser.js', import.meta.url), 'utf8')
const storeSource = fs.readFileSync(new URL('../web/ui/store.js', import.meta.url), 'utf8')
const storeInitializer = storeSource.match(/^export const store = \{[^]*?^\}/m)
assert.ok(storeInitializer, 'extract actual initial browser store')
const routeSource = fs.readFileSync(path.join(repo, 'editor/server.mjs'), 'utf8')
const notices = () => {
  const messages = []
  return { messages, notify: (text, kind = 'info') => messages.push({ text, kind }) }
}
const errors = messages => messages.filter(item => item.kind === 'error')
const successes = messages => messages.filter(item => item.text.startsWith('Imported '))

for (const [assets, text, kind] of [
  [{ a: {} }, 'Imported 1 of 2 files. Some files could not be imported.', 'info'],
  [{ a: {}, b: {} }, 'Imported 2 files', 'info'],
  [{}, 'No media was imported. The files may be unsupported or unreadable.', 'error'],
]) {
  test(`upload receipt follows actual assets: ${Object.keys(assets).length} of two`, async () => {
    const n = notices(), uploads = [], requests = []
    const result = await uploadMediaFiles([{ name: 'good.png' }, { name: 'bad.mov' }], {
      ...n,
      upload: async file => { uploads.push(file.name); return { path: `media/${file.name}` } },
      request: async (url, body) => { requests.push({ url, body }); return { assets } },
    })
    assert.equal(result.count, Object.keys(assets).length)
    assert.deepEqual(uploads, ['good.png', 'bad.mov'])
    assert.deepEqual(requests, [{ url: '/api/import', body: { paths: ['media/good.png', 'media/bad.mov'] } }])
    assert.deepEqual(n.messages.at(-1), { text, kind })
  })
}

test('duplicate upload paths report distinct imported assets without inventing skipped files', async () => {
  const n = notices(), requests = []
  const result = await uploadMediaFiles([{ name: 'a' }, { name: 'a' }], {
    ...n, upload: async () => ({ path: 'media/a' }),
    request: async (_url, body) => { requests.push(body); return { assets: { 'media/a': {} } } },
  })
  assert.equal(result.count, 1)
  assert.deepEqual(requests, [{ paths: ['media/a'] }])
  assert.equal(n.messages.at(-1).text, 'Imported 1 file')
})

for (const [label, upload] of [
  ['network rejection', async () => { throw Error('Upload connection failed') }],
  ['HTTP error object', async () => ({ error: 'Disk full' })],
  ['missing path', async () => ({})],
  ['invalid path', async () => ({ path: 3 })],
]) {
  test(`upload ${label} is reported without a success toast or import call`, async () => {
    const n = notices(); let called = false
    const result = await uploadMediaFiles([{ name: 'clip.mov' }], { ...n, upload, request: async () => { called = true } })
    assert.equal(result, null)
    assert.equal(called, false)
    assert.equal(errors(n.messages).length, 1)
    assert.equal(successes(n.messages).length, 0)
  })
}

test('a later upload failure preserves prior uploaded data without claiming any import', async () => {
  const n = notices(), stored = [], requests = []
  const result = await uploadMediaFiles([{ name: 'keep.mov' }, { name: 'failed.mov' }], {
    ...n, upload: async file => { if (stored.length) throw Error('Provider disconnected'); stored.push(file.name); return { path: `media/${file.name}` } },
    request: async (...args) => requests.push(args),
  })
  assert.equal(result, null)
  assert.deepEqual(stored, ['keep.mov'])
  assert.deepEqual(requests, [])
  assert.equal(successes(n.messages).length, 0)
  assert.equal(errors(n.messages).length, 1)
})

for (const result of [null, {}, { assets: null }, { assets: [] }, { assets: 'bad' }, { error: 'Access denied', assets: {} }]) {
  test(`malformed/error import result is handled: ${JSON.stringify(result)}`, async () => {
    const n = notices()
    assert.equal(await importMediaPaths(['a.mov'], { ...n, request: async () => result }), null)
    assert.equal(errors(n.messages).length, 1)
    assert.equal(successes(n.messages).length, 0)
  })
}

test('import API rejection remains a handled outcome with the provider reason', async () => {
  const n = notices()
  assert.equal(await importMediaPaths(['missing'], { ...n, request: async () => { throw Error('The folder is unavailable') } }), null)
  assert.deepEqual(n.messages, [{ text: 'Import failed: The folder is unavailable', kind: 'error' }])
})

test('empty file selection and empty path request do not send requests or claim success', async () => {
  const n = notices(), unexpected = () => assert.fail('Cancelled selection must not call a service')
  assert.equal(await uploadMediaFiles([], { ...n, upload: unexpected, request: unexpected }), null)
  assert.equal(await importMediaPaths([], { ...n, request: unexpected }), null)
  assert.deepEqual(n.messages, [])
})

function renderFixture({ seed = [], request = async () => ({ assets: {} }), upload = async file => ({ path: file.name }) } = {}) {
  const n = notices(), handlers = {}, states = [...seed]
  let hook = 0
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
  const context = vm.createContext({ h, htm, innerWidth: 1024, api: request, host: { upload }, toast: n.notify,
    importMediaPaths, uploadMediaFiles,
    useState: initial => { const index = hook++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value }] },
    useEffect() {}, useLayoutEffect() {}, useRef: value => ({ current: value }),
    window: { addEventListener: (event, handler) => { handlers[event] = handler } },
  })
  vm.runInContext(storeInitializer[0].replace(/^export /, '') + '\n' + browserSource.replace(/^import .*$/gm, '').replace(/^export /gm, '') + '\nglobalThis.UI = { FolderPicker, MediaTab, installDropImport }', context)
  function render(name, props) { hook = 0; return context.UI[name](props) }
  function nodes(value) { return value && typeof value === 'object' ? [value, ...(value.children ?? []).flatMap(nodes)] : [] }
  return { ...n, handlers, render, nodes, installDrop: context.UI.installDropImport }
}

for (const source of ['folder row', 'bulk folder']) {
  test(`actual ${source} event catches rejection and leaves the picker open`, async () => {
    let closed = 0
    const f = renderFixture({ seed: ['.', { dir: '', entries: [{ path: 'bad.mov', name: 'bad.mov', dir: false }] }], request: async () => { throw Error('Project folder disappeared') } })
    const tree = f.render('FolderPicker', { onClose: () => { closed++ } })
    const control = f.nodes(tree).find(node => source === 'folder row' ? node.props.class === 'file-row' : node.type === 'button' && typeof node.props.disabled === 'boolean')
    assert.ok(control, 'actual import control found')
    await control.props.onClick()
    assert.equal(closed, 0)
    assert.equal(errors(f.messages).length, 1)
    assert.equal(successes(f.messages).length, 0)
  })
}


test('actual individual folder row reports zero imported assets without claiming file success', async () => {
  const f = renderFixture({ seed: ['.', { dir: '', entries: [{ path: 'bad.mov', name: 'bad.mov', dir: false }] }], request: async () => ({ assets: {} }) })
  const row = f.nodes(f.render('FolderPicker', { onClose() {} })).find(node => node.props.class === 'file-row')
  await row.props.onClick()
  assert.equal(errors(f.messages).length, 1)
  assert.equal(successes(f.messages).length, 0)
})

for (const count of [0, 1, 2]) {
  test(`actual bulk folder button closes only after imported assets: ${count}`, async () => {
    let closed = 0
    const assets = Object.fromEntries(Array.from({ length: count }, (_, index) => [`asset-${index}`, {}]))
    const f = renderFixture({ seed: ['.', { dir: 'shots', entries: [{ path: 'a', name: 'a', dir: false }, { path: 'b', name: 'b', dir: false }] }], request: async (url, body) => {
      assert.equal(url, '/api/import'); assert.deepEqual(Array.from(body.paths), ['shots']); return { assets }
    } })
    const control = f.nodes(f.render('FolderPicker', { onClose: () => { closed++ } })).find(node => node.type === 'button' && typeof node.props.disabled === 'boolean')
    await control.props.onClick()
    assert.equal(closed, count ? 1 : 0)
    assert.equal(f.messages.at(-1).text, count === 0 ? 'No media was imported. The files may be unsupported or unreadable.' : count === 1 ? 'Imported 1 of 2 files. Some files could not be imported.' : 'Imported 2 files')
  })
}

test('actual file input resets its selection and handles upload failure', async () => {
  const f = renderFixture({ upload: async () => { throw Error('Upload failed') } })
  const input = f.nodes(f.render('MediaTab', { p: { assets: {} } })).find(node => node.type === 'input' && node.props.type === 'file')
  assert.ok(input)
  const target = { files: [{ name: 'clip.mov' }], value: 'clip.mov' }
  await input.props.onChange({ target })
  assert.equal(target.value, '')
  assert.equal(errors(f.messages).length, 1)
  assert.equal(successes(f.messages).length, 0)
})

test('actual file input cancellation produces no upload, request or toast', async () => {
  const unexpected = async () => assert.fail('Cancelled chooser must not import')
  const f = renderFixture({ upload: unexpected, request: unexpected })
  const input = f.nodes(f.render('MediaTab', { p: { assets: {} } })).find(node => node.type === 'input' && node.props.type === 'file')
  await input.props.onChange({ target: { files: [], value: '' } })
  assert.deepEqual(f.messages, [])
})

test('actual drop event handles rejected import API requests without unhandled rejection', async () => {
  const f = renderFixture({ request: async () => { throw Error('Could not import uploaded media') } })
  f.installDrop()
  let prevented = false
  await f.handlers.drop({ dataTransfer: { files: [{ name: 'clip.mov' }] }, preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(errors(f.messages).length, 1)
  assert.equal(successes(f.messages).length, 0)
})

function actualImportRoute(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-import-receipt-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'good.wav'), 'fixture audio')
  fs.writeFileSync(path.join(root, 'bad.mov'), 'fixture unprobeable')
  const context = vm.createContext({ ROOT: root, fs, path, project: newProject('Import test'), version: 0,
    newProject, applyOps, isAryaMusicAsset, reimportMusicAsset, prepareMusicReimport, assertAssistantPublication() {},
    probe: async rel => { if (rel.endsWith('bad.mov')) throw Error('Unsupported fixture'); return { hasAudio: true, hasVideo: false, duration: 2, codec: 'pcm_s16le' } },
    ensureProxy: async () => {}, filmstrip: async () => {}, log() {},
  })
  context.commit = next => { context.project = next; context.version++ }
  const body = routeSource.match(/'POST \/api\/import': async body => \{([^]*?)\n  \},/)
  assert.ok(body, 'extract actual server import route')
  const mediaExtensions = routeSource.match(/^const MEDIA_EXT = .*$/m)
  assert.ok(mediaExtensions, 'extract actual server media classification')
  vm.runInContext(`${mediaExtensions[0]}\nglobalThis.importRoute = async body => {${body[1]}\n}`, context)
  return { root, request: async (route, body) => { assert.equal(route, '/api/import'); return context.importRoute(body) }, state: context }
}

test('actual server route + actual upload controller report a probe-filtered partial import', async t => {
  const route = actualImportRoute(t), n = notices()
  const receipt = await uploadMediaFiles([{ name: 'good.wav' }, { name: 'bad.mov' }], { ...n, upload: async file => ({ path: file.name }), request: route.request })
  assert.equal(receipt.count, 1)
  assert.deepEqual(Object.keys(route.state.project.assets), ['good.wav'])
  assert.equal(n.messages.at(-1).text, 'Imported 1 of 2 files. Some files could not be imported.')
  assert.equal(fs.readFileSync(path.join(route.root, 'bad.mov'), 'utf8'), 'fixture unprobeable', 'failed original retained')
})

test('actual server directory route + actual bulk UI use imported asset count', async t => {
  const route = actualImportRoute(t); let closed = 0
  const f = renderFixture({ seed: ['.', { dir: '', entries: [{ path: 'good.wav', name: 'good.wav', dir: false }, { path: 'bad.mov', name: 'bad.mov', dir: false }] }], request: route.request })
  const control = f.nodes(f.render('FolderPicker', { onClose: () => { closed++ } })).find(node => node.type === 'button' && typeof node.props.disabled === 'boolean')
  await control.props.onClick()
  assert.equal(closed, 1)
  assert.equal(f.messages.at(-1).text, 'Imported 1 of 2 files. Some files could not be imported.')
  assert.deepEqual(Object.keys(route.state.project.assets), ['good.wav'])
})

test('actual missing-folder route rejection becomes an error toast without closing bulk picker', async t => {
  const route = actualImportRoute(t); let closed = 0
  const f = renderFixture({ seed: ['missing', { dir: 'missing', entries: [{ path: 'missing/good.wav', name: 'good.wav', dir: false }] }], request: route.request })
  const control = f.nodes(f.render('FolderPicker', { onClose: () => { closed++ } })).find(node => node.type === 'button' && typeof node.props.disabled === 'boolean')
  await control.props.onClick()
  assert.equal(closed, 0)
  assert.equal(errors(f.messages).length, 1)
  assert.equal(successes(f.messages).length, 0)
  assert.deepEqual(Object.keys(route.state.project.assets), [])
})

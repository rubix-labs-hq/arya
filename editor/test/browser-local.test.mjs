import test from 'node:test'
import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { File } from 'node:buffer'
import * as core from '../core/project.js'
import { validateExportSpec } from '../core/processing-export.js'
import { admitBackupProject } from '../web/browser-local/project-admission.js'
import { BrowserStorage } from '../web/browser-local/storage.js'
import { newFx } from '../core/audio-fx.js'
import { BUILTIN_PRESETS } from '../web/ui/color/presets.js'
import { createDeliveryPreview, formatFileSize } from '../web/browser-local/delivery-preview.js'
import { mediaDisplayName } from '../web/ui/media-label.js'
import { importedMediaNavigation } from '../web/browser-local/import-result.js'
import { BrowserBackend } from '../web/browser-local/backend.js'
import { readBackup, restoreBackup, writeBackup } from '../web/browser-local/backup.js'

globalThis.File ??= File
const clone = value => structuredClone(value)
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture() {
  const records = new Map(), files = new Map(), outputs = new Map(), commits = [], urls = new Map()
  let number = 0, copyCount = 0
  const storage = {
    selected: null, heldRestores: new Set(),
    async holdRestore(id) { this.heldRestores.add(id); return async () => this.heldRestores.delete(id) },
    async stagedRestores() { const groups = new Map(); for (const row of files.values()) if (!records.has(row.project) && row.owner === 'backup-restore') { if (!groups.has(row.project)) groups.set(row.project, { id: row.project, files: [], bytes: 0 }); const group = groups.get(row.project); group.files.push(row); group.bytes += row.size } return [...groups.values()] },
    async current() { return this.selected }, async select(id) { if (this.selectWait) await this.selectWait; this.selected = id },
    async project(id) { return records.has(id) ? clone(records.get(id)) : undefined }, async list() { return [...records.values()].map(clone) },
    async commit(record, expected) {
      if (this.wait) await this.wait
      if (this.fail) throw new Error(this.fail)
      if (expected === null ? records.has(record.id) : records.get(record.id)?.version !== expected) throw new Error('changed in another tab')
      records.set(record.id, clone(record)); commits.push(clone(record))
    },
    async files(project) { return [...files.values()].filter(value => value.project === project).map(({ file, ...record }) => record) },
    async read(record) { if (!files.has(record.id)) throw new Error('missing media'); return files.get(record.id).file },
    async copy(project, file, options = {}) {
      copyCount++; if (this.copyWait) await this.copyWait
      options.signal?.throwIfAborted(); if (options.current?.() === false) throw new Error('project changed')
      const key = `f${++number}`, path = options.path ?? `media/${key}-${file.name}`
      const record = { id: `${project}:${key}`, project, key, path, name: file.name, size: file.size, type: file.type, modified: file.lastModified, ...(options.staging ? { owner: 'backup-restore' } : {}) }
      files.set(record.id, { ...record, file }); return record
    },
    async temporaryWriter(project, key) { const writer = await this.writer(project, key); return { ...writer, dispose: async () => { outputs.delete(`${project}:${key}`); this.disposals = (this.disposals ?? 0) + 1 } } },
    async writer(project, key) {
      const storage = this
      const writes = []; let aborted = false, closed = false
      return {
        async write(bytes, position) { if (aborted || closed) throw new Error('writer closed'); writes.push({ bytes: bytes.slice(), position }) },
        async close() { if (storage.closeWait) await storage.closeWait; if (aborted) throw new Error('aborted'); closed = true; const size = writes.reduce((value, row) => Math.max(value, row.position + row.bytes.length), 0), bytes = new Uint8Array(size); for (const row of writes) bytes.set(row.bytes, row.position); outputs.set(`${project}:${key}`, new File([bytes], key)) },
        async release() { storage.releases = (storage.releases ?? 0) + 1 },
        async dispose() { outputs.delete(`${project}:${key}`); storage.exportDisposals = (storage.exportDisposals ?? 0) + 1 },
        async abort() { aborted = true }, async file() { if (storage.fileWait) await storage.fileWait; if (!closed) throw new Error('not closed'); return outputs.get(`${project}:${key}`) },
      }
    },
    async outputFile(project, key) { const file = outputs.get(`${project}:${key}`); if (!file) throw new Error('missing output'); return file },
    async status() { return { persisted: false, usage: 0, quota: 1024 * 1024 } },
  }
  const media = {
    async capabilities() { return { gpu: true, aac: true, h264: true, hevc: false } },
    async probe(file) { if (this.wait) await this.wait; if (this.fail) throw new Error(this.fail); return { hasVideo: true, hasAudio: false, duration: 8, width: 64, height: 64 } },
    async strip() { return { blob: new Blob(['thumb']), w: 320, h: 320, count: 8 } }, async peaks() { return { peaks: [4, 30], perSec: 1 } },
  }
  const backend = new BrowserBackend({ storage, media, core, validateExportSpec, uuid: () => `00000000-0000-0000-0000-${String(++number).padStart(12, '0')}`, urls: { createObjectURL(file) { const url = `blob:fake-${++number}`; urls.set(url, file); return url }, revokeObjectURL(url) { urls.delete(url) } } })
  return { backend, storage, media, records, files, outputs, commits, urls, copies: () => copyCount }
}
async function started() { const f = fixture(); await f.backend.initialize(); await f.backend.request('/api/new', { name: 'Journey' }); return f }
const title = text => ({ op: 'add_title', text, dur: 4 })
const edit = (backend, text) => backend.request('/api/ops', { ops: [title(text)], expectedVersion: backend.record.version })
async function copied(f, name = 'café 🎬.mp4') { return f.backend.upload(new File(['owned original media bytes'], name, { type: 'video/mp4' })) }
async function imported(f) { const upload = await copied(f); await f.backend.request('/api/import', { paths: [upload.path] }); return upload.path }
async function exportJob(f) { if (!core.duration(f.backend.record.project)) await edit(f.backend, 'Export title'); return f.backend.request('/api/export', { renderer: 'webcodecs', preset: 'h264-high', range: { in: 0, out: 4 }, expectedProject: JSON.stringify(f.backend.record.project) }) }

test('new project is acknowledged only after committed storage, with native editable format', async () => { const f = await started(); assert.equal(f.backend.record.project.version, 3); assert.equal(f.records.get(f.backend.record.id).version, 1); assert.equal(f.storage.selected, f.backend.record.id) })
test('deferred commit publishes no saved project receipt before durable acknowledgment', async () => { const f = await started(), gate = deferred(), events = []; f.backend.events({ project: value => events.push(value) }); f.storage.wait = gate.promise; const pending = edit(f.backend, 'Waiting'); await Promise.resolve(); await Promise.resolve(); assert.equal(events.length, 0); assert.equal(f.backend.record.version, 1); gate.resolve(); await pending; assert.equal(events[0].version, 2) })
test('quota failure leaves the prior saved project and version intact', async () => { const f = await started(); f.storage.fail = 'Quota exceeded'; await assert.rejects(edit(f.backend, 'Rejected'), /Quota/); assert.equal(f.backend.record.version, 1); assert.equal(core.duration(f.backend.record.project), 0); assert.equal(f.commits.length, 1) })
test('stale expected version rejects before applying a core operation', async () => { const f = await started(); await edit(f.backend, 'Current'); await assert.rejects(f.backend.request('/api/ops', { expectedVersion: 1, ops: [title('Stale')] }), /changed/); assert.equal(f.backend.record.version, 2) })
test('another-tab CAS conflict rejects and project refresh reads the actual durable revision', async () => { const f = await started(), current = clone(f.backend.record); current.project = core.applyOps(current.project, [title('Other tab')]).project; current.version++; f.records.set(current.id, current); await assert.rejects(edit(f.backend, 'Lost edit'), /another tab/); const value = await f.backend.request('/api/project'); assert.equal(value.version, 2); assert.equal(value.project.tracks.flatMap(track => track.clips)[0].title.text, 'Other tab') })
test('native title, undo and redo persist as separate acknowledged revisions', async () => { const f = await started(); await edit(f.backend, 'Editable'); assert.equal(core.duration(f.backend.record.project), 4); await f.backend.request('/api/undo', {}); assert.equal(core.duration(f.backend.record.project), 0); await f.backend.request('/api/redo', {}); assert.equal(core.duration(f.backend.record.project), 4); assert.equal(f.backend.record.version, 4) })
test('completed copy is distinct from registered media and retains its own File', async () => { const f = await started(), upload = await copied(f); assert.equal(Object.keys(f.backend.record.project.assets).length, 0); const receipt = await f.backend.request('/api/import', { paths: [upload.path] }); assert.equal(Object.keys(receipt.assets).length, 1); assert.equal(f.backend.fileForURL(f.backend.url(`/media?path=${encodeURIComponent(upload.path)}`)).size, 26) })
test('failed probe retains the completed copy and an explicit retry avoids copying again', async () => { const f = await started(), upload = await copied(f); f.media.fail = 'unsupported'; const failed = await f.backend.request('/api/import', { paths: [upload.path] }); assert.equal(Object.keys(failed.assets).length, 0); assert.equal(failed.failures.length, 1); assert.equal((await f.backend.request('/api/browser/copies')).paths[0], upload.path); f.media.fail = null; await f.backend.request('/api/import', { paths: [upload.path] }); assert.equal(f.copies(), 1) })
test('registered retry avoids duplicate probing and asset registration', async () => { const f = await started(), path = await imported(f); f.media.probe = () => { throw new Error('must not probe twice') }; const receipt = await f.backend.request('/api/import', { paths: [path, path] }); assert.equal(Object.keys(receipt.assets).length, 1); assert.equal(Object.keys(f.backend.record.project.assets).length, 1); assert.equal(f.copies(), 1) })
test('copy cancellation registers nothing and can be retried', async () => { const f = await started(), gate = deferred(); f.storage.copyWait = gate.promise; const pending = copied(f); await Promise.resolve(); await Promise.resolve(); await f.backend.request('/api/browser/import/cancel'); gate.resolve(); await assert.rejects(pending); assert.equal(Object.keys(f.backend.record.project.assets).length, 0); assert.equal(f.backend.importController, null) })
test('cancel during deferred probe retains copies but publishes no imported asset', async () => { const f = await started(), upload = await copied(f), gate = deferred(); f.media.wait = gate.promise; const pending = f.backend.request('/api/import', { paths: [upload.path] }); await Promise.resolve(); await Promise.resolve(); await f.backend.request('/api/browser/import/cancel'); gate.resolve(); await assert.rejects(pending); assert.equal(f.backend.record.version, 1); assert.equal(f.files.size, 1) })
test('direct unverified import operation is rejected instead of producing fake assets', async () => { const f = await started(); await assert.rejects(f.backend.request('/api/ops', { ops: [{ op: 'import', assets: { '/etc/private': { hasVideo: true } } }] }), /verified/); assert.deepEqual(f.backend.record.project.assets, {}) })
test('media URLs are confined to copied project paths and project switch revokes old URLs', async () => { const f = await started(), path = await imported(f), url = f.backend.url(`/media?path=${encodeURIComponent(path)}`); await assert.rejects(f.backend.resource('/media?path=/Users/private')); assert.throws(() => f.backend.url('/media?path=../secret')); await f.backend.request('/api/new', { name: 'Second' }); assert.equal(f.urls.has(url), false); assert.equal(f.backend.fileForURL(url), null) })
test('unsupported subscription and analysis calls give honest errors and no success jobs', async () => { const f = await started(); assert.equal(f.backend.assistantStatus().configured, false); assert.equal(f.backend.caps().analysis.transcript, false); await assert.rejects(f.backend.request('/api/assistant/login', {}), /no agent/); await assert.rejects(f.backend.request('/api/analyze', {}), /native/); assert.equal(f.backend.jobs.size, 0) })
test('export admission rejects unsupported presets and stale snapshots', async () => { const f = await started(); await edit(f.backend, 'Ready'); await assert.rejects(f.backend.request('/api/export', { preset: 'prores', expectedProject: JSON.stringify(f.backend.record.project) }), /cannot encode/); await assert.rejects(f.backend.request('/api/export', { preset: 'h264-high', expectedProject: '{}' }), /changed/); assert.equal(f.backend.jobs.size, 0) })
test('accepted export snapshot is immutable across subsequent editable operations', async () => { const f = await started(), path = await imported(f); await f.backend.request('/api/ops', { ops: [{ op: 'append', src: path }] }); const job = await exportJob(f); await edit(f.backend, 'Later edit'); assert.equal(job.acceptedProject.tracks.flatMap(track => track.clips).filter(clip => clip.kind === 'title').length, 0); assert.equal(f.backend.jobs.get(job.id).sourceCohort[0].path, path); await assert.rejects(f.backend.request('/api/new', { name: 'Blocked' }), /export/) })
test('completed export closes its writer and verifies actual output before delivery', async () => { const f = await started(), job = await exportJob(f); await f.backend.save(new Uint8Array([3, 4, 5]), { job: job.id, position: 0 }); assert.equal(f.backend.record.deliveries.length, 0); const finished = await f.backend.request('/api/export/finish', { id: job.id, drained: true }); assert.equal(finished.state, 'done'); assert.equal(f.backend.record.deliveries[0].size, 3); assert.equal((await f.backend.request('/api/deliveries')).deliveries[0].available, true) })
test('zero-byte or un-drained exports never become saved deliveries', async () => { const f = await started(), job = await exportJob(f); await assert.rejects(f.backend.request('/api/export/finish', { id: job.id }), /drain/); await assert.rejects(f.backend.request('/api/export/finish', { id: job.id, drained: true }), /completed export/); assert.equal(f.backend.record.deliveries.length, 0); assert.equal(f.backend.jobs.get(job.id).state, 'failed'); assert.equal(f.outputs.size, 0); assert.equal(f.storage.exportDisposals, 1) })
test('cancelled export refuses writes and requires drain before another project', async () => { const f = await started(), job = await exportJob(f); await f.backend.request('/api/jobs/cancel', { id: job.id }); assert.deepEqual(await f.backend.save(new Uint8Array([9]), { job: job.id, position: 0 }), { cancelled: true }); await assert.rejects(f.backend.request('/api/new', {}), /export/); await f.backend.request('/api/export/finish', { id: job.id, drained: true }); assert.equal(f.backend.record.deliveries.length, 0); await f.backend.request('/api/new', {}) })
test('export metadata storage failure leaves no completed delivery claim', async () => { const f = await started(), job = await exportJob(f); await f.backend.save(new Uint8Array([1]), { job: job.id, position: 0 }); f.storage.fail = 'storage unavailable'; await assert.rejects(f.backend.request('/api/export/finish', { id: job.id, drained: true }), /storage/); assert.equal(f.backend.record.deliveries.length, 0); assert.equal(f.backend.jobs.get(job.id).state, 'failed') })
test('full backup and reopen preserve Unicode names, native layers and exact media bytes', async () => { const f = await started(), path = await imported(f); await f.backend.request('/api/ops', { ops: [{ op: 'append', src: path }, title('Native title')] }); const signal = new AbortController().signal, backup = await writeBackup(f.backend, signal), parsed = await readBackup(backup.file), before = f.backend.root(); assert.equal(parsed.files[0].name, 'café 🎬.mp4'); assert.equal(await parsed.files[0].file.text(), 'owned original media bytes'); await restoreBackup(f.backend, backup.file, signal); assert.notEqual(f.backend.root(), before); assert.equal(f.backend.record.project.tracks.flatMap(track => track.clips).length, 2); assert.equal(await f.backend.file(path).text(), 'owned original media bytes') })
test('full backup retains completed unregistered copies for later retry', async () => { const f = await started(); await copied(f); const signal = new AbortController().signal, backup = await writeBackup(f.backend, signal); await restoreBackup(f.backend, backup.file, signal); assert.equal(Object.keys(f.backend.record.project.assets).length, 0); assert.equal((await f.backend.request('/api/browser/copies')).paths.length, 1) })
test('truncated backups reject without changing the existing project', async () => { const f = await started(); await imported(f); const backup = await writeBackup(f.backend, new AbortController().signal), before = f.backend.root(); await assert.rejects(restoreBackup(f.backend, backup.file.slice(0, backup.file.size - 1), new AbortController().signal), /incomplete/); assert.equal(f.backend.root(), before) })
test('backup traversal entry rejects before any copy or registration', async () => { const f = await started(), header = JSON.stringify({ format: 'arya-browser-backup', version: 1, project: f.backend.record.project, files: [{ path: 'media/../../private', size: 1 }] }), bytes = new TextEncoder().encode(header), file = new File([`ARYA-BROWSER-BACKUP-1\n${bytes.length}\n`, bytes, 'x'], 'unsafe.arya'); await assert.rejects(restoreBackup(f.backend, file, new AbortController().signal), /unsafe/); assert.equal(f.copies(), 0) })
test('failed restored probe preserves the current project and original backup', async () => { const f = await started(); await imported(f); const backup = await writeBackup(f.backend, new AbortController().signal), before = f.backend.root(), size = backup.file.size; f.media.fail = 'codec unavailable'; await assert.rejects(restoreBackup(f.backend, backup.file, new AbortController().signal), /codec/); assert.equal(f.backend.root(), before); assert.equal(backup.file.size, size) })

const spin = async predicate => { for (let n = 0; n < 100; n++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)) } throw new Error('test admission not reached') }
function archive(project, entries = []) {
  const header = new TextEncoder().encode(JSON.stringify({ format: 'arya-browser-backup', version: 1, project, files: entries.map(({ file, ...metadata }) => metadata) }))
  return new File([`ARYA-BROWSER-BACKUP-1\n${header.length}\n`, header, ...entries.map(entry => entry.file)], 'validation.arya')
}
for (const [name, mutate] of [
  ['future version', p => { p.version = 999 }],
  ['invalid dimensions', p => { p.width = -1920 }],
  ['invalid frame rate', p => { p.fps = 0 }],
  ['invalid sample rate', p => { p.sampleRate = 0 }],
  ['invalid tracks', p => { p.tracks[0].clips = {} }],
  ['unresolved media', p => { p.tracks[0].clips.push({ id: 'c1', kind: 'video', src: 'media/missing.mp4', start: 0, dur: 4 }) }],
  ['unresolved composition', p => { p.tracks[0].clips.push({ id: 'c1', kind: 'comp', comp: 'gone', start: 0, dur: 4 }) }],
  ['composition cycle', p => { p.comps.loop = { id: 'loop', width: 1920, height: 1080, fps: 30, tracks: [{ id: 'V1', kind: 'video', clips: [{ id: 'c1', kind: 'comp', comp: 'loop', start: 0, dur: 4 }] }] } }],
  ['missing parent', p => { p.tracks[0].clips.push({ id: 'c1', kind: 'null', start: 0, dur: 4, parent: 'gone' }) }],
  ['invalid keyframes', p => { p.tracks[0].clips.push({ id: 'c1', kind: 'null', start: 0, dur: 4, anim: { x: [[2, 0], [1, 2]] } }) }],
  ['duplicate clips', p => { p.tracks[0].clips.push(...[1, 2].map(() => ({ id: 'c1', kind: 'null', start: 0, dur: 4 }))) }],
  ['invalid graph', p => { p.tracks[0].clips.push({ id: 'c1', kind: 'null', start: 0, dur: 4, nodes: { list: [], links: [] } }) }],
]) test(`backup admission rejects ${name} before any copies or commits`, async () => {
  const f = await started(), p = clone(f.backend.record.project), before = clone(f.backend.record)
  mutate(p)
  const own = new File(['retained payload'], 'unused.mp4'), input = archive(p, [{ path: 'media/unused.mp4', name: own.name, size: own.size, file: own }])
  await assert.rejects(restoreBackup(f.backend, input, new AbortController().signal))
  assert.equal(f.copies(), 0); assert.equal(f.commits.length, 1); assert.equal(f.records.size, 1); assert.deepEqual(f.backend.record, before)
})
test('admission preserves native motion, nodes, mixer, presets, library and unused Media without normalization', async () => {
  const f = await started(), path = await imported(f)
  await edit(f.backend, 'Motion title')
  const p = clone(f.backend.record.project), title = p.tracks.flatMap(track => track.clips)[0]
  title.anim = { x: [[0, 0], [3, 100, 'smooth']] }; title.nodes = clone(BUILTIN_PRESETS[0].nodes)
  p.tracks.find(track => track.kind === 'audio').fx = [newFx('compressor')]
  p.master = { volume: -2, fx: [newFx('gain')], limiter: { enabled: true, ceiling: -1 }, target: -14 }
  p.nodePresets = { grade: clone(BUILTIN_PRESETS[0]) }
  p.comps.unused = { id: 'unused', name: 'Unused comp', width: 1920, height: 1080, fps: 30, duration: 5, range: { in: 0, out: 5 }, tracks: [] }
  p.library.items = [{ id: 'library_title', name: 'Reusable title', category: 'title', body: { clip: { id: 'library_c1', kind: 'title', start: 0, dur: 3, title: { text: 'Reusable', size: 60 } }, assets: {} } }]
  const before = JSON.parse(JSON.stringify(p)), source = f.backend.file(path)
  const admitted = await readBackup(archive(p, [{ path, name: source.name, size: source.size, type: source.type, file: source }]))
  assert.deepEqual(admitted.project, before)
})
for (const phase of ['close', 'file']) test(`accepted export cancellation during deferred ${phase} cannot publish a delivery`, async () => {
  const f = await started(), job = await exportJob(f), gate = deferred()
  await f.backend.save(new Uint8Array([1, 2]), { job: job.id, position: 0 })
  f.storage[`${phase}Wait`] = gate.promise
  const finishing = f.backend.request('/api/export/finish', { id: job.id, drained: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal((await f.backend.request('/api/jobs/cancel', { id: job.id })).cancelled, true)
  gate.resolve(); assert.equal((await finishing).state, 'cancelled'); assert.equal(f.backend.record.deliveries.length, 0); assert.equal(f.outputs.size, 0); assert.equal(f.storage.exportDisposals, 1)
})
test('delivery commit boundary rejects late cancellation and stays active until acknowledgment', async () => {
  const f = await started(), job = await exportJob(f), gate = deferred()
  await f.backend.save(new Uint8Array([1]), { job: job.id, position: 0 }); f.storage.wait = gate.promise
  const finishing = f.backend.request('/api/export/finish', { id: job.id, drained: true })
  await spin(() => f.backend.jobs.get(job.id).state === 'committing')
  const cancelled = await f.backend.request('/api/jobs/cancel', { id: job.id }); assert.equal(cancelled.cancelled, false); assert.match(cancelled.reason, /saved/)
  assert.equal(f.backend.record.deliveries.length, 0); assert.equal(f.backend.jobs.get(job.id).cancelled, undefined)
  gate.resolve(); assert.equal((await finishing).state, 'done'); assert.equal(f.backend.record.deliveries.length, 1)
})
test('restore exposes noncancellable commit and selection rather than accepting ineffective Cancel', async () => {
  const f = await started(), signal = new AbortController(), backup = await writeBackup(f.backend, signal.signal), gate = deferred(), phases = []
  f.storage.selectWait = gate.promise
  const restore = restoreBackup(f.backend, backup.file, signal.signal, phase => phases.push(phase))
  await spin(() => phases.length > 0)
  assert.deepEqual(phases[0], { cancellable: false, label: 'Saving restored project' })
  signal.abort(); gate.resolve(); const result = await restore
  assert.equal(result.root, `browser:${f.storage.selected}`); assert.notEqual(f.storage.selected, f.commits[0].id)
})
test('backup cancellation during close cleans only its owned temporary and preserves source media', async () => {
  const f = await started(), path = await imported(f), gate = deferred(), signal = new AbortController()
  f.storage.closeWait = gate.promise
  const pending = writeBackup(f.backend, signal.signal)
  await new Promise(resolve => setImmediate(resolve)); signal.abort(); gate.resolve()
  await assert.rejects(pending); assert.equal(f.storage.disposals, 1); assert.equal(f.outputs.size, 0); assert.equal(await f.backend.file(path).text(), 'owned original media bytes')
})
test('successful backup has an explicit disposal after the consumer releases it', async () => {
  const f = await started(), path = await imported(f), backup = await writeBackup(f.backend, new AbortController().signal)
  assert.equal(f.outputs.size, 1); assert.equal(f.storage.disposals, undefined); assert.equal((await readBackup(backup.file)).files.length, 1)
  await backup.dispose(); assert.equal(f.outputs.size, 0); assert.equal(f.storage.disposals, 1); assert.equal(f.files.size, 1); assert.equal(await f.backend.file(path).text(), 'owned original media bytes')
})
test('unimplemented still-frame endpoint is not advertised as available', async () => { const f = await started(); assert.equal(f.backend.caps().export.still, false) })
test('actual storage temporary namespace and lock lifecycle protect active downloads and source files', async () => {
  const held = new Set(), entries = new Map(), removed = []
  const locks = { async request(name, options, callback) {
    if (typeof options === 'function') { callback = options; options = {} }
    if (held.has(name)) { if (options.ifAvailable) return callback(null); throw new Error('unexpected contention') }
    held.add(name); try { return await callback({ name }) } finally { held.delete(name) }
  } }
  const directory = {
    async getFileHandle(key, options) {
      if (!entries.has(key)) { if (!options?.create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' }); entries.set(key, new File([], key)) }
      return { kind: 'file', async getFile() { return entries.get(key) }, async createWritable() {
        const writes = []
        return { async write({ position, data }) { writes.push({ position, data }) }, async close() { const length = writes.reduce((n, row) => Math.max(n, row.position + row.data.length), 0), bytes = new Uint8Array(length); for (const row of writes) bytes.set(row.data, row.position); entries.set(key, new File([bytes], key)) }, async abort() {} }
      } }
    },
    async *entries() { for (const key of entries.keys()) yield [key, await this.getFileHandle(key)] },
    async removeEntry(key) { removed.push(key); entries.delete(key) },
  }
  const folder = { async getDirectoryHandle(name) { assert.equal(name, 'temporary-backups'); return directory } }
  const storage = new BrowserStorage(); storage.folder = async project => { assert.equal(project, 'qa'); return folder }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } })
  try {
    const writer = await storage.temporaryWriter('qa', 'backup-123')
    await writer.write(new Uint8Array([3, 4, 5]), 0); await writer.close()
    assert.equal((await writer.file()).size, 3); assert.equal((await storage.temporaryBackups('qa')).length, 1)
    await assert.rejects(storage.clearTemporaryBackup('qa', 'backup-123'), /still being/)
    assert.deepEqual(removed, [])
    await writer.dispose(); assert.deepEqual(removed, ['backup-123']); assert.equal(held.size, 0)
    entries.set('backup-interrupted', new File(['interrupted'], 'backup-interrupted'))
    await storage.clearTemporaryBackup('qa', 'backup-interrupted'); assert.equal(entries.size, 0)
    await assert.rejects(storage.clearTemporaryBackup('qa', '../source-file'), /Invalid/)
    assert.deepEqual(removed, ['backup-123', 'backup-interrupted'])
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator }
})

test('live backup disposal requires explicit saved-download acknowledgment and no timer deletes it', async () => {
  const f = await started(), backup = await writeBackup(f.backend, new AbortController().signal), url = 'blob:backup-consumer'
  f.urls.set(url, backup.file); f.backend.temporaryConsumers.set(`${backup.projectID}:${backup.key}`, { url, release: backup.dispose })
  await assert.rejects(f.backend.releaseTemporaryBackup(backup.projectID, backup.key, false), /Confirm/)
  assert.equal(f.outputs.size, 1); assert.equal(f.urls.has(url), true)
  await f.backend.releaseTemporaryBackup(backup.projectID, backup.key, true)
  assert.equal(f.outputs.size, 0); assert.equal(f.urls.has(url), false); assert.equal(f.backend.temporaryConsumers.size, 0)
})
test('cancelled restoration after a completed copy exposes staged ownership and releases its active lease', async () => {
  const f = await started(); await imported(f); await copied(f, 'second.mp4')
  const signal = new AbortController(), backup = await writeBackup(f.backend, signal.signal), originalRoot = f.backend.root(), copy = f.storage.copy
  let restored = 0
  f.storage.copy = async function (...args) { const row = await copy.apply(this, args); if (++restored === 1) signal.abort(); return row }
  await assert.rejects(restoreBackup(f.backend, backup.file, signal.signal))
  const staged = await f.storage.stagedRestores()
  assert.equal(f.backend.root(), originalRoot); assert.equal(staged.length, 1); assert.equal(staged[0].files.length, 1); assert.equal(f.records.has(staged[0].id), false); assert.equal(f.storage.heldRestores.size, 0); assert.equal(f.backend.record.project.assets[staged[0].files[0].path].name, 'café 🎬.mp4')
})
test('committed restore survives selection failure and is not advertised as an interrupted copy set', async () => {
  const f = await started(); await imported(f)
  const backup = await writeBackup(f.backend, new AbortController().signal), originalRoot = f.backend.root()
  f.storage.select = async () => { throw new Error('selection refused') }
  await assert.rejects(restoreBackup(f.backend, backup.file, new AbortController().signal), /selection/)
  assert.equal(f.backend.root(), originalRoot); assert.equal(f.records.size, 2); assert.deepEqual(await f.storage.stagedRestores(), []); assert.equal(f.storage.heldRestores.size, 0)
})
function storageHarness() {
  const data = { projects: new Map(), files: new Map(), preferences: new Map() }, removed = [], held = new Set()
  const storage = new BrowserStorage()
  storage.transaction = (names, mode = 'readonly') => {
    const working = Object.fromEntries(names.map(name => [name, new Map([...data[name]].map(([key, value]) => [key, clone(value)]))]))
    let pending = 0, aborted = false, finished = false
    const tx = { error: null, abort() { if (finished) throw new Error('finished'); aborted = true; queueMicrotask(() => tx.onabort?.()) } }
    const enqueue = operation => {
      const request = {}; pending++
      queueMicrotask(() => {
        if (!aborted) { try { request.result = operation(); request.onsuccess?.() } catch (error) { tx.error = error; tx.abort() } }
        pending--
        queueMicrotask(() => { if (!pending && !aborted && !finished) { finished = true; if (mode === 'readwrite') for (const name of names) { data[name].clear(); for (const [key, value] of working[name]) data[name].set(key, clone(value)) } tx.oncomplete?.() } })
      })
      return request
    }
    tx.objectStore = name => ({ get: key => enqueue(() => clone(working[name].get(key))), getAll: () => enqueue(() => [...working[name].values()].map(clone)), put: (value, key) => enqueue(() => working[name].set(key ?? value.id, clone(value))), delete: key => enqueue(() => working[name].delete(key)) })
    return tx
  }
  storage.folder = async project => ({ async removeEntry(key) { if (storage.removeWait) await storage.removeWait; if (storage.removeFail) throw new Error(storage.removeFail); removed.push(`${project}:${key}`) } })
  const locks = { async request(name, options, callback) { if (typeof options === 'function') { callback = options; options = {} } if (held.has(name)) { if (options.ifAvailable) return callback(null); throw new Error('unexpected contention') } held.add(name); try { return await callback({ name }) } finally { held.delete(name) } } }
  const rows = ['a', 'b'].map(key => ({ id: `stage:${key}`, project: 'stage', key, path: `media/${key}.mp4`, size: 8, modified: 123, owner: 'backup-restore' }))
  rows.forEach(row => data.files.set(row.id, row)); data.projects.set('current', { id: 'current', version: 1 }); data.files.set('current:source', { id: 'current:source', project: 'current', key: 'source', size: 20 })
  return { storage, data, removed, rows, locks, held }
}
async function withStorageLocks(fixture, operation) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: fixture.locks } })
  try { return await operation() } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator }
}
test('actual staged cleanup deletes only reviewed unpublished copies and rejects an active restore', async () => {
  const f = storageHarness()
  await withStorageLocks(f, async () => {
    const release = await f.storage.holdRestore('stage')
    await assert.rejects(f.storage.clearStagedRestore('stage', f.rows), /still active/); assert.deepEqual(f.removed, [])
    await release()
    assert.equal((await f.storage.stagedRestores())[0].files.length, 2)
    assert.deepEqual(await f.storage.clearStagedRestore('stage', f.rows), { released: 2 })
    assert.deepEqual(f.removed, ['stage:a', 'stage:b']); assert.equal(f.data.files.has('current:source'), true); assert.equal(f.data.projects.has('current'), true); assert.deepEqual(await f.storage.stagedRestores(), [])
  })
})
test('actual staged cleanup refuses stale inventory and committed projects before any deletion', async () => {
  const f = storageHarness()
  await withStorageLocks(f, async () => {
    await assert.rejects(f.storage.clearStagedRestore('stage', f.rows.slice(0, 1)), /changed/); assert.deepEqual(f.removed, [])
    f.data.projects.set('stage', { id: 'stage', version: 1 })
    await assert.rejects(f.storage.clearStagedRestore('stage', f.rows), /saved project/); assert.deepEqual(f.removed, [])
    assert.deepEqual(await f.storage.stagedRestores(), [])
  })
})
test('actual staged cleanup marker blocks project admission while OPFS removal is deferred', async () => {
  const f = storageHarness(), gate = deferred()
  await withStorageLocks(f, async () => {
    f.storage.removeWait = gate.promise
    const clearing = f.storage.clearStagedRestore('stage', f.rows)
    await spin(() => f.data.preferences.has('restore-cleanup:stage'))
    await assert.rejects(f.storage.commit({ id: 'stage', version: 1 }, null), /being released/)
    assert.equal(f.data.projects.has('stage'), false)
    gate.resolve(); await clearing; assert.equal(f.data.preferences.has('restore-cleanup:stage'), false)
  })
})
test('failed staged cleanup retains visible ownership and admission fence for explicit retry', async () => {
  const f = storageHarness()
  await withStorageLocks(f, async () => {
    f.storage.removeFail = 'OPFS refused cleanup'
    await assert.rejects(f.storage.clearStagedRestore('stage', f.rows), /refused/)
    assert.equal((await f.storage.stagedRestores())[0].files.length, 2); assert.equal(f.data.preferences.has('restore-cleanup:stage'), true)
    await assert.rejects(f.storage.commit({ id: 'stage', version: 1 }, null), /being released/)
    f.storage.removeFail = null; await f.storage.clearStagedRestore('stage', f.rows)
    assert.equal(f.data.files.has('current:source'), true); assert.equal(f.data.preferences.has('restore-cleanup:stage'), false)
  })
})

const importUI = backend => ({ ...backend.snapshot(), source: { seekToken: 4 } })
test('registered import receipt selects an actual source and Media rather than an empty viewer', async () => {
  const f = await started(), path = await imported(f), receipt = clone(f.backend.importState)
  const navigation = importedMediaNavigation(receipt, f.backend, importUI(f.backend))
  assert.equal(navigation.source.src, path); assert.equal(navigation.source.t, 0); assert.equal(navigation.source.seekToken, 5)
  assert.equal(navigation.page, 'media'); assert.equal(navigation.browserTab, 'media'); assert.equal(navigation.viewerMode, 'source')
  assert.equal(navigation.mediaReveal.requestID, receipt.requestID)
})
test('partial import navigation selects only a verified registered file, not a rejected copy', async () => {
  const f = await started(), good = await copied(f, 'good.mp4'), bad = await copied(f, 'bad.mp4'), probe = f.media.probe
  f.media.probe = file => file.name === 'bad.mp4' ? Promise.reject(new Error('unsupported')) : probe.call(f.media, file)
  await f.backend.request('/api/import', { paths: [bad.path, good.path] })
  assert.equal(f.backend.importState.state, 'partial'); assert.equal(f.backend.importState.count, 1)
  assert.equal(f.backend.importState.failures[0].error, 'unsupported')
  assert.equal(importedMediaNavigation(f.backend.importState, f.backend, importUI(f.backend)).source.src, good.path)
})
test('new and open reset import results and reject stale rendered navigation, including reopening the same project', async () => {
  const f = await started(); await imported(f); const receipt = clone(f.backend.importState), first = f.backend.record.id, events = []
  f.backend.events({ import: event => events.push(event) })
  await f.backend.request('/api/new', { name: 'Other' })
  assert.equal(f.backend.importState.state, 'idle'); assert.equal(importedMediaNavigation(receipt, f.backend, importUI(f.backend)), null)
  await f.backend.request('/api/browser/open', { id: first })
  assert.equal(f.backend.importState.state, 'idle'); assert.equal(importedMediaNavigation(receipt, f.backend, importUI(f.backend)), null)
  assert.deepEqual(events.map(event => event.state), ['idle', 'idle'])
})
test('undo or changed asset metadata refuses old import navigation, while unrelated acknowledged edits remain usable', async () => {
  const f = await started(), path = await imported(f), receipt = clone(f.backend.importState)
  await edit(f.backend, 'Unrelated title'); assert.ok(importedMediaNavigation(receipt, f.backend, importUI(f.backend)))
  f.backend.record.project.assets[path].duration++
  assert.equal(importedMediaNavigation(receipt, f.backend, importUI(f.backend)), null)
  const g = await started(); await imported(g); const prior = clone(g.backend.importState)
  await g.backend.request('/api/undo', {}); assert.equal(importedMediaNavigation(prior, g.backend, importUI(g.backend)), null)
})
test('import navigation rejects optimistic or stale UI revisions and lost copied bytes', async () => {
  const f = await started(), path = await imported(f), receipt = clone(f.backend.importState), ui = importUI(f.backend)
  assert.equal(importedMediaNavigation(receipt, f.backend, { ...ui, version: ui.version + 1 }), null)
  assert.equal(importedMediaNavigation(receipt, f.backend, { ...ui, project: { ...ui.project, assets: {} } }), null)
  f.backend.files.delete(path); assert.equal(importedMediaNavigation(receipt, f.backend, ui), null)
})
test('a later failed import invalidates an earlier rendered success action', async () => {
  const f = await started(); await imported(f); const prior = clone(f.backend.importState), upload = await copied(f, 'unsupported.mp4')
  f.media.fail = 'unsupported'; await f.backend.request('/api/import', { paths: [upload.path] })
  assert.equal(f.backend.importState.count, 0); assert.equal(importedMediaNavigation(prior, f.backend, importUI(f.backend)), null)
  assert.equal(importedMediaNavigation(f.backend.importState, f.backend, importUI(f.backend)), null)
})

test('import commit refuses late cancellation and publishes registered media only after storage acknowledgment', async () => {
  const f = await started(), upload = await copied(f), gate = deferred()
  f.storage.wait = gate.promise
  const pending = f.backend.request('/api/import', { paths: [upload.path] })
  await spin(() => f.backend.importState.state === 'committing')
  assert.deepEqual(f.backend.record.project.assets, {})
  const cancellation = await f.backend.request('/api/browser/import/cancel')
  assert.equal(cancellation.cancelled, false); assert.match(cancellation.reason, /being saved/)
  assert.equal(f.backend.importController.signal.aborted, false)
  gate.resolve(); const result = await pending
  assert.equal(result.version, 2); assert.equal(f.backend.importState.state, 'done')
  assert.ok(result.assets[upload.path]); assert.ok(importedMediaNavigation(f.backend.importState, f.backend, importUI(f.backend)))
})
test('repeat explicit import navigation issues a fresh reveal key so Media filters reset again', async () => {
  const f = await started(); await imported(f)
  const first = importedMediaNavigation(f.backend.importState, f.backend, importUI(f.backend))
  const second = importedMediaNavigation(f.backend.importState, f.backend, { ...importUI(f.backend), ...first })
  assert.equal(first.source.src, second.source.src)
  assert.equal(second.mediaReveal.seekToken, first.mediaReveal.seekToken + 1)
})

test('actual hosted transcript component renders one truthful notice and a reachable manual Titles action', async () => {
  const source = await readFile(new URL('../web/ui/transcript.js', import.meta.url), 'utf8')
  const start = source.indexOf('export function Transcript()'), end = source.indexOf('function ConnectedTranscript()')
  assert.ok(start >= 0 && end > start)
  const htmSource = await readFile(new URL('../node_modules/htm/dist/htm.module.js', import.meta.url), 'utf8')
  const { default: htm } = await import(`data:text/javascript;base64,${Buffer.from(htmSource).toString('base64')}`)
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() })
  let revealed = 0
  const html = htm.bind(h), changes = [], connected = () => { throw new Error('Hosted component must not render connected transcript effects') }
  const component = new Function('html', 'host', 'set', 'ConnectedTranscript', 'revealMedia', `${source.slice(start, end).replace('export function', 'function')};return Transcript`) (html, { kind: 'browser-local' }, patch => changes.push(patch), connected, () => revealed++)
  const selected = component(); assert.notEqual(selected.type, connected)
  const rendered = selected.type(), all = []
  const visit = node => { if (node && typeof node === 'object') { all.push(node); node.children?.forEach(visit) } }
  visit(rendered)
  assert.equal(all.filter(node => node.type === 'p').length, 1)
  assert.equal(all.filter(node => node.type === 'input' || node.type === 'details').length, 0)
  const paragraph = all.find(node => node.type === 'p').children.join('')
  assert.match(paragraph, /timed transcript import/); assert.match(paragraph, /unavailable in this browser edition/)
  assert.doesNotMatch(paragraph, /You can import|Install whisper|in Captions/)
  const button = all.find(node => node.type === 'button'); assert.equal(button.children.join(''), 'Open Titles')
  button.props.onClick(); assert.equal(revealed, 1); assert.deepEqual(changes, [{ page: 'edit', browserTab: 'titles' }])
  for (const kind of ['http', 'native']) {
    const retained = new Function('html', 'host', 'set', 'ConnectedTranscript', 'revealMedia', `${source.slice(start, end).replace('export function', 'function')};return Transcript`) (html, { kind }, () => {}, connected, () => {})
    assert.equal(retained().type, connected)
  }
})

async function delivered(f) {
  const job = await exportJob(f)
  await f.backend.save(new Uint8Array([10, 20, 30]), { job: job.id, position: 0 })
  await f.backend.request('/api/export/finish', { id: job.id, drained: true })
  return job
}
test('saved export Preview reads the actual completed OPFS file and releases only its own Blob URL', async () => {
  const f = await started(), path = await imported(f), mediaURL = f.backend.url(`/media?path=${encodeURIComponent(path)}`), job = await delivered(f)
  const preview = await f.backend.request('/api/deliveries/access', { id: job.id, root: f.backend.root(), action: 'preview' })
  assert.deepEqual(new Uint8Array(await f.backend.fileForURL(preview.url).arrayBuffer()), new Uint8Array([10, 20, 30]))
  assert.equal(preview.bytes, 3); assert.equal(preview.audioOnly, false); assert.equal(preview.root, f.backend.root())
  assert.ok((await f.backend.request('/api/deliveries')).actions.includes('preview'))
  f.backend.releaseDeliveryPreview(preview.previewID)
  assert.equal(f.urls.has(preview.url), false); assert.equal(f.backend.fileForURL(preview.url), null)
  assert.ok(f.urls.has(mediaURL)); assert.ok(f.outputs.has(`${f.backend.record.id}:export-${job.id}`))
})
test('missing or changed saved export and wrong-project access produce no preview URL', async () => {
  const f = await started(), job = await delivered(f), count = f.urls.size
  await assert.rejects(f.backend.openDeliveryPreview(job.id, 'browser:other'), /changed/)
  f.outputs.set(`${f.backend.record.id}:export-${job.id}`, new File(['different size'], 'altered.mp4'))
  await assert.rejects(f.backend.openDeliveryPreview(job.id, f.backend.root()), /changed/)
  f.outputs.clear(); await assert.rejects(f.backend.openDeliveryPreview(job.id, f.backend.root()), /missing/)
  assert.equal(f.urls.size, count)
})
test('project switch during deferred output read refuses preview before any URL is created', async () => {
  const f = await started(), job = await delivered(f), read = f.storage.outputFile, gate = deferred(), root = f.backend.root()
  f.storage.outputFile = async (...args) => { const file = await read(...args); await gate.promise; return file }
  const pending = f.backend.openDeliveryPreview(job.id, root)
  await Promise.resolve(); await f.backend.request('/api/new', { name: 'Other' }); gate.resolve()
  await assert.rejects(pending, /project changed/); assert.equal(f.urls.size, 0)
})
test('audio-only completed output gets native audio controls rather than a video-only preview', async () => {
  const f = await started(), job = await delivered(f)
  f.backend.record.deliveries[0].preset = 'audio-wav'
  assert.equal((await f.backend.openDeliveryPreview(job.id, f.backend.root())).audioOnly, true)
})
test('closing a deferred preview releases its later receipt and never reopens the dialog', async () => {
  const gate = deferred(), released = [], states = []
  const controller = createDeliveryPreview({ open: () => gate.promise, release: id => released.push(id), getRoot: () => 'browser:one', changed: state => states.push(state.phase) })
  const pending = controller.show('output', 'browser:one'); controller.close()
  gate.resolve({ previewID: 'late', root: 'browser:one' })
  assert.equal(await pending, false); assert.deepEqual(released, ['late']); assert.equal(controller.snapshot().phase, 'idle')
  assert.deepEqual(states, ['loading', 'idle'])
})
test('replacement preview and disposal release only their owned receipts, including late superseded reads', async () => {
  const late = deferred(), released = []
  const controller = createDeliveryPreview({ open: id => id === 'second' ? late.promise : Promise.resolve({ previewID: id, root: 'browser:one' }), release: id => released.push(id), getRoot: () => 'browser:one', changed: () => {} })
  await controller.show('first', 'browser:one'); const pending = controller.show('second', 'browser:one')
  await controller.show('third', 'browser:one'); late.resolve({ previewID: 'second', root: 'browser:one' }); assert.equal(await pending, false)
  assert.equal(controller.snapshot().receipt.previewID, 'third'); controller.dispose()
  assert.deepEqual(released, ['first', 'second', 'third']); assert.equal(controller.snapshot().phase, 'idle')
})
test('preview controller rejects changed project and displays actual read failures', async () => {
  let root = 'browser:one'; const gate = deferred(), released = []
  const controller = createDeliveryPreview({ open: () => gate.promise, release: id => released.push(id), getRoot: () => root, changed: () => {} })
  const pending = controller.show('output', root); root = 'browser:two'; gate.resolve({ previewID: 'old', root: 'browser:one' })
  assert.equal(await pending, false); assert.deepEqual(released, ['old'])
  const failure = createDeliveryPreview({ open: async () => { throw new Error('saved output missing') }, release: () => {}, getRoot: () => root, changed: () => {} })
  assert.equal(await failure.show('output', root), false); assert.equal(failure.snapshot().phase, 'error'); assert.equal(failure.snapshot().error, 'saved output missing')
})
test('backup size labels remain useful for small files without claiming zero MB', () => {
  assert.equal(formatFileSize(89951), '88 KB'); assert.equal(formatFileSize(358957), '351 KB')
  assert.equal(formatFileSize(3), '3 bytes'); assert.equal(formatFileSize(1024), '1.0 KB'); assert.equal(formatFileSize(1024 ** 2), '1.0 MB')
  assert.equal(formatFileSize(-1), 'Size unavailable')
})
test('actual preview component renders accessible playback controls and exact saved-file details', async () => {
  const source = await readFile(new URL('../web/ui/delivery-preview.js', import.meta.url), 'utf8')
  const htmSource = await readFile(new URL('../node_modules/htm/dist/htm.module.js', import.meta.url), 'utf8')
  const { default: htm } = await import(`data:text/javascript;base64,${Buffer.from(htmSource).toString('base64')}`)
  const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }), html = htm.bind(h)
  const setters = [], effects = [], useState = initial => [initial, value => setters.push(value)]
  const component = new Function('html', 'h', 'useRef', 'useState', 'useEffect', 'formatFileSize', `${source.slice(source.indexOf('export function DeliveryPreview')).replace('export function', 'function')};return DeliveryPreview`)(html, h, () => ({ current: null }), useState, effect => effects.push(effect), formatFileSize)
  const receipt = { previewID: 'one', url: 'blob:actual-file', name: 'Final.mp4', bytes: 358957, preset: 'h264-high', completed: 1700000000000 }
  for (const audioOnly of [false, true]) {
    let closed = 0; const rendered = component({ state: { phase: 'ready', receipt: { ...receipt, audioOnly } }, close: () => closed++ }), nodes = []
    const visit = node => { if (node && typeof node === 'object') { nodes.push(node); node.children?.forEach(visit) } }; visit(rendered)
    const section = nodes.find(node => node.type === 'section'), header = section.children.find(node => node?.type === 'header')
    const body = section.children.find(node => node?.props?.class === 'browser-export-preview-body')
    assert.ok(header && body); assert.notEqual(header, body)
    assert.ok(header.children.some(node => node?.type === 'button'))
    assert.equal(body.children.some(node => node?.type === 'header'), false)
    const player = nodes.find(node => node.type === (audioOnly ? 'audio' : 'video'))
    assert.ok(body.children.includes(player)); assert.ok(player.props.controls); assert.ok(player.props.playsInline); assert.equal(player.props.src, receipt.url); assert.equal(player.props['aria-label'], 'Saved export Final.mp4')
    player.props.onLoadedMetadata({ currentTarget: { duration: 4.075, videoWidth: 640, videoHeight: 360 } })
    assert.deepEqual(setters.at(-1), { duration: 4.075, width: 640, height: 360 })
    const text = nodes.map(node => node.children.filter(child => typeof child === 'string').join('')).join(' '); assert.ok(text.includes(`${receipt.bytes.toLocaleString()} bytes`)); assert.match(text, /does not confirm that a separate download/)
    nodes.find(node => node.type === 'button').props.onClick(); assert.equal(closed, 1)
    nodes.find(node => node.type === 'section').props.onKeyDown({ key: 'Escape', stopPropagation() {}, preventDefault() {} }); assert.equal(closed, 2)
  }
})
test('actual timeline label expression preserves clean asset names and custom labels without changing source identity', async () => {
  const source = await readFile(new URL('../web/ui/timeline.js', import.meta.url), 'utf8')
  const line = source.split('\n').find(line => line.includes('const label = c.kind ==='))
  const label = new Function('c', 'p', 'mediaDisplayName', `const titleText = String(c.title?.text ?? "").replace(/\\s+/g, " ");${line};return label`)
  const path = 'media/UUID-synthetic-picture-and-tone.mp4', p = { assets: { [path]: { name: 'synthetic-picture-and-tone.mp4' } } }
  const clip = { kind: 'video', src: path }
  assert.equal(label(clip, p, mediaDisplayName), 'synthetic-picture-and-tone.mp4'); assert.equal(clip.src, path)
  assert.equal(label({ ...clip, label: 'Opening shot' }, p, mediaDisplayName), 'Opening shot')
  assert.equal(label({ kind: 'title', title: { text: 'Film title' } }, p, mediaDisplayName), 'T  Film title')
  assert.equal(mediaDisplayName(path, p.assets[path]), 'synthetic-picture-and-tone.mp4')
})

test('actual revealMedia opens Titles in compact Viewer or Inspector mode and a collapsed desktop Media layout', async () => {
  const source = await readFile(new URL('../web/ui/layout.js', import.meta.url), 'utf8')
  const prefix = source.slice(source.indexOf("const key ="), source.indexOf('export function layoutStyle')).replaceAll('export function', 'function')
  for (const initialPanel of ['viewer', 'inspector', 'media']) {
    const values = new Map([['reel.workspace.v1', JSON.stringify({ showMedia: false, showInspector: false, media: 333, inspector: 444 })]])
    const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }
    const actual = new Function('localStorage', `${prefix};return {revealMedia, chooseCompactEditPanel, read:()=>({layout, compactEditPanel})}`)(storage)
    actual.chooseCompactEditPanel(initialPanel); actual.revealMedia()
    const state = actual.read(); assert.equal(state.compactEditPanel, 'media'); assert.equal(state.layout.showMedia, true)
    assert.equal(state.layout.showInspector, false); assert.equal(state.layout.media, 333); assert.equal(state.layout.inspector, 444)
    assert.equal(JSON.parse(values.get('reel.workspace.v2')).showMedia, true)
  }
})

test('empty unregistered copies survive a complete backup and separate restore', async () => {
  const f = await started()
  const empty = await f.backend.upload(new File([], 'empty.mp4'))
  f.media.fail = 'empty media'
  await f.backend.request('/api/import', { paths: [empty.path] })
  assert.equal(f.backend.importState.failures.length, 1); assert.equal(Object.keys(f.backend.record.project.assets).length, 0)
  f.media.fail = null
  const backup = await writeBackup(f.backend, new AbortController().signal)
  const read = await readBackup(backup.file)
  assert.equal(read.files.length, 1); assert.equal(read.files[0].file.size, 0)
  await restoreBackup(f.backend, backup.file, new AbortController().signal)
  assert.equal(f.backend.file(empty.path).size, 0); assert.equal(Object.keys(f.backend.record.project.assets).length, 0)
})
test('backup refuses excess retained files and unsupported project fields before allocating output', async () => {
  const f = await started()
  for (let i = 0; i < 1001; i++) f.backend.files.set(`media/${i}`, { name: String(i), file: new File([], String(i)) })
  await assert.rejects(writeBackup(f.backend, new AbortController().signal), /1000/)
  assert.equal(f.outputs.size, 0)
  f.backend.files.clear(); f.backend.record.project.futureUnsupportedField = true
  await assert.rejects(writeBackup(f.backend, new AbortController().signal), /unsupported/)
  assert.equal(f.outputs.size, 0)
})
test('actual export storage recovery skips active leases and committed deliveries, and never touches legacy media', async () => {
  const held = new Set(), files = new Map(), legacy = new Map(), removed = []
  const locks = { async request(name, options, callback) {
    if (typeof options === 'function') { callback = options; options = {} }
    if (held.has(name)) { if (options.ifAvailable) return callback(null); throw Error('unexpected contention') }
    held.add(name); try { return await callback({ name }) } finally { held.delete(name) }
  } }
  const directory = { async getFileHandle(key, options) {
    if (!files.has(key)) { if (!options?.create) throw Object.assign(Error('missing'), { name: 'NotFoundError' }); files.set(key, new File([], key)) }
    return { kind: 'file', getFile: async () => files.get(key), createWritable: async () => {
      let bytes = new Uint8Array()
      return { write: async ({ data }) => { bytes = data }, close: async () => files.set(key, new File([bytes], key)), abort: async () => {} }
    } }
  }, async *entries() { for (const key of files.keys()) yield [key, await this.getFileHandle(key)] }, async removeEntry(key) { removed.push(key); files.delete(key) } }
  const folder = { kind: 'directory', getDirectoryHandle: async name => { assert.equal(name, 'exports-v2'); return directory }, getFileHandle: async key => ({ getFile: async () => legacy.get(key) }) }
  const storage = new BrowserStorage(), record = { deliveries: [] }
  storage.folder = async () => folder; storage.project = async () => record
  storage.directory = { async *entries() { yield ['qa', folder] } }
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } })
  const key = 'export-11111111-1111-4111-8111-111111111111', abandoned = 'export-22222222-2222-4222-8222-222222222222'
  try {
    const writer = await storage.writer('qa', key)
    await writer.write(new Uint8Array([1, 2, 3]), 0); await writer.close()
    files.set(abandoned, new File(['interrupted'], abandoned)); legacy.set('original', new File(['source'], 'original'))
    await storage.recoverExports(); assert.equal(files.has(abandoned), false); assert.equal(files.has(key), true)
    record.deliveries.push({ key }); await writer.release(); await storage.recoverExports()
    assert.equal((await storage.outputFile('qa', key)).size, 3); assert.equal(legacy.size, 1)
    const failed = await storage.writer('qa', abandoned); await failed.close(); await failed.dispose()
    assert.equal(files.has(abandoned), false); assert.equal(files.has(key), true); assert.equal(held.size, 0)
    // Even an error after the durable admission must preserve its saved output.
    const admitted = await storage.writer('qa', abandoned); await admitted.write(new Uint8Array([9]), 0); await admitted.close()
    record.deliveries.push({ key: abandoned }); await admitted.dispose(); assert.equal(files.has(abandoned), true)
    assert.equal(legacy.size, 1); assert.equal(held.size, 0)
  } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator }
})

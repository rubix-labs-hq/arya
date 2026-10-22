const copy = value => structuredClone(value)
const unsupported = 'This feature needs the Arya Mac app or the local editor. Hosted browser projects stay on your device; no agent or cloud service is connected.'
const safeName = value => String(value ?? 'Untitled').replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 180) || 'Untitled'
const active = job => ['queued', 'running', 'cancelling', 'committing'].includes(job.state)

/** Browser-local API. Storage and media adapters are injected for actual browser and admission tests. */
export class BrowserBackend {
  constructor({ storage, media, core, validateExportSpec, uuid = () => crypto.randomUUID(), urls = URL }) {
    Object.assign(this, { storage, media, core, validateExportSpec, uuid, urls })
    this.listeners = new Set(); this.files = new Map(); this.resources = new Map(); this.urlFiles = new Map()
    this.temporaryConsumers = new Map(); this.jobs = new Map(); this.serial = Promise.resolve(); this.generation = 0; this.record = null
    this.importController = null; this.importState = { state: 'idle' }
  }
  async initialize() {
    this.codecCaps = await this.media.capabilities()
    const id = await this.storage.current()
    if (id) { try { await this.openProject(id) } catch (error) { this.startupError = error.message } }
    return this
  }
  context() { return { id: this.record?.id, generation: this.generation } }
  assert(context) {
    if (context.id !== this.record?.id || context.generation !== this.generation) throw new Error('The project changed. Retry in the current project.')
  }
  events(handlers) {
    this.listeners.add(handlers)
    queueMicrotask(() => { if (this.listeners.has(handlers)) handlers.hello?.({ role: 'ui', host: 'browser-local' }) })
    return () => this.listeners.delete(handlers)
  }
  emit(name, value) { for (const handlers of this.listeners) handlers[name]?.(copy(value)) }
  queue(operation) { const result = this.serial.then(operation); this.serial = result.catch(() => {}); return result }
  root() { return this.record ? `browser:${this.record.id}` : 'browser:no-project' }
  snapshot() { return { project: copy(this.record?.project ?? null), version: this.record?.version ?? 0, root: this.root(), chat: [], activity: [], jobs: [...this.jobs.values()].map(job => this.publicJob(job)), claude: { state: 'unavailable', reason: unsupported } } }
  async refreshSnapshot(context) {
    this.assert(context)
    if (!this.record) return this.snapshot()
    const record = await this.storage.project(this.record.id)
    this.assert(context)
    if (!record) throw new Error('This saved project was removed from browser storage. Preserve its originals and backup.')
    if (record.version !== this.record.version) {
      const files = await this.hydrate(record); this.assert(context)
      this.files = files; this.record = copy(record); this.registerURLs(); this.emit('project', this.snapshot())
    }
    return this.snapshot()
  }
  async hydrate(record) {
    const files = await this.storage.files(record.id), loaded = new Map()
    for (const file of files) loaded.set(file.path, { ...file, file: await this.storage.read(file) })
    for (const path of Object.keys(record.project.assets)) if (!loaded.has(path)) throw new Error(`Saved media is missing: ${path}. Keep the project backup and reimport the original.`)
    return loaded
  }
  revokeResources() {
    for (const resource of this.resources.values()) this.urls.revokeObjectURL(resource.url)
    this.resources.clear(); this.urlFiles.clear()
  }
  resetImportResult() { this.importState = { state: 'idle' }; this.emit('import', this.importState) }
  async openProject(id) {
    if ([...this.jobs.values()].some(active) || this.importController) throw new Error('Cancel or finish the current import or export before opening another project.')
    const record = await this.storage.project(id)
    if (!record) throw new Error('This saved project is no longer available in this browser.')
    const files = await this.hydrate(record)
    await this.storage.select(id)
    this.revokeResources(); this.record = copy(record); this.files = files; this.generation++
    this.jobs.clear(); this.resetImportResult(); this.registerURLs(); this.emit('project', this.snapshot()); return this.snapshot()
  }
  async newProject(options = {}) {
    if ([...this.jobs.values()].some(active) || this.importController) throw new Error('Cancel or finish the current import or export before creating another project.')
    const width = options.width ?? 1920, height = options.height ?? 1080, fps = options.fps ?? 30
    if (![width, height].every(v => Number.isSafeInteger(v) && v >= 2 && v <= 8192) || !Number.isFinite(fps) || fps <= 0 || fps > 120) throw new Error('Choose project dimensions up to 8192 pixels and a frame rate up to 120 fps.')
    const project = this.core.migrate(this.core.newProject(safeName(options.name), { width, height, fps }))
    const record = { id: this.uuid(), version: 1, project, updated: Date.now(), past: [], future: [], deliveries: [] }
    await this.storage.commit(record, null); await this.storage.select(record.id)
    this.revokeResources(); this.files.clear(); this.record = record; this.generation++; this.jobs.clear(); this.resetImportResult()
    this.emit('project', this.snapshot()); return this.snapshot()
  }
  registerURLs() {
    for (const [path, record] of this.files) {
      const key = `media:${path}`
      if (!this.resources.has(key)) {
        const url = this.urls.createObjectURL(record.file)
        this.resources.set(key, { url }); this.urlFiles.set(url, record.file)
      }
    }
  }
  url(path) {
    const url = new URL(path, 'https://arya.invalid')
    if (url.pathname === '/media') {
      const revision = url.searchParams.get('sourceRevision')
      if (revision && ![...this.jobs.values()].some(job => job.sourceCohortID === revision && active(job) && job.sourceCohort.some(source => source.path === url.searchParams.get('path')))) throw new Error('The export source receipt is unavailable.')
      const src = url.searchParams.get('path'), resource = this.resources.get(`media:${src}`)
      if (!resource) throw new Error('This project media is unavailable. Reopen the saved project.')
      return resource.url
    }
    return path
  }
  fileForURL(url) { return this.urlFiles.get(url) ?? null }
  file(path) {
    const record = this.files.get(path)
    if (!record) throw new Error('Choose a file copied into the current project.')
    return record.file
  }
  async resource(path, options) {
    options?.signal?.throwIfAborted()
    const url = new URL(path, 'https://arya.invalid')
    if (url.pathname !== '/media') throw new Error('The hosted editor only reads its own project media.')
    return new Response(this.file(url.searchParams.get('path')))
  }
  async commit(project, context, { history = true, created = [] } = {}) {
    this.assert(context)
    const previous = this.record, record = { ...copy(previous), project: copy(project), version: previous.version + 1, updated: Date.now() }
    if (history) { record.past = [...record.past, previous.project].slice(-50); record.future = [] }
    await this.storage.commit(record, previous.version)
    this.assert(context); this.record = record
    const receipt = { ...this.snapshot(), created }; this.emit('project', receipt); return receipt
  }
  async upload(file) {
    const context = this.context()
    return this.queue(async () => {
      this.assert(context)
      if (!this.record) await this.newProject({ name: 'Untitled' })
      const owned = this.context(), controller = this.importController = new AbortController()
      this.importState = { state: 'copying', name: file.name, progress: 0 }; this.emit('import', this.importState)
      try {
        const record = await this.storage.copy(this.record.id, file, { signal: controller.signal, current: () => owned.id === this.record?.id && owned.generation === this.generation,
          progress: (bytes, total) => { this.importState = { state: 'copying', name: file.name, progress: total ? bytes / total : 0 }; this.emit('import', this.importState) } })
        this.assert(owned)
        this.files.set(record.path, { ...record, file: await this.storage.read(record) }); this.registerURLs(); controller.signal.throwIfAborted()
        this.importState = { state: 'copied', name: file.name, path: record.path, progress: 1 }; this.emit('import', this.importState)
        return { path: record.path }
      } catch (error) { this.importState = { state: controller.signal.aborted ? 'cancelled' : 'failed', error: error.message }; this.emit('import', this.importState); throw error }
      finally { if (this.importController === controller) this.importController = null }
    })
  }
  async importPaths(paths, context) {
    this.assert(context)
    if (!this.record) throw new Error('Create a project before importing media.')
    if (!Array.isArray(paths) || paths.length > 1000) throw new Error('Choose at most 1000 media files at a time.')
    const controller = this.importController = new AbortController(), assets = {}, failures = [], requestID = this.uuid()
    this.importState = { state: 'registering', progress: 0 }; this.emit('import', this.importState)
    try {
      for (const [index, path] of [...new Set(paths)].entries()) {
        this.assert(context); controller.signal.throwIfAborted()
        if (this.record.project.assets[path]) { assets[path] = this.record.project.assets[path]; continue }
        try {
          const item = this.files.get(path)
          if (!item) throw new Error('This file was not copied into the current project.')
          const metadata = await this.media.probe(item.file)
          this.assert(context); controller.signal.throwIfAborted()
          assets[path] = { ...metadata, name: item.name, originalPath: item.originalPath, size: item.size }
        } catch (error) {
          if (controller.signal.aborted) throw error
          failures.push({ stage: 'identity', name: this.files.get(path)?.name ?? path, error: error.message })
        }
        this.importState = { state: 'registering', progress: (index + 1) / paths.length }; this.emit('import', this.importState)
      }
      this.assert(context); controller.signal.throwIfAborted()
      if (Object.keys(assets).length) {
        const result = this.core.applyOps(this.record.project, [{ op: 'import', assets }])
        this.importState = { state: 'committing', progress: 1 }; this.emit('import', this.importState)
        await this.commit(result.project, context)
      }
      this.importState = { state: failures.length ? 'partial' : Object.keys(assets).length ? 'done' : 'failed', count: Object.keys(assets).length, failures, requestID, projectID: context.id, generation: context.generation, version: this.record.version,
        registered: Object.entries(assets).map(([path, asset]) => ({ path, assetJSON: JSON.stringify(asset) })) }
      this.emit('import', this.importState)
      return { assets, failures, version: this.record.version, project: copy(this.record.project) }
    } catch (error) { this.importState = { state: controller.signal.aborted ? 'cancelled' : 'failed', error: error.message }; this.emit('import', this.importState); throw error }
    finally { if (this.importController === controller) this.importController = null }
  }
  async audioBuffer(src, from, duration, context, signal, sourceRevision) {
    if (sourceRevision && ![...this.jobs.values()].some(job => job.sourceCohortID === sourceRevision && active(job))) throw new Error('The export source receipt is no longer active.')
    return this.media.audioBuffer(this.file(src), from, duration, context, signal)
  }
  async prepareSourceAudio(src, from, duration, signal) {
    const context = this.context(), key = `audio:${src}:${from}:${duration}`
    if (this.resources.has(key)) return this.resources.get(key).url
    const audio = new AudioContext()
    try {
      const buffer = await this.media.audioBuffer(this.file(src), from, duration, audio, signal)
      signal?.throwIfAborted(); this.assert(context)
      const url = this.urls.createObjectURL(this.media.wav(buffer))
      this.resources.set(key, { url }); return url
    } finally { await audio.close() }
  }
  assistantStatus() {
    return { provider: 'claude-code', configured: false, mode: 'manual', reason: unsupported, loading: false, providers: ['claude-code', 'codex', 'antigravity', 'gemini-cli', 'custom'].map(id => ({ id, installed: false, authenticated: false, available: false, reason: unsupported })), catalogs: [], usage: null }
  }
  caps() {
    const codec = this.codecCaps ?? {}, presets = ['audio-wav', ...(codec.aac ? ['audio-m4a'] : []), ...(codec.h264 ? ['h264-high', 'h264-web'] : []), ...(codec.hevc ? ['hevc'] : [])]
    return { host: 'browser-local', presets, chrome: false, whisper: false, export: { renderer: 'webcodecs', presets, still: false }, analysis: { transcript: false, scenes: false, silence: false, beats: false, loudness: false, opticalFlow: false }, processing: { audioClean: false, multicamSync: false, deshake: false }, transcription: { available: false, reason: unsupported }, shorts: { available: false, reason: unsupported }, figma: { available: false, reason: unsupported }, assistant: { available: false, reason: unsupported }, music: { available: false, reason: unsupported }, interchange: { available: false, reason: unsupported }, color: { gpu: codec.gpu }, video: { videoDenoise: false, reason: unsupported } }
  }
  publicJob(job) { const { writer, writes, acceptedProject, ...publicValue } = job; return copy(publicValue) }
  job(id) { const job = this.jobs.get(id); if (!job || job.projectID !== this.record?.id) throw new Error('This export belongs to another project.'); return job }
  async export(spec) {
    if (!this.record || spec.expectedProject !== JSON.stringify(this.record.project)) throw new Error('The project changed before export. Retry from its current timeline.')
    if ([...this.jobs.values()].some(active)) throw new Error('Finish or cancel the current export before rendering another.')
    if (!this.caps().presets.includes(spec.preset)) throw new Error('This browser cannot encode that preset. Choose an available preset.')
    const context = this.context(), original = copy(this.record.project), project = spec.comp ? this.core.compView(original, spec.comp) : original
    const validated = this.validateExportSpec(spec, { ...project, duration: this.core.duration(project) })
    if (validated.range.out > this.core.duration(project) + 1e-6 || validated.range.out - validated.range.in > 300) throw new Error('Export a valid timeline range of at most five minutes in the hosted browser.')
    delete validated.expectedProject
    const id = this.uuid(), extension = spec.preset === 'audio-wav' ? 'wav' : spec.preset === 'audio-m4a' ? 'm4a' : 'mp4'
    const output = `renders/${safeName(spec.name || project.name)}-${id.slice(0, 8)}.${extension}`
    const sourceCohort = Object.entries(original.assets).map(([path]) => {
      const item = this.files.get(path)
      if (!item) throw new Error(`Export source is missing: ${path}`)
      return { path, size: item.size, modified: item.modified }
    })
    const writer = await this.storage.writer(this.record.id, `export-${id}`)
    try { this.assert(context) } catch (error) { await writer.dispose(); throw error }
    const job = { id, kind: 'export', state: 'running', projectID: this.record.id, sourceCohortID: id, sourceCohort, acceptedProject: copy(project),
      spec: validated, output, created: Date.now(), progress: 0, writer, writes: Promise.resolve(), bytes: 0 }
    this.jobs.set(id, job); this.emit('job', this.publicJob(job))
    return { ...this.publicJob(job), acceptedProject: copy(project) }
  }
  async save(bytes, target) {
    if (!(bytes instanceof Uint8Array) || !target.job) throw new Error('Choose an active export job before saving bytes.')
    const job = this.job(target.job)
    if (job.cancelled) return { cancelled: true }
    if (job.state !== 'running' || !Number.isSafeInteger(target.position) || target.position < 0) throw new Error('This export write is no longer active.')
    const data = bytes.slice(), write = job.writes.then(async () => {
      if (job.cancelled) return { cancelled: true }
      await job.writer.write(data, target.position); job.bytes = Math.max(job.bytes, target.position + data.byteLength)
      return { written: data.byteLength }
    })
    job.writes = write; return write
  }
  async finish(body) {
    const job = this.job(body.id)
    if (!active(job)) return this.publicJob(job)
    if (body.drained !== true) throw new Error('The renderer must drain pending source and write work before finishing.')
    await job.writes.catch(error => { body.error ??= error.message })
    try {
      if (body.error || job.cancelled) {
        await job.writer.abort(); job.state = job.cancelled ? 'cancelled' : 'failed'; job.error = body.error ?? 'Cancelled'
      } else {
        await job.writer.close()
        const file = await job.writer.file()
        if (job.cancelled) { await job.writer.abort().catch(() => {}); job.state = 'cancelled'; job.error = 'Cancelled'; return this.publicJob(job) }
        if (!file.size || file.size !== job.bytes) throw new Error('The completed export file does not match its writes.')
        const previous = this.record, row = { id: job.id, output: job.output, key: `export-${job.id}`, size: file.size, preset: job.spec.preset, provenance: 'completed', available: true, completed: Date.now() }
        const record = { ...copy(previous), deliveries: [...previous.deliveries, row], version: previous.version + 1, updated: Date.now() }
        // Admission is synchronous. Cancellation is no longer accepted once this commit starts.
        job.state = 'committing'; this.emit('job', this.publicJob(job))
        await this.storage.commit(record, previous.version); this.record = record
        job.state = 'done'; job.progress = 1; this.emit('project', this.snapshot())
      }
    } catch (error) { job.state = 'failed'; job.error = error.message; throw error }
    finally {
      try { if (job.state === 'done') await job.writer.release(); else await job.writer.dispose() }
      finally { job.finished = Date.now(); this.emit('job', this.publicJob(job)); delete job.writer }
    }
    return this.publicJob(job)
  }
  async openDeliveryPreview(id, root) {
    const context = this.context()
    if (root !== this.root()) throw new Error('The project changed. Refresh its saved exports.')
    const row = this.record?.deliveries.find(row => row.id === id)
    if (!row || row.provenance !== 'completed') throw new Error('Choose a completed saved export.')
    const file = await this.storage.outputFile(context.id, row.key)
    this.assert(context)
    if (!file.size || file.size !== row.size) throw new Error('This saved output changed or is missing.')
    const previewID = this.uuid(), url = this.urls.createObjectURL(file)
    this.resources.set(`delivery:${previewID}`, { url }); this.urlFiles.set(url, file)
    return { previewID, root, id, url, name: row.output.split('/').pop(), bytes: file.size, preset: row.preset,
      completed: row.completed, audioOnly: row.preset.startsWith('audio') }
  }
  releaseDeliveryPreview(previewID) {
    const key = `delivery:${previewID}`, resource = this.resources.get(key)
    if (!resource) return
    this.resources.delete(key); this.urlFiles.delete(resource.url); this.urls.revokeObjectURL(resource.url)
  }
  async downloadDelivery(id, root) {
    if (root !== this.root()) throw new Error('The project changed. Refresh its saved exports.')
    const record = this.record.deliveries.find(row => row.id === id)
    if (!record) throw new Error('This completed export is unavailable.')
    const file = await this.storage.outputFile(this.record.id, record.key)
    if (file.size !== record.size || !file.size) throw new Error('This saved export changed or is missing.')
    this.download(file, record.output.split('/').pop()); return { offered: true }
  }
  download(file, name, release, identity) {
    const url = this.urls.createObjectURL(file), element = document.createElement('a')
    try { element.href = url; element.download = name; document.body.appendChild(element); element.click() }
    catch (error) { this.urls.revokeObjectURL(url); if (release) Promise.resolve(release()).catch(() => {}); throw error }
    finally { element.remove() }
    if (release && identity) this.temporaryConsumers.set(`${identity.projectID}:${identity.key}`, { url, release })
    else setTimeout(() => this.urls.revokeObjectURL(url), 60_000)
  }
  async releaseTemporaryBackup(projectID, key, savedAcknowledgment) {
    const consumer = this.temporaryConsumers.get(`${projectID}:${key}`)
    if (consumer) {
      if (savedAcknowledgment !== true) throw new Error('Confirm that the backup download has finished saving before releasing it.')
      this.urls.revokeObjectURL(consumer.url)
      await consumer.release(); this.temporaryConsumers.delete(`${projectID}:${key}`)
    } else await this.storage.clearTemporaryBackup(projectID, key)
    return { released: true }
  }
  async request(path, body) {
    const url = new URL(path, 'https://arya.invalid'), route = url.pathname
    if (route === '/api/project') { const context = this.context(); return this.queue(() => this.refreshSnapshot(context)) }
    if (route === '/api/caps') return this.caps()
    if (route === '/api/assistant/status') return this.assistantStatus()
    if (route === '/api/luts') return { luts: [] }
    if (route === '/api/ui-state') { this.uiState = copy(body ?? {}); return { accepted: true, host: 'browser-local' } }
    if (route === '/api/video/caps') return this.caps().video
    if (route === '/api/browser/projects') return { projects: (await this.storage.list()).map(({ id, project, updated }) => ({ id, name: project.name, updated })) }
    if (route === '/api/browser/storage') return this.storage.status()
    if (route === '/api/browser/persist') return this.storage.requestPersistence()
    if (route === '/api/browser/import/cancel') { if (this.importState.state === 'committing') return { cancelled: false, reason: 'Imported media is being saved. Cancellation is no longer available.' }; this.importController?.abort(new Error('Import cancelled. Completed copies remain available to retry.')); return { cancelled: !!this.importController } }
    if (route === '/api/browser/copies') return { paths: [...this.files.keys()].filter(path => !this.record?.project.assets[path]) }
    if (route === '/api/export/progress') {
      const job = this.job(body?.id)
      if (Number.isFinite(body.progress)) job.progress = Math.max(job.progress, Math.min(1, Math.max(0, body.progress)))
      this.emit('job', this.publicJob(job)); return { state: job.state, queued: job.state === 'queued', cancelled: !!job.cancelled }
    }
    if (route === '/api/jobs/cancel') { const job = this.job(body?.id); if (job.state === 'committing') return { cancelled: false, reason: 'The completed file is being saved. Cancellation is no longer available.' }; if (active(job)) { job.cancelled = true; job.state = 'cancelling'; this.emit('job', this.publicJob(job)) } return { cancelled: !!job.cancelled } }
    if (route === '/api/export/finish') return this.queue(() => this.finish({ ...body }))
    if (route === '/api/deliveries') {
      const context = this.context(), rows = []
      for (const row of this.record?.deliveries ?? []) {
        try { const file = await this.storage.outputFile(this.record.id, row.key); rows.push({ ...row, available: file.size === row.size }) }
        catch { rows.push({ ...row, available: false, problem: 'The saved output is missing from this browser.' }) }
      }
      this.assert(context); return { root: this.root(), deliveries: rows, warnings: [], actions: ['preview', 'download'] }
    }
    if (route === '/api/deliveries/access' && body?.action === 'preview') return this.openDeliveryPreview(body.id, body.root)
    if (route === '/api/deliveries/access' && body?.action === 'download') return this.downloadDelivery(body.id, body.root)
    if (route === '/api/strip') {
      const context = this.context(), src = url.searchParams.get('src'), asset = this.record?.project.assets[src], key = `strip:${src}`
      if (!asset?.hasVideo) throw new Error('Choose a picture source.')
      if (!this.resources.has(key)) {
        const value = await this.media.strip(this.file(src), asset)
        this.assert(context)
        if (this.resources.has(key)) return { ...this.resources.get(key), blob: undefined }
        const image = this.urls.createObjectURL(value.blob)
        this.resources.set(key, { ...value, blob: undefined, url: image })
      }
      const { blob, ...value } = this.resources.get(key); return value
    }
    if (route === '/api/peaks') { const context = this.context(), value = await this.media.peaks(this.file(url.searchParams.get('src'))); this.assert(context); return value }
    const context = this.context()
    return this.queue(async () => {
      this.assert(context)
      if (route === '/api/new') return this.newProject(body)
      if (route === '/api/browser/open') return this.openProject(body?.id)
      if (route === '/api/import') return this.importPaths(body?.paths, context)
      if (route === '/api/export') return this.export(body)
      if (route === '/api/ops') {
        if (!this.record) throw new Error('Create a project before editing.')
        if (body?.expectedVersion !== undefined && body.expectedVersion !== this.record.version) throw new Error('The project changed. Refresh before applying this edit.')
        const ops = Array.isArray(body?.ops) ? body.ops : [body?.ops]
        if (ops.some(op => op?.op === 'import')) throw new Error('Use the media importer to register verified project files.')
        for (const op of ops) if (op?.src && !this.record.project.assets[op.src]) throw new Error('Import this media before placing it on the timeline.')
        const result = this.core.applyOps(this.record.project, ops)
        for (const path of Object.keys(result.project.assets)) if (!this.files.has(path)) throw new Error('This edit references media that is not stored in the project.')
        return this.commit(result.project, context, { created: result.created })
      }
      if (route === '/api/undo' || route === '/api/redo') {
        if (!this.record) throw new Error('Create a project first.')
        const previous = this.record, undo = route.endsWith('undo'), from = undo ? previous.past : previous.future
        if (!from.length) return this.snapshot()
        const record = { ...copy(previous), version: previous.version + 1, project: copy(from.at(-1)), past: undo ? from.slice(0, -1) : [...previous.past, previous.project], future: undo ? [...previous.future, previous.project] : from.slice(0, -1), updated: Date.now() }
        await this.storage.commit(record, previous.version); this.assert(context); this.record = record; this.emit('project', this.snapshot()); return this.snapshot()
      }
      if (route === '/api/forget') {
        const project = copy(this.record.project)
        for (const path of body?.paths ?? []) {
          if (JSON.stringify([project.tracks, project.comps, project.library]).includes(JSON.stringify(path))) throw new Error('This media is still used by the timeline or library. Remove its uses first.')
          delete project.assets[path]
        }
        return this.commit(project, context)
      }
      throw new Error(unsupported)
    })
  }
}

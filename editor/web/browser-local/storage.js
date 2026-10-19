const DB = 'arya-browser-projects-v1'
const exportKey = key => /^export-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)
const clone = value => structuredClone(value)
function result(request) { return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error) }) }
function complete(tx) { return new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Browser storage transaction was interrupted.')) }) }

/** Project acknowledgments follow a committed IndexedDB transaction. Media lives in OPFS. */
export class BrowserStorage {
  async open() {
    if (!globalThis.isSecureContext || !navigator.storage?.getDirectory || !globalThis.indexedDB) throw new Error('This browser cannot store Arya projects. Use a current Safari, Chrome or Edge browser over HTTPS.')
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('projects', { keyPath: 'id' })
      request.result.createObjectStore('files', { keyPath: 'id' })
      request.result.createObjectStore('preferences')
    }
    this.db = await result(request)
    this.db.onversionchange = () => { this.db.close(); this.closed = true }
    this.directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('arya-v1', { create: true })
    await this.recoverExports()
    return this
  }
  transaction(stores, mode = 'readonly') {
    if (this.closed) throw new Error('Browser storage changed in another tab. Reload Arya before editing.')
    return this.db.transaction(stores, mode)
  }
  async project(id) { return result(this.transaction(['projects']).objectStore('projects').get(id)) }
  async list() { return result(this.transaction(['projects']).objectStore('projects').getAll()) }
  async current() { return result(this.transaction(['preferences']).objectStore('preferences').get('current')) }
  async select(id) {
    const tx = this.transaction(['preferences'], 'readwrite'), done = complete(tx)
    tx.objectStore('preferences').put(id, 'current'); await done
  }
  async commit(record, expected) {
    const tx = this.transaction(['projects', 'preferences'], 'readwrite'), done = complete(tx)
    const store = tx.objectStore('projects'), request = store.get(record.id)
    let conflict
    request.onsuccess = () => {
      const existing = request.result, fence = tx.objectStore('preferences').get(`restore-cleanup:${record.id}`)
      fence.onsuccess = () => {
      if (fence.result) { conflict = new Error('This interrupted restoration is being released. Its project cannot be published.'); tx.abort() }
      else if (expected === null ? !!existing : !existing || existing.version !== expected) {
        conflict = new Error('This project changed in another tab. Reopen the saved project before editing.'); tx.abort()
      } else store.put(clone(record))
      }
    }
    try { await done } catch (error) { throw conflict ?? error }
  }
  async folder(id) { return this.directory.getDirectoryHandle(id, { create: true }) }
  async files(id) { return (await result(this.transaction(['files']).objectStore('files').getAll())).filter(file => file.project === id) }
  async read(record) {
    const handle = await (await this.folder(record.project)).getFileHandle(record.key)
    const file = await handle.getFile()
    if (file.size !== record.size || file.lastModified !== record.modified) throw new Error(`Stored media changed: ${record.name}. Reimport the original.`)
    return new File([file], record.name, { type: record.type, lastModified: file.lastModified })
  }
  async copy(project, file, { signal, progress = () => {}, current = () => true, path, staging = false } = {}) {
    const key = crypto.randomUUID(), name = file.name.normalize('NFC').replace(/[\u0000-\u001f/\\]/g, '_').slice(0, 180) || 'media'
    const directory = await this.folder(project), handle = await directory.getFileHandle(key, { create: true })
    const writer = await handle.createWritable(), reader = file.stream().getReader()
    let length = 0
    try {
      for (;;) {
        signal?.throwIfAborted()
        if (!current()) throw new Error('The project changed during import. No media was registered.')
        const { value, done } = await reader.read(); if (done) break
        await writer.write(value); length += value.byteLength; progress(length, file.size)
      }
      signal?.throwIfAborted()
      if (!current() || length !== file.size) throw new Error('The media copy did not complete in the current project.')
      await writer.close()
      const copied = await handle.getFile()
      const record = { id: `${project}:${key}`, project, key, path: path ?? `media/${key}-${name}`, name, originalPath: file.webkitRelativePath || file.name, type: file.type, size: copied.size, modified: copied.lastModified, ...(staging ? { owner: 'backup-restore' } : {}) }
      const tx = this.transaction(['files'], 'readwrite'), committed = complete(tx)
      tx.objectStore('files').put(record); await committed
      return record
    } catch (error) {
      await writer.abort().catch(() => {})
      // Incomplete temporary copies are ours. Originals are never modified.
      await directory.removeEntry(key).catch(() => {})
      throw error
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  async writer(project, key) {
    if (!exportKey(key) || !navigator.locks) throw new Error('Safe browser export needs Web Locks and an owned export identity.')
    let release, admit
    const held = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { admit = resolve })
    const lease = navigator.locks.request(`arya:export:${project}:${key}`, async () => { admit(); await held })
    await Promise.race([ready, lease])
    const unlock = async () => { release(); await lease }
    try {
      // Only this version's leased files enter exports-v2. Historical unleased files stay untouched.
      const directory = await (await this.folder(project)).getDirectoryHandle('exports-v2', { create: true })
      const handle = await directory.getFileHandle(key, { create: true }), stream = await handle.createWritable()
      const dispose = async () => {
        try {
          await stream.abort().catch(() => {})
          if (!(await this.project(project))?.deliveries?.some(row => row.key === key)) {
            try { await directory.removeEntry(key) } catch (error) { if (error.name !== 'NotFoundError') throw error }
          }
        } finally { await unlock() }
      }
      return { write: (bytes, position) => stream.write({ type: 'write', position, data: bytes }), close: () => stream.close(), abort: () => stream.abort(), file: () => handle.getFile(), dispose, release: unlock }
    } catch (error) { await unlock(); throw error }
  }
  async recoverExports() {
    if (!navigator.locks) return
    for await (const [project, folder] of this.directory.entries()) {
      if (folder.kind !== 'directory' || !/^[A-Za-z0-9-]{1,128}$/.test(project)) continue
      let directory
      try { directory = await folder.getDirectoryHandle('exports-v2') } catch (error) { if (error.name === 'NotFoundError') continue; throw error }
      for await (const [key, handle] of directory.entries()) {
        if (handle.kind !== 'file' || !exportKey(key)) continue
        await navigator.locks.request(`arya:export:${project}:${key}`, { ifAvailable: true }, async lock => {
          if (!lock || (await this.project(project))?.deliveries?.some(row => row.key === key)) return
          try { await directory.removeEntry(key) } catch (error) { if (error.name !== 'NotFoundError') throw error }
        })
      }
    }
  }
  async holdRestore(project) {
    if (!navigator.locks) throw new Error('This browser cannot safely restore backups. Use a current browser with Web Locks.')
    let release, admit
    const held = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { admit = resolve })
    const lease = navigator.locks.request(`arya:staged-restore:${project}`, async () => { admit(); await held })
    await Promise.race([ready, lease]); return async () => { release(); await lease }
  }
  async stagedRestores() {
    const tx = this.transaction(['projects', 'files'])
    const [projects, files] = await Promise.all([result(tx.objectStore('projects').getAll()), result(tx.objectStore('files').getAll())])
    const committed = new Set(projects.map(row => row.id)), groups = new Map()
    for (const row of files) if (!committed.has(row.project) && row.owner === 'backup-restore') {
      if (!groups.has(row.project)) groups.set(row.project, { id: row.project, files: [], bytes: 0 })
      const group = groups.get(row.project); group.files.push({ id: row.id, project: row.project, key: row.key, path: row.path, size: row.size, modified: row.modified, owner: row.owner }); group.bytes += row.size
    }
    return [...groups.values()]
  }
  async clearStagedRestore(project, expected) {
    if (!navigator.locks || !Array.isArray(expected) || !expected.length || expected.length > 1000) throw new Error('Choose an interrupted backup restore from the current inventory.')
    return navigator.locks.request(`arya:staged-restore:${project}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('That backup restore is still active. Wait for it to finish or cancel it in its tab.')
      const admission = this.transaction(['projects', 'files', 'preferences'], 'readwrite'), admitted = complete(admission)
      const projectRequest = admission.objectStore('projects').get(project)
      let files, refusal
      projectRequest.onsuccess = () => {
        if (projectRequest.result) { refusal = new Error('This restoration is a saved project. Its media will be preserved.'); admission.abort(); return }
        const fileRequest = admission.objectStore('files').getAll()
        fileRequest.onsuccess = () => {
          files = fileRequest.result.filter(row => row.project === project)
          const receipt = value => JSON.stringify({ id: value.id, project: value.project, key: value.key, path: value.path, size: value.size, modified: value.modified, owner: value.owner })
          const actual = files.map(receipt).sort(), requested = expected.map(receipt).sort()
          if (JSON.stringify(actual) !== JSON.stringify(requested) || files.some(row => row.owner !== 'backup-restore' || row.id !== `${project}:${row.key}` || !/^[A-Za-z0-9-]+$/.test(row.key))) { refusal = new Error('The interrupted restore changed. Refresh its file inventory before releasing copies.'); admission.abort() }
          else admission.objectStore('preferences').put(true, `restore-cleanup:${project}`)
        }
      }
      try { await admitted } catch (error) { throw refusal ?? error }
      // The same-transaction marker prevents project publication throughout OPFS cleanup.
      const directory = await this.folder(project)
      for (const row of files) {
        if (await this.project(project)) throw new Error('This restoration is now a saved project. Its remaining media will be preserved.')
        try { await directory.removeEntry(row.key) } catch (error) { if (error.name !== 'NotFoundError') throw error }
        const tx = this.transaction(['projects', 'files'], 'readwrite'), committed = complete(tx), request = tx.objectStore('projects').get(project)
        let refusal
        request.onsuccess = () => { if (request.result) { refusal = new Error('This restoration is now a saved project.'); tx.abort() } else tx.objectStore('files').delete(row.id) }
        try { await committed } catch (error) { throw refusal ?? error }
      }
      const release = this.transaction(['preferences'], 'readwrite'), completed = complete(release)
      release.objectStore('preferences').delete(`restore-cleanup:${project}`); await completed
      return { released: files.length }
    })
  }
  async temporaryWriter(project, key) {
    if (!/^backup-[A-Za-z0-9-]+$/.test(key) || !navigator.locks) throw new Error('This browser cannot safely prepare temporary backups. Use a current browser with Web Locks.')
    const lockName = `arya:temporary-backup:${project}:${key}`
    let release, admit
    const held = new Promise(resolve => { release = resolve }), ready = new Promise(resolve => { admit = resolve })
    const lease = navigator.locks.request(lockName, async () => { admit(); await held })
    await Promise.race([ready, lease])
    try {
      const directory = await (await this.folder(project)).getDirectoryHandle('temporary-backups', { create: true })
      const handle = await directory.getFileHandle(key, { create: true }), stream = await handle.createWritable()
      let disposed = false
      const dispose = async () => {
        try { if (!disposed) { await directory.removeEntry(key); disposed = true } }
        finally { release(); await lease }
      }
      return { write: (bytes, position) => stream.write({ type: 'write', position, data: bytes }), close: () => stream.close(), abort: () => stream.abort(), file: () => handle.getFile(), dispose }
    } catch (error) { release(); await lease; throw error }
  }
  async temporaryBackups(project) {
    const folder = await this.folder(project)
    let directory
    try { directory = await folder.getDirectoryHandle('temporary-backups') } catch (error) { if (error.name === 'NotFoundError') return []; throw error }
    const rows = []
    for await (const [key, handle] of directory.entries()) if (handle.kind === 'file' && /^backup-[A-Za-z0-9-]+$/.test(key)) { const file = await handle.getFile(); rows.push({ key, size: file.size }) }
    return rows
  }
  async clearTemporaryBackup(project, key) {
    if (!/^backup-[A-Za-z0-9-]+$/.test(key) || !navigator.locks) throw new Error('Invalid temporary backup identity or unavailable browser locks.')
    await navigator.locks.request(`arya:temporary-backup:${project}:${key}`, { ifAvailable: true }, async lock => {
      if (!lock) throw new Error('This temporary backup is still being prepared or offered for download. Wait for it to finish.')
      const directory = await (await this.folder(project)).getDirectoryHandle('temporary-backups')
      await directory.removeEntry(key)
    })
  }
  async outputFile(project, key) {
    const folder = await this.folder(project)
    if (exportKey(key)) {
      try { return await (await (await folder.getDirectoryHandle('exports-v2')).getFileHandle(key)).getFile() }
      catch (error) { if (error.name !== 'NotFoundError') throw error }
    }
    return (await folder.getFileHandle(key)).getFile()
  }
  async status() {
    const estimate = await navigator.storage.estimate()
    const persisted = await navigator.storage.persisted?.() ?? false
    return { usage: estimate.usage ?? null, quota: estimate.quota ?? null, persisted, warning: persisted ? 'Saved on this browser. Keep a project backup before clearing website data.' : 'Saved on this browser. It may remove website data under storage pressure, and private windows may clear it when closed. Keep a backup.' }
  }
  async requestPersistence() { const granted = await navigator.storage.persist?.() ?? false; return { ...(await this.status()), persisted: granted } }
}

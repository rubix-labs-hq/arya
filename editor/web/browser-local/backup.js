import { admitBackupProject } from './project-admission.js'
const MAGIC = 'ARYA-BROWSER-BACKUP-1\n'
const MAX_HEADER = 16 * 1024 * 1024
const encoder = new TextEncoder()

/** This archive contains native project JSON and unchanged media bytes, rather than media URLs. */
export async function writeBackup(backend, signal) {
  const context = backend.context(), record = structuredClone(backend.record)
  if (!record) throw new Error('Create or open a project before downloading a backup.')
  const files = [...backend.files.keys()].map(path => {
    const file = backend.file(path)
    return { path, name: backend.files.get(path).name, type: file.type, size: file.size, file }
  })
  if (files.length > 1000) throw new Error('This browser backup supports at most 1000 retained media copies.')
  record.project = JSON.parse(JSON.stringify(record.project))
  admitBackupProject(record.project, files.map(entry => entry.path))
  const header = encoder.encode(JSON.stringify({ format: 'arya-browser-backup', version: 1, project: record.project, files: files.map(({ file, ...metadata }) => metadata) }))
  if (header.byteLength > MAX_HEADER) throw new Error('This project is too large for the browser backup header.')
  const key = `backup-${backend.uuid()}`, writer = await backend.storage.temporaryWriter(record.id, key)
  let position = 0
  const write = async bytes => { signal.throwIfAborted(); backend.assert(context); await writer.write(bytes, position); position += bytes.byteLength }
  try {
    await write(encoder.encode(`${MAGIC}${header.byteLength}\n`)); await write(header)
    for (const entry of files) {
      const reader = entry.file.stream().getReader()
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; await write(value) } }
      finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    }
    signal.throwIfAborted(); backend.assert(context); await writer.close()
    signal.throwIfAborted(); backend.assert(context)
    const file = await writer.file()
    signal.throwIfAborted(); backend.assert(context)
    if (file.size !== position) throw new Error('The project backup did not match its completed writes.')
    await readBackup(file)
    signal.throwIfAborted(); backend.assert(context)
    return { file, name: `${record.project.name.replace(/[\u0000-\u001f/\\]/g, '_')}.arya`, bytes: position, projectID: record.id, key, dispose: writer.dispose }
  } catch (error) { await writer.abort().catch(() => {}); await writer.dispose().catch(() => {}); throw error }
}

export async function readBackup(file) {
  const prefix = new TextDecoder().decode(await file.slice(0, 128).arrayBuffer())
  if (!prefix.startsWith(MAGIC)) throw new Error('Choose an Arya browser project backup with an .arya extension.')
  const end = prefix.indexOf('\n', MAGIC.length), number = prefix.slice(MAGIC.length, end)
  if (end < 0 || !/^[1-9][0-9]*$/.test(number)) throw new Error('The backup header is invalid.')
  const length = Number(number), offset = encoder.encode(prefix.slice(0, end + 1)).byteLength
  if (!Number.isSafeInteger(length) || length > MAX_HEADER || offset + length > file.size) throw new Error('The backup header is too large or incomplete.')
  const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await file.slice(offset, offset + length).arrayBuffer()))
  if (header.format !== 'arya-browser-backup' || header.version !== 1 || !Array.isArray(header.files) || header.files.length > 1000 || !header.project || !Array.isArray(header.project.tracks)) throw new Error('The backup project is unsupported.')
  const seen = new Set(), entries = []; let position = offset + length
  for (const entry of header.files) {
    if (typeof entry.path !== 'string' || !entry.path.startsWith('media/') || /(^|\/)\.\.?($|\/)|[\u0000-\u001f\\]/.test(entry.path) || seen.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size === 0 && header.project.assets?.[entry.path] || position + entry.size > file.size) throw new Error('The backup has unsafe, duplicate, or incomplete media entries.')
    seen.add(entry.path)
    entries.push({ ...entry, file: new File([file.slice(position, position + entry.size)], String(entry.name || entry.path.split('/').pop()), { type: String(entry.type ?? '') }) })
    position += entry.size
  }
  if (position !== file.size || Object.keys(header.project.assets ?? {}).some(path => !seen.has(path))) throw new Error('The backup media does not match its project.')
  admitBackupProject(header.project, seen)
  return { project: header.project, files: entries }
}

export async function restoreBackup(backend, file, signal, onPhase = () => {}) {
  if ([...backend.jobs.values()].some(job => ['running', 'queued', 'cancelling', 'committing'].includes(job.state)) || backend.importController) throw new Error('Finish or cancel the current import or export before reopening a backup.')
  const context = backend.context(), backup = await readBackup(file), id = backend.uuid(), files = new Map()
  const release = await backend.storage.holdRestore(id)
  try {
  // Restoration creates a separate project. Failed copies never overwrite the current one.
  for (const entry of backup.files) {
    signal.throwIfAborted(); backend.assert(context)
    const metadata = backup.project.assets[entry.path] ? await backend.media.probe(entry.file) : null
    signal.throwIfAborted(); backend.assert(context)
    const copied = await backend.storage.copy(id, entry.file, { signal, staging: true, path: entry.path, current: () => context.id === backend.record?.id && context.generation === backend.generation })
    files.set(copied.path, { ...copied, file: await backend.storage.read(copied) })
    if (metadata) backup.project.assets[entry.path] = { ...backup.project.assets[entry.path], ...metadata, name: entry.name, size: entry.size }
  }
  signal.throwIfAborted(); backend.assert(context)
  const project = backup.project
  admitBackupProject(project, files.keys())
  const record = { id, version: 1, project, updated: Date.now(), past: [], future: [], deliveries: [] }
  // This durable admission cannot be aborted. Stop advertising cancellation before it starts.
  onPhase({ cancellable: false, label: 'Saving restored project' })
  signal.throwIfAborted(); backend.assert(context)
  await backend.storage.commit(record, null)
  backend.assert(context)
  await backend.storage.select(id)
  backend.assert(context)
  backend.revokeResources(); backend.files = files; backend.record = record; backend.generation++; backend.jobs.clear(); backend.registerURLs()
  backend.emit('project', backend.snapshot()); return backend.snapshot()
  } finally { await release() }
}

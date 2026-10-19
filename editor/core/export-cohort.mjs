import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { guardedOutput } from './output-path.js'

const FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
const MAX_BYTES = 64 * 1024 ** 3
const CHUNK = 1024 * 1024
const stamp = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.nlink].map(String).join(':')
const directoryStamp = s => [s.dev, s.ino].map(String).join(':')

function regular(root, value) {
  if (typeof value !== 'string' || !value) throw new Error('Export sources must name project files')
  const file = guardedOutput(root, path.resolve(root, value))
  const stat = fs.lstatSync(file, { bigint: true })
  if (!stat.isFile()) throw new Error(`Export source is not a regular file: ${value}`)
  return { file, identity: stamp(stat), bytes: Number(stat.size) }
}

function directories(root, file) {
  const records = []
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    guardedOutput(root, current)
    const s = fs.lstatSync(current, { bigint: true })
    if (!s.isDirectory()) throw new Error('An export source parent is not a directory')
    records.push({ file: current, identity: directoryStamp(s) })
    if (current === path.resolve(root)) return records
  }
}

function checkDirectories(root, records) {
  for (const record of records) {
    guardedOutput(root, record.file)
    if (directoryStamp(fs.lstatSync(record.file, { bigint: true })) !== record.identity) throw new Error('An export source parent changed')
  }
}

export function exportSourceReferences(project) {
  const paths = new Set(Object.entries(project.assets ?? {}).flatMap(([src, asset]) => [src, asset?.proxy].filter(value => typeof value === 'string' && value)))
  const visit = value => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'src' || key === 'proxy' || key === 'lut') && typeof item === 'string' && item) paths.add(item)
      else visit(item)
    }
  }
  visit(project.tracks); visit(project.comps)
  if (paths.size > 10000) throw new Error('Too many export sources')
  return [...paths]
}

export function captureExportSources(root, project) {
  const records = exportSourceReferences(project).map(value => { const admitted = regular(root, value); return { value, ...admitted, directories: directories(root, admitted.file) } })
  if (records.reduce((sum, record) => sum + record.bytes, 0) > MAX_BYTES) throw new Error('Export source copies exceed the 64 GiB limit')
  return { project: structuredClone(project), records, rootIdentity: directoryStamp(fs.lstatSync(root, { bigint: true })) }
}

async function readSource(root, record, check, consume = () => {}) {
  checkDirectories(root, record.directories)
  if (regular(root, record.value).identity !== record.identity) throw new Error(`Export source changed: ${record.value}`)
  const handle = await fsp.open(record.file, FLAGS)
  try {
    const initial = await handle.stat({ bigint: true })
    if (!initial.isFile() || stamp(initial) !== record.identity) throw new Error(`Export source changed: ${record.value}`)
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK)
    let offset = 0
    while (offset < record.bytes) {
      check()
      const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, record.bytes - offset), offset)
      if (!bytesRead) throw new Error(`Export source ended during copy: ${record.value}`)
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk); await consume(chunk, offset); offset += bytesRead
    }
    check()
    checkDirectories(root, record.directories)
    if (stamp(await handle.stat({ bigint: true })) !== record.identity || regular(root, record.value).identity !== record.identity) throw new Error(`Export source changed: ${record.value}`)
    return hash.digest('hex')
  } finally { await handle.close() }
}

export async function prepareExportCohort(root, captured, check = () => {}) {
  check()
  if (directoryStamp(fs.lstatSync(guardedOutput(root, root), { bigint: true })) !== captured.rootIdentity) throw new Error('The export project root changed')
  const parent = guardedOutput(root, path.join(root, '.reel', 'export-cohorts'))
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 })
  const storage = fs.statfsSync(parent, { bigint: true })
  if (captured.records.reduce((sum, record) => sum + BigInt(record.bytes), 0n) + 64n * 1024n ** 2n > storage.bavail * storage.bsize) throw new Error('There is not enough space for immutable export sources')
  const dir = guardedOutput(root, path.join(parent, randomUUID()))
  fs.mkdirSync(dir, { mode: 0o700 })
  const identity = directoryStamp(fs.lstatSync(dir, { bigint: true })), mapping = new Map(), records = []
  const assertDirectory = () => {
    guardedOutput(root, dir)
    if (directoryStamp(fs.lstatSync(root, { bigint: true })) !== captured.rootIdentity) throw new Error('The export project root changed')
    if (directoryStamp(fs.lstatSync(dir, { bigint: true })) !== identity) throw new Error('The export source directory changed')
  }
  const assertCurrentSync = (check = () => {}) => {
    check(); assertDirectory()
    for (const record of records) {
      checkDirectories(root, record.directories)
      if (regular(root, record.value).identity !== record.identity) throw new Error(`Export source changed: ${record.value}`)
      if (regular(root, path.relative(root, record.copy)).identity !== record.copyIdentity) throw new Error('An export source copy changed')
    }
  }
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    assertDirectory(); fs.rmSync(dir, { recursive: true }); cleaned = true
  }
  try {
    for (const [index, record] of captured.records.entries()) {
      check(); assertDirectory()
      const file = path.join(dir, `source-${index}${path.extname(record.value)}`)
      const target = await fsp.open(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      let digest
      try { digest = await readSource(root, record, check, async (chunk, offset) => {
        let done = 0
        while (done < chunk.length) { const { bytesWritten } = await target.write(chunk, done, chunk.length - done, offset + done); if (!bytesWritten) throw new Error('Export source copy stopped'); done += bytesWritten }
      }); await target.sync() } finally { await target.close() }
      fs.chmodSync(file, 0o400)
      records.push({ ...record, digest, copy: file, copyIdentity: stamp(fs.lstatSync(file, { bigint: true })) })
      mapping.set(record.value, path.relative(root, file))
    }
    const rewrite = value => {
      if (Array.isArray(value)) return value.map(rewrite)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, ['src', 'proxy', 'lut'].includes(key) && typeof item === 'string' ? mapping.get(item) ?? item : rewrite(item)]))
      return value
    }
    const snapshot = rewrite(captured.project)
    snapshot.assets = Object.fromEntries(Object.entries(snapshot.assets ?? {}).map(([key, value]) => [mapping.get(key) ?? key, value]))
    const receipt = { id: path.basename(dir), projectSHA256: createHash('sha256').update(JSON.stringify(captured.project)).digest('hex'), sourcesSHA256: createHash('sha256').update(JSON.stringify(records.map(({ value, identity, digest }) => ({ path: value, identity, digest })))).digest('hex'), count: records.length }
    return { project: snapshot, receipt, cleanup, assertCurrentSync, async assertCurrent(check = () => {}) {
      assertDirectory()
      for (const record of records) {
        check()
        if (regular(root, path.relative(root, record.copy)).identity !== record.copyIdentity) throw new Error('An export source copy changed')
        if (await readSource(root, record, check) !== record.digest) throw new Error(`Export source bytes changed: ${record.value}`)
      }
      assertCurrentSync(check)
    } }
  } catch (error) { try { cleanup() } catch {} throw error }
}

export function createExportDestination(root, requested, { sequence = false, references = [] } = {}) {
  const final = guardedOutput(root, requested), directory = path.dirname(final)
  if (!final.startsWith(path.join(path.resolve(root), 'renders') + path.sep)) throw new Error('Export outputs must stay in renders')
  for (const value of references) {
    const source = path.resolve(root, value)
    if (source === final || sequence && source.startsWith(directory + path.sep)) throw new Error('An export cannot overwrite project source media')
  }
  const exists = file => { try { fs.lstatSync(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
  if (exists(sequence ? directory : final)) throw new Error('The export destination already exists. Choose a new name.')
  const parent = guardedOutput(root, path.join(root, 'renders'))
  fs.mkdirSync(parent, { recursive: true })
  const finalParent = sequence ? path.dirname(directory) : directory
  fs.mkdirSync(guardedOutput(root, finalParent), { recursive: true })
  const finalParents = directories(root, path.join(finalParent, 'entry'))
  const parentIdentity = directoryStamp(fs.lstatSync(parent, { bigint: true }))
  const stage = fs.mkdtempSync(path.join(parent, '.arya-export-'))
  fs.chmodSync(stage, 0o700)
  const stageIdentity = directoryStamp(fs.lstatSync(stage, { bigint: true }))
  const output = path.join(stage, sequence ? 'frame_%05d.png' : `output${path.extname(final)}`)
  let state = 'staged', published = [], cleaned = false
  const assertDirectory = () => {
    checkDirectories(root, finalParents)
    for (const [file, identity] of [[parent, parentIdentity], [stage, stageIdentity]]) {
      guardedOutput(root, file)
      if (directoryStamp(fs.lstatSync(file, { bigint: true })) !== identity) throw new Error('The export output directory changed')
    }
  }
  return { output, get state() { return state }, get published() { return [...published] }, assertCurrent() {
    assertDirectory(); guardedOutput(root, final)
    if (exists(sequence ? directory : final)) throw new Error('The export destination appeared while rendering. Choose a new name.')
  }, publish(expectedFrames) {
    this.assertCurrent()
    const names = sequence ? fs.readdirSync(stage).sort() : [path.basename(output)]
    if (sequence && (names.length !== expectedFrames || names.some((name, index) => name !== `frame_${String(index + 1).padStart(5, '0')}.png`))) throw new Error('The export frame sequence is incomplete')
    for (const name of names) { const s = fs.lstatSync(path.join(stage, name)); if (!s.isFile() || s.size === 0 || s.nlink !== 1) throw new Error('The export output is not an owned nonempty regular file') }
    if (sequence) fs.mkdirSync(guardedOutput(root, directory), { mode: 0o700 })
    const finalDirectoryIdentity = sequence ? directoryStamp(fs.lstatSync(directory, { bigint: true })) : null
    try {
      for (const name of names) {
        assertDirectory(); guardedOutput(root, final)
        if (sequence && directoryStamp(fs.lstatSync(directory, { bigint: true })) !== finalDirectoryIdentity) throw new Error('The export sequence directory changed')
        const target = sequence ? path.join(directory, name) : final
        fs.linkSync(path.join(stage, name), guardedOutput(root, target))
        published.push(path.relative(root, target)); state = 'partial'
      }
      state = 'published'
    } catch (error) { if (sequence && !published.length) state = 'reserved'; throw error }
  }, cleanup() {
    if (cleaned) return
    assertDirectory(); fs.rmSync(stage, { recursive: true }); cleaned = true
  } }
}

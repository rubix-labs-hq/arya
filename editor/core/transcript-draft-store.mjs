import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { guardedOutput } from './output-path.js'

export const DRAFT_LIMITS = Object.freeze({ recordBytes: 16 * 1024 * 1024, storeBytes: 256 * 1024 * 1024, files: 64, sessions: 8, words: 100000 })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const conflict = message => Object.assign(new Error(message), { status: 409 })
const identity = stat => `${stat.dev}|${stat.ino}`
const fileStamp = stat => `${stat.dev}|${stat.ino}|${stat.size}|${stat.mode}|${stat.uid}|${stat.gid}|${stat.mtimeNs}|${stat.ctimeNs}`
const same = (a, b) => Boolean(a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]))
export function readTranscriptDraftBytes(file, limit, { beforeRead = () => {} } = {}) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  try {
    const before = fs.fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 0n || before.size > BigInt(limit)) throw new Error('Invalid recovery byte limit or file type')
    const buffer = Buffer.alloc(Number(before.size) + 1)
    beforeRead(file)
    let count = 0, next
    while (count < buffer.length && (next = fs.readSync(fd, buffer, count, buffer.length - count, null)) > 0) count += next
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(file, { bigint: true })
    const stamp = stat => `${stat.dev}|${stat.ino}|${stat.size}|${stat.mtimeNs}|${stat.ctimeNs}`
    if (!named.isFile() || count !== Number(before.size) || stamp(before) !== stamp(after) || stamp(before) !== stamp(named)) throw new Error('The recovery file changed while being read')
    return { bytes: buffer.subarray(0, count), stat: before }
  } finally { fs.closeSync(fd) }
}

export function transcriptTimingDigest(words) {
  const bytes = Buffer.alloc(words.length * 16)
  words.forEach((word, index) => { bytes.writeDoubleLE(word.t === 0 ? 0 : word.t, index * 16); bytes.writeDoubleLE(word.end === 0 ? 0 : word.end, index * 16 + 8) })
  return hash(bytes)
}
export function exactDraftWords(words) {
  if (!Array.isArray(words) || words.length > DRAFT_LIMITS.words) throw new Error('A recovery copy supports at most 100000 words')
  let last = 0
  return words.map(word => {
    if (!Number.isFinite(word.t) || !Number.isFinite(word.end) || word.t < last || word.end <= word.t || typeof word.text !== 'string' || word.text.length > 1000) throw new Error('Recovery words need ordered finite timestamps and text of at most 1000 characters')
    last = word.t
    return { t: word.t, end: word.end, text: word.text }
  })
}

// Records belong to the project folder. A recovery operation only returns unsaved
// words; the existing transcript Save route remains the publication boundary.
export function createTranscriptDraftStore({ root, resolveMedia, readTranscript, assertPublication = () => {}, beforePublish = () => {}, publicationLockHeld = null, assertLock = null, privateStage = null }) {
  const directory = path.join(root, '.reel', 'transcript-drafts')
  const checkPrivateStage = () => {
    if (!privateStage) { if (assertLock) return; throw new Error('Recovery mutations require a retained private staging file') }
    const held = fs.fstatSync(privateStage.fd, { bigint: true }), named = fs.lstatSync(guardedOutput(root, path.join(directory, privateStage.name)), { bigint: true })
    if (!/^draft-[a-f0-9]{32}\.part$/.test(privateStage.name) || !held.isFile() || !named.isFile() || held.nlink !== 1n || named.nlink !== 1n || held.size !== 0n || (held.mode & 0o7777n) !== 0o600n || fileStamp(held) !== privateStage.expectedStamp || fileStamp(named) !== privateStage.expectedStamp || identity(fs.statSync(directory, { bigint: true })) !== privateStage.directoryIdentity) throw conflict('The retained private staging file changed before writing')
  }
  const checkLock = () => {
    if (assertLock) return assertLock()
    if (!Number.isSafeInteger(publicationLockHeld) || publicationLockHeld < 0) throw new Error('Recovery mutations require the retained shared project publication lock')
    const file = guardedOutput(root, path.join(root, '.reel/recovery/project-write.lock'))
    const held = fs.fstatSync(publicationLockHeld, { bigint: true }), named = fs.lstatSync(file, { bigint: true })
    if (!held.isFile() || !named.isFile() || held.size !== 0n || named.size !== 0n || held.nlink !== 1n || named.nlink !== 1n || identity(held) !== identity(named)) throw new Error('The retained project publication lock changed')
  }
  resolveMedia ??= src => {
    const file = path.resolve(path.isAbsolute(src) ? src : path.join(root, src)), base = path.resolve(root)
    if (file.startsWith(base + path.sep)) return file
    const projectFile = guardedOutput(root, path.join(root, 'reel.project.json'))
    const project = JSON.parse(readTranscriptDraftBytes(projectFile, 64 * 1024 * 1024).bytes.toString('utf8'))
    if (Object.keys(project.assets ?? {}).some(key => path.resolve(path.isAbsolute(key) ? key : path.join(root, key)) === file)) return file
    throw new Error('The source is outside the project and is not referenced by its current assets')
  }
  readTranscript ??= (src, locale) => {
    const key = createHash('sha1').update(`${src}|${locale}`).digest('hex').slice(0, 16)
    const file = guardedOutput(root, path.join(root, '.reel/transcripts', `${key}.json`))
    if (!fs.existsSync(file)) return { words: [], revision: 0, status: 'missing' }
    const value = JSON.parse(readTranscriptDraftBytes(file, DRAFT_LIMITS.recordBytes).bytes.toString('utf8'))
    if (value.src !== src || value.locale !== locale || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('The saved transcript does not match this source and language')
    const stat = fs.statSync(resolveMedia(src), { bigint: true })
    let seconds = stat.mtimeNs / 1000000000n, nanos = stat.mtimeNs % 1000000000n
    if (nanos < 0n) { seconds--; nanos += 1000000000n }
    let matches = value.fingerprint === `v2|${stat.size}|${seconds}|${nanos}`
    const legacy = typeof value.fingerprint === 'string' && /^(0|[1-9][0-9]*)\|(-?(?:0|[1-9][0-9]*))\.([0-9]{3})$/.exec(value.fingerprint)
    if (!matches && legacy && BigInt(legacy[1]) === stat.size) {
      const micros = BigInt(legacy[2]) * 1000n + (legacy[2].startsWith('-') ? -BigInt(legacy[3]) : BigInt(legacy[3]))
      const distance = stat.mtimeNs - micros * 1000n
      matches = distance >= -1000n && distance <= 1000n
    }
    if (!matches) return { ...value, status: 'stale' }
    return value
  }
  const location = (src, locale) => {
    if (typeof src !== 'string' || !src || src.length > 4096 || src.includes('\0')) throw new Error('Choose a transcript source')
    const tag = Intl.getCanonicalLocales(String(locale ?? 'en-US'))[0]
    if (!tag || tag.length > 64) throw new Error('Choose a valid transcript language')
    return { src, locale: tag }
  }
  const basis = (src, locale) => {
    const folder = fs.statSync(root, { bigint: true }), source = fs.statSync(resolveMedia(src), { bigint: true })
    if (!source.isFile()) throw new Error('The source is not a file')
    const projectFile = path.join(root, 'reel.project.json'), projectStat = fs.statSync(projectFile)
    if (projectStat.size > 64 * 1024 * 1024) throw new Error('The project is larger than the recovery identity limit of 64 MB')
    const record = readTranscript(src, locale)
    if (record.status === 'stale') throw conflict('The source changed. Its recovery copy can only be copied.')
    const words = exactDraftWords(record.words ?? [])
    if (!Number.isSafeInteger(record.revision) || record.revision < 0) throw new Error('The transcript has no valid revision')
    return { folder: identity(folder), projectSHA256: hash(readTranscriptDraftBytes(guardedOutput(root, projectFile), 64 * 1024 * 1024).bytes), source: `v3|${source.dev}|${source.ino}|${source.size}|${source.mtimeNs}|${source.ctimeNs}`, revision: record.revision, fingerprint: record.fingerprint ?? '', wordCount: words.length, timingSHA256: transcriptTimingDigest(words) }
  }
  const scan = () => {
    guardedOutput(root, directory)
    if (!fs.existsSync(directory)) return { records: [], warnings: [], bytes: 0, files: 0 }
    const names = [], stream = fs.opendirSync(directory)
    try { let entry; while ((entry = stream.readSync())) { if (names.length >= DRAFT_LIMITS.files) throw new Error('The recovery store exceeds its 64-file limit. Preserve it and inspect the files before continuing.'); names.push(entry.name) } } finally { stream.closeSync() }
    const records = [], warnings = []; let bytes = 0
    for (const name of names) {
      if (privateStage && name === privateStage.name) continue
      const file = path.join(directory, name)
      const named = fs.lstatSync(file, { bigint: true })
      if (named.isFile()) { if (named.size < 0n || named.size > BigInt(DRAFT_LIMITS.storeBytes - bytes)) throw new Error('The recovery store exceeds its 256 MB limit'); bytes += Number(named.size) }
      try {
        if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new Error('unrecognized record')
        guardedOutput(root, file)
        const observed = readTranscriptDraftBytes(file, DRAFT_LIMITS.recordBytes), stat = observed.stat, value = JSON.parse(observed.bytes.toString('utf8'))
        if (value.schema !== 1 || !uuid(value.id) || name !== `${value.id}.json` || !uuid(value.sessionID) || !Number.isSafeInteger(value.sequence) || value.sequence < 1 || value.sequence > 1000000000 || !['draft', 'discard'].includes(value.kind) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error('invalid record')
        location(value.src, value.locale)
        if (value.kind === 'draft') {
          value.words = exactDraftWords(value.words)
          if (!value.basis || value.basis.wordCount !== value.words.length || value.basis.timingSHA256 !== transcriptTimingDigest(value.words)) throw new Error('invalid captured timestamps')
        }
        records.push({ ...value, file, fileIdentity: identity(stat), fileStamp: `${stat.dev}|${stat.ino}|${stat.size}|${stat.mtimeNs}|${stat.ctimeNs}` })
      } catch (error) { warnings.push(`${name}: ${error.message}`) }
    }
    if (bytes > DRAFT_LIMITS.storeBytes) throw new Error('The recovery store exceeds its 256 MB limit')
    return { records, warnings, bytes, files: names.length - (privateStage && names.includes(privateStage.name) ? 1 : 0) }
  }
  const heads = records => {
    const result = new Map()
    for (const record of records) {
      const previous = result.get(record.sessionID)
      if (!previous || record.sequence > previous.sequence) result.set(record.sessionID, record)
      else if (record.sequence === previous.sequence && record.id !== previous.id) throw conflict('Two recovery records claim the same session sequence. Preserve them and inspect the recovery store.')
    }
    return result
  }
  const selected = body => {
    if (!uuid(body.id)) throw new Error('Choose a recovery copy')
    const state = scan(), record = state.records.find(value => value.id === body.id)
    if (!record || record.kind !== 'draft' || record.src !== body.src || record.locale !== location(body.src, body.locale).locale) throw conflict('That recovery copy is no longer available')
    if (heads(state.records).get(record.sessionID)?.id !== record.id) throw conflict('That recovery copy was superseded. Reload the recovery offers.')
    return { state, record }
  }
  const publish = (state, value, validate) => {
    const encoded = JSON.stringify(value), size = Buffer.byteLength(encoded)
    if (size > DRAFT_LIMITS.recordBytes || state.bytes + size > DRAFT_LIMITS.storeBytes || state.files > DRAFT_LIMITS.files - 2) throw new Error('The recovery store is full. Preserve it and inspect its files before continuing.')
    fs.mkdirSync(guardedOutput(root, directory), { recursive: true, mode: 0o700 })
    const ownedDirectory = identity(fs.statSync(directory, { bigint: true }))
    checkPrivateStage()
    const temp = guardedOutput(root, path.join(directory, privateStage?.name ?? `${randomUUID()}.part`)), final = guardedOutput(root, path.join(directory, `${value.id}.json`))
    const dirfd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    let fd, staged, published = false, warning
    try {
      fd = privateStage?.fd ?? fs.openSync(temp, 'wx', 0o600)
      staged = fs.fstatSync(fd, { bigint: true })
      checkPrivateStage()
      fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); staged = fs.fstatSync(fd, { bigint: true })
      beforePublish(value); checkLock(); assertPublication(); validate()
      guardedOutput(root, directory)
      if (identity(fs.statSync(directory, { bigint: true })) !== ownedDirectory) throw conflict('The recovery directory changed before publication')
      const held = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(guardedOutput(root, temp), { bigint: true })
      const stamp = fileStamp
      if (!named.isFile() || named.nlink !== 1n || stamp(staged) !== stamp(held) || stamp(staged) !== stamp(named)) throw conflict('The staged recovery copy changed before publication')
      const verified = readTranscriptDraftBytes(temp, DRAFT_LIMITS.recordBytes)
      if (stamp(verified.stat) !== stamp(staged) || hash(verified.bytes) !== hash(encoded)) throw conflict('The staged recovery bytes changed before publication')
      fs.linkSync(temp, final); published = true
      try {
      if (identity(fs.lstatSync(temp, { bigint: true })) !== identity(staged)) throw conflict('The published recovery temporary changed')
      fs.unlinkSync(temp)
      const observed = readTranscriptDraftBytes(final, DRAFT_LIMITS.recordBytes), heldAfterLink = fs.fstatSync(fd, { bigint: true })
      if (identity(observed.stat) !== identity(staged) || stamp(observed.stat) !== stamp(heldAfterLink) || hash(observed.bytes) !== hash(encoded)) throw conflict('The published recovery copy changed')
      fs.fsyncSync(dirfd)
      } catch { warning = 'The recovery record was published, but its cleanup or verification did not finish. Keep the editor open or save corrections before closing.' }
    } finally {
      if (fd !== undefined && !privateStage) fs.closeSync(fd)
      fs.closeSync(dirfd)
      // A displaced directory is preserved. Cleanup never follows its replacement.
      try { if (staged && identity(fs.statSync(directory, { bigint: true })) === ownedDirectory && identity(fs.lstatSync(guardedOutput(root, temp), { bigint: true })) === identity(staged)) fs.unlinkSync(temp) } catch {}
    }
    if (published && !warning) { try { checkLock(); assertPublication() } catch { warning = 'The recovery copy was published. Cleanup was deferred because its publication identity changed.' } }
    if (published && !warning) for (const old of state.records.filter(record => record.sessionID === value.sessionID)) {
      try { const stat = fs.lstatSync(guardedOutput(root, old.file), { bigint: true }); if (stat.isFile() && stat.nlink === 1n && `${stat.dev}|${stat.ino}|${stat.size}|${stat.mtimeNs}|${stat.ctimeNs}` === old.fileStamp) fs.unlinkSync(old.file) } catch {}
    }
    return { id: value.id, sessionID: value.sessionID, sequence: value.sequence, createdAt: value.createdAt, ...(warning ? { warning } : {}) }
  }
  return {
    context(src, locale) {
      const owner = location(src, locale), state = scan(); let current = null, reason
      try { current = basis(owner.src, owner.locale) } catch (error) { reason = error.message }
      return { ...owner, basis: current, reason, warnings: state.warnings, offers: [...heads(state.records).values()].filter(record => record.kind === 'draft' && record.src === owner.src && record.locale === owner.locale).map(record => ({ id: record.id, sessionID: record.sessionID, sequence: record.sequence, createdAt: record.createdAt, wordCount: record.words.length, recoverable: Boolean(current && same(current, record.basis)) })) }
    },
    checkpoint(body) {
      checkLock(); checkPrivateStage()
      const owner = location(body.src, body.locale), state = scan(), current = basis(owner.src, owner.locale)
      if (!same(current, body.basis)) throw conflict('The project, source or transcript changed. Copy the unsaved words and recheck before editing.')
      if (!uuid(body.sessionID) || !Number.isSafeInteger(body.sequence) || body.sequence < 1 || body.sequence > 1000000000) throw new Error('Recovery copies need a session and a finite sequence')
      const headMap = heads(state.records), head = headMap.get(body.sessionID)
      if (head ? head.id !== body.parent || body.sequence !== head.sequence + 1 || head.src !== owner.src || head.locale !== owner.locale : body.parent != null || body.sequence !== 1) throw conflict('The recovery session changed. Reload its current head before checkpointing.')
      if (!head && [...headMap.values()].filter(record => record.kind === 'draft').length >= DRAFT_LIMITS.sessions) throw new Error('Eight recovery sessions already have unsaved words. Copy or discard one before editing in another window.')
      const words = exactDraftWords(body.words)
      if (words.length !== current.wordCount || transcriptTimingDigest(words) !== current.timingSHA256) throw conflict('Recovery words must retain the captured transcript timestamps')
      return publish(state, { schema: 1, id: randomUUID(), kind: 'draft', ...owner, sessionID: body.sessionID, sequence: body.sequence, parent: body.parent ?? null, createdAt: Date.now(), basis: current, words }, () => { if (!same(current, basis(owner.src, owner.locale))) throw conflict('The source or transcript changed before recovery publication') })
    },
    read(body) { const { record } = selected(body); return { src: record.src, locale: record.locale, basis: record.basis, words: record.words } },
    recover(body) { const { record } = selected(body), current = basis(record.src, record.locale); if (!same(current, record.basis)) throw conflict('This recovery copy has old source timestamps or project identity. Copy its text instead.'); return { src: record.src, locale: record.locale, basis: current, words: record.words } },
    discard(body) { checkLock(); checkPrivateStage(); const { state, record } = selected(body); if (record.sequence >= 1000000000) throw conflict('This recovery session reached its sequence limit. Copy its text before retiring it.'); return publish(state, { schema: 1, id: randomUUID(), kind: 'discard', src: record.src, locale: record.locale, sessionID: record.sessionID, sequence: record.sequence + 1, parent: record.id, createdAt: Date.now() }, () => { if (heads(scan().records).get(record.sessionID)?.id !== record.id) throw conflict('The recovery copy changed before discard') }) },
  }
}

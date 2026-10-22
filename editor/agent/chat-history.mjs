// Project-owned display history. Loading this module never submits or resumes an agent run.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { guardedOutput } from '../core/output-path.js'
import { redact } from './protocol.mjs'

export const CHAT_HISTORY_LIMITS = Object.freeze({ messages: 200, bytes: 2 * 1024 * 1024 })
const messageKeys = new Set(['role', 'text', 'at', 'refs', 'error', 'provider'])
const providers = new Set(['claude-code', 'codex', 'antigravity', 'gemini-cli', 'custom', 'anthropic'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = code => Object.assign(new Error(code), { code })
const hash = data => createHash('sha256').update(data).digest('hex')
const encode = messages => Buffer.from(JSON.stringify({ version: 1, messages }) + '\n')
const copy = value => structuredClone(value)

function message(value, strict = false) {
  if (!object(value) || !['user', 'claude', 'assistant'].includes(value.role) || typeof value.text !== 'string' || !Number.isSafeInteger(value.at) || value.at < 0) throw fail('CHAT_HISTORY_INVALID')
  if (strict && Object.keys(value).some(key => !messageKeys.has(key))) throw fail('CHAT_HISTORY_INVALID')
  if (value.error !== undefined && typeof value.error !== 'boolean' || value.provider !== undefined && !providers.has(value.provider)) throw fail('CHAT_HISTORY_INVALID')
  const result = { role: value.role, text: redact(value.text), at: value.at }
  if (value.error !== undefined) result.error = value.error
  if (value.provider !== undefined) result.provider = value.provider
  if (value.refs !== undefined) {
    if (!Array.isArray(value.refs) || value.refs.length > 64) throw fail('CHAT_HISTORY_INVALID')
    result.refs = value.refs.map(ref => {
      if (!object(ref) || typeof ref.kind !== 'string' || typeof ref.id !== 'string' || typeof ref.label !== 'string' || ref.kind.length > 64 || ref.id.length > 2048 || ref.label.length > 4096) throw fail('CHAT_HISTORY_INVALID')
      if (strict && Object.keys(ref).some(key => !['kind', 'id', 'label'].includes(key))) throw fail('CHAT_HISTORY_INVALID')
      // Historical refs are display labels, never serialized tool context or credentials.
      return { kind: redact(ref.kind), id: redact(ref.id), label: redact(ref.label) }
    })
  }
  if (encode([result]).length > CHAT_HISTORY_LIMITS.bytes) throw fail('CHAT_HISTORY_SIZE')
  return result
}

function fit(values) {
  const result = values.slice(-CHAT_HISTORY_LIMITS.messages)
  while (result.length && encode(result).length > CHAT_HISTORY_LIMITS.bytes) result.shift()
  return result
}

function readBytes(root, file) {
  let descriptor
  try {
    descriptor = fs.openSync(guardedOutput(root, file), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    const info = fs.fstatSync(descriptor)
    if (!info.isFile() || info.nlink !== 1) throw fail('CHAT_HISTORY_PATH')
    if (info.size > CHAT_HISTORY_LIMITS.bytes) throw fail('CHAT_HISTORY_SIZE')
    // Never let a concurrent growth turn readFileSync into an unbounded allocation.
    const data = Buffer.alloc(CHAT_HISTORY_LIMITS.bytes + 1)
    let length = 0, count
    while (length < data.length && (count = fs.readSync(descriptor, data, length, data.length - length, length)) > 0) length += count
    if (length > CHAT_HISTORY_LIMITS.bytes) throw fail('CHAT_HISTORY_SIZE')
    const after = fs.fstatSync(descriptor)
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs || length !== after.size) throw fail('CHAT_HISTORY_CHANGED')
    guardedOutput(root, file)
    return data.subarray(0, length)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor) }
}

function parse(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw fail('CHAT_HISTORY_INVALID') }
  if (!object(value) || value.version !== 1 || Object.keys(value).some(key => !['version', 'messages'].includes(key)) || !Array.isArray(value.messages) || value.messages.length > CHAT_HISTORY_LIMITS.messages) throw fail('CHAT_HISTORY_INVALID')
  return value.messages.map(value => message(value, true))
}

export function createChatHistory({ root, diagnostic = () => {} }) {
  root = path.resolve(root)
  const file = path.join(root, '.reel', 'assistant-chat.json')
  let messages = [], warning = null, blocked = false, previousHash = null, restored = 0
  const report = (kind, error) => {
    const code = /^CHAT_HISTORY_[A-Z_]+$/.test(error.code ?? '') ? error.code : 'CHAT_HISTORY_IO'
    warning = kind === 'read' ? 'Saved chat history could not be read. The existing file is unchanged; inspect .reel/assistant-chat.json before saving history again.' : kind === 'flush' ? 'Chat history was saved, but its directory flush could not be confirmed.' : 'Chat history could not be saved. Messages remain visible for this session; the previous saved file is unchanged.'
    // Do not log parse excerpts, prompt contents, provider config, credentials or absolute paths.
    try { diagnostic(`Assistant chat history ${kind} failed (${code}). ${warning}`) } catch {}
  }
  try {
    const bytes = readBytes(root, file)
    if (bytes !== null) { messages = parse(bytes); previousHash = hash(bytes); restored = messages.length }
  } catch (error) { blocked = true; report('read', error) }

  const persist = () => {
    if (blocked) return
    const bytes = encode(messages)
    let temporary, descriptor, published = false
    try {
      const current = readBytes(root, file)
      if ((current === null ? null : hash(current)) !== previousHash) throw fail('CHAT_HISTORY_CHANGED')
      const directory = guardedOutput(root, path.dirname(file))
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      temporary = guardedOutput(root, path.join(directory, `assistant-chat-${randomUUID()}.part.json`))
      descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
      const owned = fs.fstatSync(descriptor)
      fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined
      const candidate = fs.lstatSync(guardedOutput(root, temporary))
      if (!candidate.isFile() || candidate.nlink !== 1 || candidate.dev !== owned.dev || candidate.ino !== owned.ino) throw fail('CHAT_HISTORY_CHANGED')
      const beforeRename = readBytes(root, file)
      if ((beforeRename === null ? null : hash(beforeRename)) !== previousHash) throw fail('CHAT_HISTORY_CHANGED')
      fs.renameSync(guardedOutput(root, temporary), guardedOutput(root, file))
      published = true; previousHash = hash(bytes); warning = null
      let directoryDescriptor
      try {
        directoryDescriptor = fs.openSync(guardedOutput(root, directory), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW)
        fs.fsyncSync(directoryDescriptor)
      } catch (error) { report('flush', error) }
      finally { if (directoryDescriptor !== undefined) fs.closeSync(directoryDescriptor) }
    } catch (error) {
      if (!published) report('write', error)
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor)
      if (temporary && !published) { try { fs.unlinkSync(guardedOutput(root, temporary)) } catch {} }
    }
  }
  return {
    messages: () => copy(messages),
    status: () => ({ restored, warning, savingAvailable: !blocked }),
    append(value) { messages = fit([...messages, message(value)]); persist(); return copy(messages) },
    replace(values) {
      if (!Array.isArray(values)) throw fail('CHAT_HISTORY_INVALID')
      // Seeding accepts message rows only; it never accepts a snapshot/state/config object.
      messages = fit(values.slice(-CHAT_HISTORY_LIMITS.messages).map(value => message(value))); persist(); return copy(messages)
    },
  }
}

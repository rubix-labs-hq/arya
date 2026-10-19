// Durable completion receipts plus explicitly unverified discovery of old renders.
// Never accepts a caller-supplied file path for an access action.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { guardedOutput } from './output-path.js'

const extensions = new Set(['mp4', 'mov', 'webm', 'gif', 'wav', 'm4a', 'mp3', 'flac', 'ogg', 'png', 'jpg', 'jpeg'])
const maxEntries = 500, maxBytes = 1024 * 1024, maxScan = 2000
const frameName = /^frame_\d{5,}\.png$/

/** The arguments `open` gets for a delivery that `resolve` returned. A frame sequence reveals its
 * first frame, so Finder shows the folder and a folder named like `X.app` never launches as a package. */
export function deliveryOpenArguments(file, action) {
  if (action === 'reveal') return ['-R', file]
  if (!fs.statSync(file).isDirectory()) return [file]
  const first = fs.readdirSync(file).filter(name => frameName.test(name)).sort()[0]
  if (!first) throw new Error('Delivery folder is not a frame sequence')
  return ['-R', path.join(file, first)]
}
function sourceCohort(value) {
  if (value == null) return null
  if (typeof value !== 'object' || typeof value.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.id) || !/^[a-f0-9]{64}$/.test(value.projectSHA256) || !/^[a-f0-9]{64}$/.test(value.sourcesSHA256) || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 10000) throw new Error('Invalid export source cohort receipt')
  return { id: value.id, projectSHA256: value.projectSHA256, sourcesSHA256: value.sourcesSHA256, count: value.count }
}
function nativeAcceptance(value) {
  const fields = {}
  if (value.acceptedVersion != null) {
    if (!Number.isSafeInteger(value.acceptedVersion) || value.acceptedVersion < 0) throw new Error('Invalid accepted export version')
    fields.acceptedVersion = value.acceptedVersion
  }
  if (value.acceptedGeneration != null) {
    if (typeof value.acceptedGeneration !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.acceptedGeneration)) throw new Error('Invalid accepted export generation')
    fields.acceptedGeneration = value.acceptedGeneration
  }
  for (const key of ['acceptedProjectSHA256', 'sourceCohortID']) if (value[key] != null) {
    if (typeof value[key] !== 'string' || !/^[a-f0-9]{64}$/.test(value[key])) throw new Error('Invalid accepted export source hash')
    fields[key] = value[key]
  }
  return fields
}

export class DeliveryHistory {
  constructor(root, sources = () => []) { this.root = path.resolve(root); this.sources = sources }
  id(output) { return createHash('sha256').update(this.root + '\0' + output).digest('hex') }
  path(output) {
    if (typeof output !== 'string' || output.length > 2048 || output.includes('\0') || output.includes('\\') || !output.startsWith('renders/') || output.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid delivery output')
    const file = guardedOutput(this.root, path.join(this.root, output))
    return file
  }
  inspect(output, expectedFrames) {
    const file = this.path(output), info = fs.lstatSync(file)
    const compared = fs.realpathSync(file)
    if (this.sources().some(src => {
      if (typeof src !== 'string') return false
      let source = path.resolve(this.root, src)
      try { source = fs.realpathSync(source) } catch {}
      return source === compared || source.startsWith(compared + path.sep)
    })) throw new Error('Delivery contains source media referenced by the project')
    if (info.isFile()) {
      if (!extensions.has(path.extname(file).slice(1).toLowerCase()) || info.size <= 0) throw new Error('Delivery file is empty or unsupported')
      return { file, sequence: false }
    }
    if (!info.isDirectory()) throw new Error('Delivery is not a regular file or frame sequence')
    const names = fs.readdirSync(file)
    if (!names.length || names.length > 100000 || names.some(n => !frameName.test(n))) throw new Error('Delivery folder is not a frame sequence')
    for (const name of names) {
      const frame = guardedOutput(this.root, path.join(file, name)), stat = fs.lstatSync(frame)
      if (!stat.isFile() || stat.size <= 0) throw new Error('Delivery sequence has an unavailable frame')
    }
    if (expectedFrames != null && names.length !== expectedFrames) throw new Error('Delivery sequence has missing or extra frames')
    return { file, sequence: true, frames: names.length }
  }
  read() {
    const file = guardedOutput(this.root, path.join(this.root, '.reel/deliveries.json'))
    if (!fs.existsSync(file)) return []
    const info = fs.lstatSync(file)
    if (!info.isFile() || info.size > maxBytes) throw new Error('Delivery history is not a supported regular file')
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (value.version !== 1 || !Array.isArray(value.entries) || value.entries.length > maxEntries) throw new Error('Delivery history format is unsupported')
    const seen = new Set()
    return value.entries.map(entry => {
      this.path(entry.output)
      if (seen.has(entry.output) || !Number.isFinite(entry.finished) || entry.finished < 0 || (entry.frames != null && (!Number.isSafeInteger(entry.frames) || entry.frames < 1))) throw new Error('Delivery history has an invalid receipt')
      seen.add(entry.output)
      return { output: entry.output, finished: entry.finished, ...(typeof entry.preset === 'string' ? { preset: entry.preset.slice(0, 80) } : {}), ...(entry.frames != null ? { frames: entry.frames } : {}), ...(entry.sourceCohort != null ? { sourceCohort: sourceCohort(entry.sourceCohort) } : {}), ...nativeAcceptance(entry) }
    })
  }
  record(output, spec = {}, finished = Date.now()) {
    if (!Number.isFinite(finished) || finished < 0) throw new Error('Invalid delivery completion time')
    // Browser encoder uses a pattern; receipts/access use the containing directory.
    if (path.basename(output) === 'frame_%05d.png') output = path.posix.dirname(output)
    const inspected = this.inspect(output, spec.frames)
    const entries = this.read().filter(e => e.output !== output)
    entries.push({ output, finished, ...(typeof spec.preset === 'string' ? { preset: spec.preset.slice(0, 80) } : {}), ...(inspected.sequence ? { frames: inspected.frames } : {}), ...(spec.sourceCohort != null ? { sourceCohort: sourceCohort(spec.sourceCohort) } : {}), ...nativeAcceptance(spec) })
    const data = JSON.stringify({ version: 1, entries: entries.slice(-maxEntries) }) + '\n'
    if (Buffer.byteLength(data) > maxBytes) throw new Error('Delivery history is full')
    const file = guardedOutput(this.root, path.join(this.root, '.reel/deliveries.json'))
    fs.mkdirSync(guardedOutput(this.root, path.dirname(file)), { recursive: true })
    const temporary = guardedOutput(this.root, file + '.' + randomUUID() + '.tmp')
    try {
      fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 })
      guardedOutput(this.root, file)
      fs.renameSync(temporary, file)
    } finally { fs.rmSync(guardedOutput(this.root, temporary), { force: true }) }
  }
  list() {
    let receipts = [], warnings = []
    try { receipts = this.read() } catch { warnings.push('Saved delivery history could not be read. Existing render files are shown without a completion receipt.') }
    const rows = new Map()
    const add = (output, receipt) => {
      let inspected, problem
      try { inspected = this.inspect(output, receipt?.frames) } catch { problem = 'Missing, empty, changed sequence, source media, or unsafe output. Restore the original output or export again.' }
      rows.set(output, { id: this.id(output), output, provenance: receipt ? 'completed' : 'existing', available: !!inspected, sequence: inspected?.sequence ?? !!receipt?.frames, ...(receipt ? { finished: receipt.finished, preset: receipt.preset, ...(receipt.sourceCohort ? { sourceCohort: receipt.sourceCohort } : {}), ...nativeAcceptance(receipt) } : {}), ...(problem ? { problem } : {}) })
    }
    for (const receipt of receipts) add(receipt.output, receipt)
    let scanned = 0
    const visit = (directory, depth) => {
      if (depth > 4) return
      let names
      try { names = fs.readdirSync(guardedOutput(this.root, directory)).sort() } catch { return }
      for (const name of names) {
        if (++scanned > maxScan) { warnings.push('Some render files were omitted because discovery reached its limit.'); return }
        if (name.startsWith('.') || name.includes('.part') || name.endsWith('.tmp')) continue
        const file = path.join(directory, name), output = path.relative(this.root, file).split(path.sep).join('/')
        if (rows.has(output)) continue
        try {
          this.inspect(output); add(output)
        } catch {
          try { if (fs.lstatSync(guardedOutput(this.root, file)).isDirectory()) visit(file, depth + 1) } catch {}
        }
      }
    }
    visit(path.join(this.root, 'renders'), 0)
    return { root: this.root, deliveries: [...rows.values()].sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0) || a.output.localeCompare(b.output)), warnings: [...new Set(warnings)] }
  }
  resolve(id, root) {
    if (root !== this.root) throw new Error('The project changed. Refresh delivery history.')
    const row = this.list().deliveries.find(e => e.id === id)
    if (!row || !row.available) throw new Error('This delivery is unavailable. Restore the output or export again.')
    return this.inspect(row.output).file
  }
}

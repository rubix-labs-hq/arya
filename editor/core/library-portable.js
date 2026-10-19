import { validateLibraryItem, libraryLUTDependencies } from './library.js'
import { parseCube } from './cube-lut.js'

const fail = message => { throw new Error(`Component transfer: ${message}`) }
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function sourcePath(path) {
  if (typeof path !== 'string' || path.length > 1024 || !/\.cube$/i.test(path) || path.includes('\\') || /[:\u0000-\u001f]/.test(path) ||
      path.split('/').some(part => !part || part === '.' || part === '..')) fail('LUT paths must be confined relative CUBE paths')
}

function utf8Bytes(text) {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('CUBE text must be valid UTF-8')
      bytes += 4
    } else if (code >= 0xdc00 && code <= 0xdfff) fail('CUBE text must be valid UTF-8')
    else bytes += code < 128 ? 1 : code < 2048 ? 2 : 3
  }
  return bytes
}

export function portableLibraryPlan(item, resources) {
  validateLibraryItem(item)
  if (!plain(resources)) fail('give a LUT resource map')
  if (Object.keys(item.body.assets ?? {}).length) fail('media files are not included in LUT component packages')
  const scan = value => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'src' && typeof child === 'string' && child) fail('media files are not included in LUT component packages')
      scan(child)
    }
  }
  scan(item.body)
  const dependencies = libraryLUTDependencies({}, { op: 'library_register', item })
  if (Object.keys(resources).length !== dependencies.length) fail('include exactly the referenced LUT resources')
  let total = 0
  const files = dependencies.map(input => {
    sourcePath(input.path)
    const resource = resources[input.path]
    if (!plain(resource) || Object.keys(resource).some(key => !['type', 'size', 'sourceHash', 'text'].includes(key)) ||
        resource.type !== 'lut' || !digest(resource.sourceHash) || resource.sourceHash !== input.sourceHash ||
        resource.size !== input.size || typeof resource.text !== 'string') fail('a LUT resource receipt is missing or inconsistent')
    const bytes = utf8Bytes(resource.text)
    total += bytes
    if (!bytes || bytes > 2 * 1024 * 1024 || total > 4 * 1024 * 1024) fail('LUT transfer supports 2 MiB per file and 4 MiB total')
    if (resource.text.startsWith('\ufeff') || resource.text.includes('\0')) fail('CUBE text must be exact UTF-8 without a BOM or NUL')
    if (parseCube(resource.text).size !== input.size) fail('the CUBE grid does not match its receipt')
    return { ...resource, sourcePath: input.path, path: `luts/Component-${resource.sourceHash}.cube` }
  })
  return { files }
}

export function remapPortableLibraryItem(item, paths) {
  const dependencies = libraryLUTDependencies({}, { op: 'library_register', item })
  if (!plain(paths) || Object.keys(paths).length !== dependencies.length) fail('give exactly the admitted LUT paths')
  for (const input of dependencies) {
    if (paths[input.path] !== `luts/Component-${input.sourceHash}.cube`) fail('a destination LUT path does not match its digest')
  }
  const out = JSON.parse(JSON.stringify(item))
  const visit = value => {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (key === 'lut' && typeof child === 'string' && child) value[key] = paths[child]
      else visit(child)
    }
  }
  visit(out.body)
  if (out.body.resources) out.body.resources = Object.fromEntries(dependencies.map(input => [paths[input.path], out.body.resources[input.path]]))
  validateLibraryItem(out)
  return out
}

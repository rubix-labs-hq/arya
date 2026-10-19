import { readFile, writeFile, mkdir, realpath, lstat } from 'node:fs/promises'
import { resolve, dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const defaultRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const relative = name => typeof name === 'string' && /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('/') && !name.split('/').some(part => !part || part === '.' || part === '..')
async function confinedRead(root, name) {
  if (!relative(name)) throw Error('Invalid public source path')
  const path = join(root, name)
  if (await realpath(path) !== path || !(await lstat(path)).isFile()) throw Error(`Public inputs must be regular files without symlink ancestors: ${name}`)
  return readFile(path)
}
function imports(source) {
  const patterns = [/^\s*(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/gm, /^\s*import\s*['"]([^'"]+)['"]/gm, /\bimport\s*\(\s*['"]([^'"]+)['"]/g]
  return patterns.flatMap(pattern => [...source.matchAll(pattern)].map(match => match[1]))
}
export async function preparePublicOutput({ repoRoot = defaultRoot, outputRoot = join(defaultRoot, 'build/web-public') } = {}) {
  const root = resolve(repoRoot), output = resolve(outputRoot)
  if (await realpath(root) !== root) throw Error('Use a canonical repository root')
  // A new output avoids deleting a previous release or writing through existing links.
  await mkdir(dirname(output), { recursive: true })
  if (await realpath(dirname(output)) !== dirname(output)) throw Error('Output parent must be canonical')
  const files = new Map(), inventory = []
  const add = async (source, target) => {
    if (!relative(target) || files.has(target)) throw Error(`Invalid or duplicate public target: ${target}`)
    const bytes = await confinedRead(root, source)
    files.set(target, bytes); inventory.push({ source, target, bytes: bytes.length, sha256: sha(bytes) })
  }
  const pages = JSON.parse(await confinedRead(root, 'site/public-files.json'))
  if (!Array.isArray(pages) || !pages.length) throw Error('Website allowlist is empty')
  for (const name of pages) {
    if (!relative(name) || !(/^(?:index|404)\.html$/.test(name) || /^(?:download|install|support|privacy|project)\/index\.html$/.test(name) || ['config.json', 'robots.txt'].includes(name) || /^assets\/[A-Za-z0-9._/-]+\.(?:mjs|css|svg|png|jpg|webp|ttf|woff2?|json|txt)$/.test(name))) throw Error(`Unexpected website file: ${name}`)
    await add(`site/${name}`, name)
  }
  const indexing = JSON.parse(files.get('config.json')?.toString('utf8') ?? '{}').indexing === true
  if (indexing) await add('site/sitemap.xml', 'sitemap.xml')
  await add('LICENSE', 'LICENSE.txt')
  await add('THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md')
  const resources = JSON.parse(await confinedRead(root, 'editor/browser-public-files.json'))
  if (!Array.isArray(resources) || !resources.length) throw Error('Browser allowlist is empty')
  for (const { source, target } of resources) {
    if (!relative(source) || !relative(target) || !/^(?:web|core|node_modules)\//.test(source) || !/^(?:editor|core|vendor)\//.test(target) || !(/\.(?:html|js|mjs|css|svg|png|ttf|woff2?|txt)$/.test(target) || /^vendor\/[^/]+\/LICENSE$/.test(target))) throw Error(`Unexpected browser mapping: ${source}`)
    await add(`editor/${source}`, target)
  }
  const bare = { preact: 'vendor/preact/dist/preact.module.js', 'preact/hooks': 'vendor/preact/hooks/dist/hooks.module.js', htm: 'vendor/htm/dist/htm.module.js' }
  for (const [target, bytes] of files) {
    if (!/^(?:editor|core)\/.*\.(?:js|mjs)$/.test(target)) continue
    for (const specifier of imports(bytes.toString('utf8'))) {
      const dependency = bare[specifier] ?? (specifier.startsWith('/') ? specifier.slice(1) : specifier.startsWith('.') ? posix.normalize(posix.join(posix.dirname(target), specifier)) : null)
      if (!dependency || !files.has(dependency)) throw Error(`Unmapped browser import ${specifier} in ${target}`)
    }
  }
  for (const [target, bytes] of files) {
    if (!/\.(?:html|css)$/.test(target)) continue
    const source = bytes.toString('utf8')
    const assets = target.endsWith('.html')
      ? [...source.matchAll(/<(?:script|link|img|source)\b[^>]*?\b(?:src|href|srcset)=["']([^"']+)["']/gi)].map(match => match[1])
      : [...source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)].map(match => match[1])
    for (const asset of assets) {
      if (/^(?:data:|https?:|blob:|#)/.test(asset)) continue
      const dependency = new URL(asset, `https://arya.invalid/${target}`).pathname.slice(1)
      if (!files.has(dependency)) throw Error(`Unmapped asset ${asset} in ${target}`)
    }
  }
  const entry = files.get('editor/index.html')?.toString('utf8')
  if (!entry?.includes('./browser-local/bootstrap.js')) throw Error('The browser-local entry is missing')
  const hashes = [...entry.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(match => !/\bsrc\s*=/.test(match[1]) && match[2].trim()).map(match => `'sha256-${createHash('sha256').update(match[2]).digest('base64')}'`)
  const marketing = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  const editor = `default-src 'self'; script-src 'self' ${hashes.join(' ')}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
  const routes = [
    { src: '/(.*)', headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', ...(indexing ? {} : { 'X-Robots-Tag': 'noindex, nofollow' }), 'Cache-Control': 'no-store', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()' }, continue: true },
    { src: '/((?!editor(?:/|$)).*)', headers: { 'Content-Security-Policy': marketing }, continue: true },
    { src: '/editor(?:/.*)?', headers: { 'Content-Security-Policy': editor, 'X-Robots-Tag': 'noindex, nofollow' }, continue: true },
    { handle: 'filesystem' }, { src: '/.*', dest: '/404.html', status: 404 },
  ]
  await mkdir(output)
  const build = join(output, '.vercel/output')
  for (const [name, bytes] of files) { const target = join(build, 'static', name); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' }) }
  const buildConfig = JSON.stringify({ version: 3, routes }, null, 2) + '\n'
  await writeFile(join(build, 'config.json'), buildConfig, { flag: 'wx' })
  const receipt = { owner: 'arya-public-static-builder-v1', status: 'prepared-not-deployed', buildConfigSHA256: sha(Buffer.from(buildConfig)), fileCount: files.size, fingerprint: sha(Buffer.from(JSON.stringify(inventory))), files: inventory }
  await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' })
  return receipt
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = await preparePublicOutput()
  console.log(JSON.stringify({ status: receipt.status, fileCount: receipt.fileCount, fingerprint: receipt.fingerprint }))
}

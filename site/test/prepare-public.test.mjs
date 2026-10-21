import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preparePublicOutput } from '../scripts/prepare-public.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arya-public-package-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, 'repo'), output = join(root, 'output')
  const put = async (name, value) => { const path = join(repo, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value) }
  await put('LICENSE', 'MIT License\nCopyright (c) 2026 Rubix Labs\n')
  await put('THIRD_PARTY_NOTICES.md', 'Dependency notices\n')
  await put('site/public-files.json', JSON.stringify(['index.html', '404.html']))
  await put('site/index.html', '<h1>Arya</h1>'); await put('site/404.html', '<h1>Page not found</h1>')
  await put('editor/browser-public-files.json', JSON.stringify([
    { source: 'web/browser-local.html', target: 'editor/index.html' },
    { source: 'web/browser-local/bootstrap.js', target: 'editor/browser-local/bootstrap.js' },
    { source: 'core/model.js', target: 'core/model.js' },
  ]))
  await put('editor/web/browser-local.html', '<script type="importmap">{"imports":{}}</script><script type="module" src="./browser-local/bootstrap.js"></script>')
  await put('editor/web/browser-local/bootstrap.js', "import { model } from '/core/model.js'\nconsole.log(model)")
  await put('editor/core/model.js', 'export const model = 1')
  await put('editor/server.mjs', 'private server'); await put('.env', 'private setting')
  return { repo, output, put }
}
test('static package contains only explicit files and separates editor CSP from marketing', async t => {
  const f = await fixture(t), result = await preparePublicOutput({ repoRoot: f.repo, outputRoot: f.output })
  assert.equal(result.fileCount, 7); assert.equal(result.status, 'prepared-not-deployed')
  assert.equal(await readFile(join(f.output, '.vercel/output/static/LICENSE.txt'), 'utf8'), await readFile(join(f.repo, 'LICENSE'), 'utf8'))
  assert.equal(await readFile(join(f.output, '.vercel/output/static/THIRD_PARTY_NOTICES.md'), 'utf8'), await readFile(join(f.repo, 'THIRD_PARTY_NOTICES.md'), 'utf8'))
  const config = JSON.parse(await readFile(join(f.output, '.vercel/output/config.json')))
  assert.equal(config.routes.at(-1).status, 404)
  assert.match(config.routes[2].headers['Content-Security-Policy'], /sha256-/)
  assert.doesNotMatch(config.routes[1].headers['Content-Security-Policy'], /unsafe-inline/)
  for (const path of ['editor/server.mjs', '.env', 'receipt.json']) await assert.rejects(access(join(f.output, '.vercel/output/static', path)))
})
test('search indexing follows the site config and always excludes the editor', async t => {
  const f = await fixture(t)
  const headers = async output => JSON.parse(await readFile(join(output, '.vercel/output/config.json'))).routes
  let routes = (await preparePublicOutput({ repoRoot: f.repo, outputRoot: f.output }), await headers(f.output))
  assert.equal(routes[0].headers['X-Robots-Tag'], 'noindex, nofollow')
  await rm(f.output, { recursive: true })
  await f.put('site/public-files.json', JSON.stringify(['index.html', '404.html', 'config.json']))
  await f.put('site/config.json', JSON.stringify({ indexing: true })); await f.put('site/sitemap.xml', '<urlset></urlset>')
  routes = (await preparePublicOutput({ repoRoot: f.repo, outputRoot: f.output }), await headers(f.output))
  assert.equal(routes[0].headers['X-Robots-Tag'], undefined)
  assert.equal(routes[2].headers['X-Robots-Tag'], 'noindex, nofollow')
  assert.equal(await readFile(join(f.output, '.vercel/output/static/sitemap.xml'), 'utf8'), '<urlset></urlset>')
})
test('an unmapped module or asset refuses packaging before creating output', async t => {
  const f = await fixture(t)
  await f.put('editor/web/browser-local/bootstrap.js', "import '/core/private.js'")
  await assert.rejects(preparePublicOutput({ repoRoot: f.repo, outputRoot: f.output }), /Unmapped browser import/)
  await assert.rejects(access(f.output))
  await f.put('editor/web/browser-local/bootstrap.js', '')
  await f.put('editor/web/browser-local.html', '<script src="./browser-local/bootstrap.js"></script><img src="./missing.png">')
  await assert.rejects(preparePublicOutput({ repoRoot: f.repo, outputRoot: f.output }), /Unmapped asset/)
})
test('traversal and linked inputs cannot enter a public package', async t => {
  const f = await fixture(t)
  await f.put('editor/browser-public-files.json', JSON.stringify([{ source: '../.env', target: 'editor/index.html' }]))
  await assert.rejects(preparePublicOutput({ repoRoot: f.repo, outputRoot: f.output }), /Unexpected browser mapping/)
  await f.put('editor/browser-public-files.json', JSON.stringify([{ source: 'web/browser-local.html', target: 'editor/index.html' }]))
  await rm(join(f.repo, 'editor/web/browser-local.html')); await symlink(join(f.repo, '.env'), join(f.repo, 'editor/web/browser-local.html'))
  await assert.rejects(preparePublicOutput({ repoRoot: f.repo, outputRoot: f.output }), /without symlink/)
})
test('an existing output is preserved instead of overwritten', async t => {
  const f = await fixture(t); await mkdir(f.output); await writeFile(join(f.output, 'keep'), 'preserved')
  await assert.rejects(preparePublicOutput({ repoRoot: f.repo, outputRoot: f.output }), { code: 'EEXIST' })
  assert.equal(await readFile(join(f.output, 'keep'), 'utf8'), 'preserved')
})
test('the current repository packages with complete module and asset mappings', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arya-public-current-')))
  t.after(() => rm(root, { recursive: true, force: true }))
  const result = await preparePublicOutput({ outputRoot: join(root, 'output') })
  assert.ok(result.fileCount > 169); assert.equal(result.files.some(row => row.target === 'editor/index.html'), true)
})

test('the hosted editor loads every stylesheet the local editor loads', async () => {
  const repo = join(import.meta.dirname, '../..')
  const sheets = html => [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="\.?\/([^"]+)"/g)].map(match => match[1])
  const local = sheets(await readFile(join(repo, 'editor/web/index.html'), 'utf8'))
  const hosted = sheets(await readFile(join(repo, 'editor/web/browser-local.html'), 'utf8'))
  const mapped = new Set(JSON.parse(await readFile(join(repo, 'editor/browser-public-files.json'), 'utf8')).map(row => row.target))
  for (const sheet of local) {
    assert.ok(hosted.includes(sheet), `hosted editor does not link ${sheet}`)
    assert.ok(mapped.has(`editor/${sheet}`), `hosted editor does not package ${sheet}`)
  }
})

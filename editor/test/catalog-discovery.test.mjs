import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readCodexCatalog, parseAntigravityModels } from '../agent/catalog-discovery.mjs'

async function fixture(mode) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arya-catalog-test-'))
  const command = path.join(dir, 'fixture-cli'), worker = path.join(dir, 'fixture-worker.cjs'), audit = path.join(dir, 'audit.jsonl')
  await fs.writeFile(worker, `#!${process.execPath}\n`+String.raw`
const fs = require('node:fs'), readline = require('node:readline')
const mode = process.env.ARYA_FIXTURE_MODE
if (process.argv[2] === 'login') { console.error(mode === 'api-login' ? 'Logged in using an API key' : 'Logged in using ChatGPT'); process.exit(0) }
readline.createInterface({ input: process.stdin }).on('line', line => {
  const input = JSON.parse(line)
  fs.appendFileSync(process.env.ARYA_FIXTURE_AUDIT, JSON.stringify(input)+'\n')
  if (mode === 'timeout') return
  if (input.method === 'initialized') return
  let result = {}
  if (input.method === 'model/list') {
    if (mode === 'bad-json') { process.stdout.write('unreadable\n'); return }
    if (mode === 'oversized') { process.stdout.write('x'.repeat(1024*1024+1)); return }
    if (mode === 'repeat-cursor') result = { data: [], nextCursor: 'repeated' }
    else result = { data: [{ model: input.params.cursor ? 'fixture-two' : 'fixture-one', displayName: 'Vidéo 🎬', description: 'Fast and efficient', supportedReasoningEfforts: [], inputModalities: ['text','image'] }], nextCursor: input.params.cursor ? null : 'next' }
  }
  const response = Buffer.from(JSON.stringify({ id: input.id, result })+'\n')
  if (mode === 'unicode') { for (let i=0;i<response.length;i++) process.stdout.write(response.subarray(i,i+1)) }
  else process.stdout.write(response)
})
`, { mode: 0o700 })
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  await fs.writeFile(command, `#!/bin/sh
if [ "$1" = login ]; then
  if [ "$ARYA_FIXTURE_MODE" = api-login ]; then
    printf '%s\\n' 'Logged in using an API key' >&2
  else
    printf '%s\\n' 'Logged in using ChatGPT' >&2
  fi
  exit 0
fi
exec ${quote(process.execPath)} ${quote(worker)} "$@"
`, { mode: 0o700 })
  return { command, audit, dir, env: { ...process.env, ARYA_FIXTURE_MODE: mode, ARYA_FIXTURE_AUDIT: audit } }
}

for (const mode of ['normal', 'unicode']) test(`metadata discovery handles complete pagination (${mode}) without any inference method`, async () => {
  const f = await fixture(mode)
  try {
    const result = await readCodexCatalog({ executable: f.command, env: f.env, timeoutMs: 2000 })
    assert.deepEqual(result.models.map(row => row.id), ['fixture-one', 'fixture-two'])
    assert.equal(result.models[0].name, 'Vidéo 🎬')
    const calls = (await fs.readFile(f.audit, 'utf8')).trim().split('\n').map(JSON.parse)
    assert.deepEqual(calls.map(row => row.method), ['initialize', 'initialized', 'model/list', 'model/list'])
    assert.equal(calls[2].params.includeHidden, false)
  } finally { await fs.rm(f.dir, { recursive: true, force: true }) }
})

for (const [mode, pattern] of [['repeat-cursor', /repeated model cursor/], ['bad-json', /unreadable/], ['oversized', /1 MiB/], ['timeout', /timed out/]]) test(`discovery fails closed on ${mode} instead of enabling a partial catalog`, async () => {
  const f = await fixture(mode)
  try { await assert.rejects(readCodexCatalog({ executable: f.command, env: f.env, timeoutMs: mode === 'timeout' ? 400 : 2000 }), pattern) }
  finally { await fs.rm(f.dir, { recursive: true, force: true }) }
})

test('API-key login never reaches the metadata app server in a subscription probe', async () => {
  const f = await fixture('api-login')
  try {
    await assert.rejects(readCodexCatalog({ executable: f.command, env: f.env, timeoutMs: 2000 }), /ChatGPT subscription sign-in/)
    await assert.rejects(fs.access(f.audit))
  } finally { await fs.rm(f.dir, { recursive: true, force: true }) }
})

test('Antigravity parser keeps exact tab-separated slugs and does not invent capabilities from labels', () => {
  const rows = parseAntigravityModels('Fetching available models...\nfixture-one\tModel (High)\nnot a model line\n')
  assert.deepEqual(rows, [{ id: 'fixture-one', displayName: 'Model (High)' }])
  assert.throws(() => parseAntigravityModels('x'.repeat(64*1024+1)), /limit/)
})

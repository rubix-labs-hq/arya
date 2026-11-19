// A server started without USER in its environment (a launch agent, `env -i`, some terminals'
// task runners) made Claude Code report loggedIn:false, and Arya showed the account as signed out.
// Seen on 2026-11-17: `env -i HOME=... PATH=... claude auth status --json` gives loggedIn false,
// and adding USER alone gives loggedIn true.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ensureIdentityEnv } from '../core/process-identity.mjs'

const editor = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const account = () => ({ username: 'sam', homedir: '/Users/sam' })

test('missing or empty USER, LOGNAME and HOME are filled from the account that runs the process', () => {
  assert.deepEqual(ensureIdentityEnv({ PATH: '/bin' }, account), { PATH: '/bin', USER: 'sam', LOGNAME: 'sam', HOME: '/Users/sam' })
  assert.deepEqual(ensureIdentityEnv({ USER: '', LOGNAME: '', HOME: '' }, account), { USER: 'sam', LOGNAME: 'sam', HOME: '/Users/sam' })
})

test('values that are already set are kept, and the account is not read when nothing is missing', () => {
  const env = { USER: 'alex', LOGNAME: 'alex-login', HOME: '/custom/home' }
  assert.deepEqual(ensureIdentityEnv(env, () => assert.fail('the account must not be read')), { USER: 'alex', LOGNAME: 'alex-login', HOME: '/custom/home' })
  assert.deepEqual(ensureIdentityEnv({ USER: 'alex', HOME: '/custom/home' }, account), { USER: 'alex', HOME: '/custom/home', LOGNAME: 'sam' })
})

test('an account that cannot be read, or has unusable fields, changes nothing', () => {
  assert.deepEqual(ensureIdentityEnv({ PATH: '/bin' }, () => { throw new Error('no passwd entry') }), { PATH: '/bin' })
  assert.deepEqual(ensureIdentityEnv({}, () => ({ username: '', homedir: 'relative/home' })), {})
  assert.deepEqual(ensureIdentityEnv({}, () => ({ username: 'a\0b', homedir: null })), {})
})

test('the server fills its environment before any other module loads', () => {
  const server = fs.readFileSync(path.join(editor, 'server.mjs'), 'utf8')
  const first = server.split('\n').find(line => line.startsWith('import '))
  assert.equal(first, "import {} from './core/process-identity.mjs'")
})

test('a CLI that reports signed in only when USER is set is seen as signed in from a process started without USER', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-identity-')), bin = path.join(root, 'bin')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(bin)
  // What Claude Code 2.1.326 does: no USER, no stored login found.
  fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}\nconst ok=Boolean(process.env.USER);console.log(JSON.stringify(ok?{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}:{loggedIn:false,authMethod:'none'}));process.exit(ok?0:1)\n`, { mode: 0o700 })
  const status = load => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `${load}const { providerStatus } = await import(${JSON.stringify(path.join(editor, 'agent/adapters.mjs'))});console.log(JSON.stringify((await providerStatus()).find(row => row.id === 'claude-code')))`], { env: { PATH: bin }, encoding: 'utf8' }))
  assert.equal(status('').authenticated, false, 'without the fix the account reads as signed out')
  assert.equal(status(`await import(${JSON.stringify(path.join(editor, 'core/process-identity.mjs'))});`).authenticated, true)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { CHAT_HISTORY_LIMITS, createChatHistory } from '../agent/chat-history.mjs'

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-chat-history-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
const historyFile = root => path.join(root, '.reel', 'assistant-chat.json')
const row = (text, extra = {}) => ({ role: 'user', text, refs: [{ kind: 'track', id: 'A3', label: 'Music track' }], at: 1791082561003, ...extra })
const diagnostics = () => { const values = []; return { values, diagnostic: value => values.push(value) } }

test('roundtrip restores only display messages; projection omits config, run data and contextual secrets', t => {
  const root = temporary(t), history = createChatHistory({ root })
  const seeded = history.replace([
    row('Create a score.', { refs: [{ kind: 'track', id: 'A3', label: 'Music track', context: { token: 'do-not-store', project: { a: 1 } } }], token: 'do-not-store', endpoint: 'private', routing: { model: 'private-config' }, state: 'working' }),
    { role: 'claude', text: 'A score is ready.', at: 1791082584932, provider: 'codex', error: false, providerConfig: { credential: 'do-not-store' } },
  ])
  const restored = createChatHistory({ root })
  assert.deepEqual(restored.messages(), seeded)
  assert.deepEqual(restored.status(), { restored: 2, warning: null, savingAvailable: true })
  const saved = fs.readFileSync(historyFile(root), 'utf8')
  assert.equal(/do-not-store|private-config|providerConfig|routing|working|endpoint|token/.test(saved), false)
  assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['messages', 'version'])
  assert.equal(fs.statSync(historyFile(root)).mode & 0o777, 0o600)
  assert.equal(fs.readdirSync(path.dirname(historyFile(root))).some(name => name.includes('.part.')), false)
  const detached = restored.messages(); detached[0].text = 'changed'; detached[0].refs[0].label = 'changed'
  assert.equal(restored.messages()[0].text, 'Create a score.')
})

test('append redacts recognizable credentials without exposing them in logs or storing configuration', t => {
  const root = temporary(t), log = diagnostics(), history = createChatHistory({ root, diagnostic: log.diagnostic })
  history.append(row('sk-ant-abcdefghijklmnopqrstuvwxyz Bearer abcdefghijklmnopqrstuvwxyz0123456789'))
  const bytes = fs.readFileSync(historyFile(root), 'utf8')
  assert.equal(bytes.includes('sk-ant-'), false); assert.equal(bytes.includes('Bearer '), false)
  assert.match(history.messages()[0].text, /redacted/)
  assert.deepEqual(log.values, [])
})

test('projects are isolated and restarts never expose another project history', t => {
  const first = temporary(t), second = temporary(t)
  createChatHistory({ root: first }).append(row('First project only.'))
  assert.deepEqual(createChatHistory({ root: second }).messages(), [])
  createChatHistory({ root: second }).append(row('Second project only.'))
  assert.equal(createChatHistory({ root: first }).messages()[0].text, 'First project only.')
})

test('message count and encoded-byte limits evict oldest rows and retain recent complete messages', t => {
  const root = temporary(t), history = createChatHistory({ root })
  history.replace(Array.from({ length: 250 }, (_, index) => row(`Message ${index}`)))
  assert.equal(history.messages().length, 200); assert.equal(history.messages()[0].text, 'Message 50')
  history.replace(Array.from({ length: 4 }, (_, index) => row(`${index}:` + 'a'.repeat(650000))))
  assert.equal(history.messages().length, 3); assert.ok(history.messages()[0].text.startsWith('1:'))
  assert.ok(fs.statSync(historyFile(root)).size <= CHAT_HISTORY_LIMITS.bytes)
  assert.deepEqual(createChatHistory({ root }).messages(), history.messages())
  const before = fs.readFileSync(historyFile(root))
  assert.throws(() => history.append(row('\n'.repeat(CHAT_HISTORY_LIMITS.bytes))), /CHAT_HISTORY_SIZE/)
  assert.deepEqual(fs.readFileSync(historyFile(root)), before)
})

for (const [label, value] of [
  ['invalid JSON', '{"credential":"must-not-log",'],
  ['unsupported envelope', JSON.stringify({ version: 2, messages: [] })],
  ['invalid message', JSON.stringify({ version: 1, messages: [row('Keep', { role: 'system' })] })],
  ['nested configuration in saved rows', JSON.stringify({ version: 1, messages: [row('Keep', { providerConfig: { key: 'must-not-log' } })] })],
  ['excess message count', JSON.stringify({ version: 1, messages: Array.from({ length: 201 }, () => row('Keep')) })],
  ['oversize file', 'x'.repeat(CHAT_HISTORY_LIMITS.bytes + 1)],
]) {
  test(`unreadable ${label} is disclosed and never overwritten or deleted`, t => {
    const root = temporary(t), file = historyFile(root), log = diagnostics()
    fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, value)
    const history = createChatHistory({ root, diagnostic: log.diagnostic })
    assert.deepEqual(history.messages(), []); assert.equal(history.status().savingAvailable, false)
    assert.match(history.status().warning, /existing file is unchanged/)
    assert.ok(log.values.length); assert.equal(log.values.join('').includes('must-not-log'), false)
    history.append(row('Visible in this session.'))
    assert.equal(history.messages()[0].text, 'Visible in this session.')
    assert.equal(fs.readFileSync(file, 'utf8'), value)
  })
}

for (const kind of ['directory', 'file', 'hardlink']) {
  test(`unsafe ${kind} cannot read or replace external history`, t => {
    const root = temporary(t), other = temporary(t), target = path.join(other, 'assistant-chat.json'), file = historyFile(root), log = diagnostics()
    const sentinel = JSON.stringify({ version: 1, messages: [row('Private outside project.')] })
    fs.writeFileSync(target, sentinel)
    if (kind === 'directory') fs.symlinkSync(other, path.join(root, '.reel'))
    else { fs.mkdirSync(path.dirname(file)); if (kind === 'file') fs.symlinkSync(target, file); else fs.linkSync(target, file) }
    const history = createChatHistory({ root, diagnostic: log.diagnostic })
    assert.deepEqual(history.messages(), []); assert.equal(history.status().savingAvailable, false)
    history.append(row('Public session.'))
    assert.equal(fs.readFileSync(target, 'utf8'), sentinel)
    assert.match(history.status().warning, /existing file is unchanged/)
  })
}

test('a parent symlink introduced after load cannot redirect a later save', t => {
  const root = temporary(t), other = temporary(t), history = createChatHistory({ root })
  const sentinel = path.join(other, 'keep.txt'); fs.writeFileSync(sentinel, 'untouched')
  fs.symlinkSync(other, path.join(root, '.reel'))
  history.append(row('Session continues without writing through the link.'))
  assert.deepEqual(fs.readdirSync(other), ['keep.txt'])
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched')
  assert.match(history.status().warning, /could not be saved/)
})

test('concurrent owner and corrupted replacement cannot be silently overwritten', t => {
  const root = temporary(t), first = createChatHistory({ root }), stale = createChatHistory({ root })
  first.append(row('Saved by first owner.'))
  const before = fs.readFileSync(historyFile(root))
  stale.append(row('Stale in-memory owner.'))
  assert.match(stale.status().warning, /could not be saved/)
  assert.deepEqual(fs.readFileSync(historyFile(root)), before)
  fs.writeFileSync(historyFile(root), 'corrupt replacement')
  first.append(row('Session continues.'))
  assert.equal(fs.readFileSync(historyFile(root), 'utf8'), 'corrupt replacement')
  assert.match(first.status().warning, /could not be saved/)
})

test('rename failure preserves the saved file and removes only its owned temporary output', t => {
  const root = temporary(t), history = createChatHistory({ root }); history.append(row('Saved before failure.'))
  const before = fs.readFileSync(historyFile(root)), rename = fs.renameSync
  fs.renameSync = () => { throw Object.assign(new Error('fixture rename failure'), { code: 'EACCES' }) }
  try { history.append(row('New session message.')) } finally { fs.renameSync = rename }
  assert.deepEqual(fs.readFileSync(historyFile(root)), before)
  assert.match(history.status().warning, /could not be saved/)
  assert.deepEqual(fs.readdirSync(path.dirname(historyFile(root))), ['assistant-chat.json'])
})

async function startServer(t, root) {
  const listener = net.createServer(); await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve))
  const server = fileURLToPath(new URL('../server.mjs', import.meta.url))
  const child = spawn(process.execPath, [server, '--root', root, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
  let stopped = false
  const stop = async () => {
    if (stopped || child.exitCode !== null || child.signalCode !== null) return
    stopped = true
    const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exit
  }
  t.after(stop)
  const base = `http://127.0.0.1:${port}`
  const api = async (method, route, body) => {
    const response = await fetch(base + route, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  for (let index = 0; index < 200; index++) {
    if (child.exitCode !== null || child.signalCode !== null) assert.fail(output)
    try { if ((await api('GET', '/api/state')).status === 200) return { api, stop, output: () => output } } catch {}
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await stop(); assert.fail('Fixture server startup timed out: ' + output)
}

function projectRoot(t) {
  const root = temporary(t)
  fs.writeFileSync(path.join(root, 'reel.project.json'), JSON.stringify({ v: 3, name: 'Chat recovery fixture', width: 1920, height: 1080, fps: 24, duration: 0, assets: {}, tracks: [], markers: [] }))
  return root
}

test('actual server restart restores display chat with idle state and an empty plugin queue', async t => {
  const root = projectRoot(t)
  createChatHistory({ root }).append({ role: 'user', text: 'Create music.', refs: [{ kind: 'track', id: 'A3', label: 'Music' }], at: Date.now() })
  const first = await startServer(t, root)
  assert.equal((await first.api('POST', '/api/bridge/send', { mode: 'plugin', text: 'Create music.', refs: [{ kind: 'track', id: 'A3', label: 'Music' }] })).status, 403)
  assert.equal((await first.api('POST', '/api/bridge/claude', { state: 'done', reply: 'A native score exists.' })).status, 200)
  assert.equal((await first.api('POST', '/api/bridge/send', { mode: 'plugin', text: 'Interrupted request.' })).status, 403)
  assert.equal((await first.api('POST', '/api/bridge/claude', { state: 'working', text: 'Working before restart.', reply: 'Interrupted request.' })).status, 200)
  const before = (await first.api('GET', '/api/project')).body
  assert.equal(before.chat.length, 3); assert.equal(before.claude.state, 'working')
  await first.stop()
  const second = await startServer(t, root), after = (await second.api('GET', '/api/project')).body
  assert.deepEqual(after.chat, before.chat)
  assert.deepEqual(after.claude, { state: 'idle', text: '' })
  assert.equal(after.chatHistory.restored, 3); assert.equal(after.chatHistory.warning, null)
  assert.equal((await second.api('GET', '/api/bridge/poll')).status, 403)
  const state = (await second.api('GET', '/api/state')).body
  assert.equal(state.assistant.state, 'idle'); assert.equal(state.assistant.runId, null)
  assert.equal(state.chatHistory.restored, 3)
  await second.stop()
})

test('actual server discloses unreadable history and leaves it intact through a new display message', async t => {
  const root = projectRoot(t), file = historyFile(root)
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'not valid history')
  const server = await startServer(t, root)
  const before = (await server.api('GET', '/api/project')).body
  assert.deepEqual(before.chat, []); assert.match(before.chatHistory.warning, /could not be read/)
  assert.equal((await server.api('POST', '/api/bridge/send', { mode: 'plugin', text: 'Still editable.' })).status, 403)
  assert.deepEqual((await server.api('GET', '/api/project')).body.chat, [])
  assert.equal((await server.api('POST', '/api/bridge/claude', { reply: 'Display recovery still works.' })).status, 200)
  assert.equal((await server.api('GET', '/api/project')).body.chat[0].text, 'Display recovery still works.')
  assert.equal(fs.readFileSync(file, 'utf8'), 'not valid history')
  assert.match(server.output(), /Assistant chat history read failed/)
  await server.stop()
})

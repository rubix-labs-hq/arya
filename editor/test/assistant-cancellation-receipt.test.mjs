import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { fixtureAccounts, fixtureSharing } from './fixtures/sharing-fixture.mjs'

const source = process.env.ARYA_CANCELLATION_SERVICE ? pathToFileURL(process.env.ARYA_CANCELLATION_SERVICE) : new URL('../agent/browser-assistant.mjs', import.meta.url)
const { createBrowserAssistant } = await import(source)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const until = async predicate => { for (let i = 0; i < 200; i++) { const result = await predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)) }; assert.fail('Cancellation fixture did not reach its expected state.') }
const receipt = (kind, id) => kind === 'missing' ? {} : kind === 'false' ? { id, cancelled: false } : kind === 'wrong-id' ? { id: 'another-owned-run', cancelled: true } : { id, cancelled: true }

async function fixture(t, { delayed = false, response = 'valid', close = 'failed', tool = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arya-cancellation-receipt-'))
  const arrived = deferred(), release = deferred(), enteredTool = deferred(), releaseTool = deferred()
  const observed = { cancellations: 0, closes: 0, replies: 0, tools: 0, emitted: false, admitted: false }
  const listener = http.createServer(async (request, responseStream) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const reply = (status, value) => { if (responseStream.destroyed) return; responseStream.writeHead(status, { 'content-type': 'application/json' }); responseStream.end(JSON.stringify(value)) }
    if (request.url === '/v1/runs') {
      const body = JSON.parse(Buffer.concat(chunks)); observed.id = body.id; arrived.resolve()
      if (delayed) await release.promise
      observed.admitted = true; return reply(201, { id: body.id })
    }
    if (request.url.endsWith('/cancel')) {
      observed.cancellations++
      if (!observed.admitted) return reply(404, { error: 'Run not yet admitted' })
      return reply(200, receipt(response, request.url.split('/')[3]))
    }
    if (request.url.includes('/tools/')) { observed.replies++; return reply(200, { accepted: true }) }
    if (tool && !observed.emitted) { observed.emitted = true; return reply(200, { events: [{ seq: 1, type: 'tool', callID: 'project-content', method: 'GET', path: '/api/project' }] }) }
    return reply(200, { events: [] })
  })
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const shutdown = async () => { if (listener.listening) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)) } }
  const endpoint = `http://127.0.0.1:${listener.address().port}/`
  const service = createBrowserAssistant({ root, providerStatus: fixtureAccounts, getIdentity: () => 1, getOutline: () => ({ version: 1, outline: 'Synthetic fixture content only.' }), cleanupTimeoutMs: 30,
    startBridge: async () => ({ endpoint, token: 'inert-cancellation-fixture', close: async () => {
      observed.closes++
      if (close === 'failed') throw new Error('Fixture owner shutdown cannot be confirmed')
      if (close === 'bounded') await new Promise(() => {})
      await shutdown()
    } }),
    dispatch: async () => { observed.tools++; enteredTool.resolve(); await releaseTool.promise; return { syntheticPrivateResult: true } },
  })
  t.after(async () => { release.resolve(); releaseTool.resolve(); await service.close(); await shutdown(); fs.rmSync(root, { recursive: true, force: true }) })
  const review = await service.sharing()
  const granted = await service.grantSharing({ reviewID: review.reviewID, sharing: fixtureSharing(review.scope.companion, review.scope.models) })
  return { service, sharing: granted.sharing, observed, arrived, release, enteredTool, releaseTool, listener }
}

for (const delayed of [false, true]) {
  test(`${delayed ? 'post-submission retry' : 'initial cancel'} requires matching run ID and cancelled true`, async t => {
    for (const response of ['missing', 'false', 'wrong-id', 'valid']) await t.test(response, async child => {
      const current = await fixture(child, { delayed, response }), { service, observed } = current
      let sending
      if (delayed) {
        sending = service.send({ text: 'Synthetic delayed request', sharing: current.sharing }).catch(error => error)
        await current.arrived.promise
      } else await service.send({ text: 'Synthetic request', sharing: current.sharing })
      const stopping = service.cancel()
      if (delayed) {
        await until(() => observed.cancellations === 1)
        assert.equal(service.snapshot().state, 'cancelling')
        await assert.rejects(service.send({ text: 'Second request', sharing: current.sharing }), /still working/)
        current.release.resolve()
      }
      const result = await stopping
      if (sending) assert.ok(await sending instanceof Error)
      assert.equal(observed.cancellations, delayed ? 2 : 1)
      assert.equal(result.runId, observed.id)
      if (response === 'valid') {
        assert.equal(result.cancelled, true); assert.equal(result.stopUnconfirmed, false); assert.equal(observed.closes, 0)
        assert.equal(service.snapshot().state, 'cancelled')
      } else {
        assert.equal(result.cancelled, false); assert.equal(result.stopUnconfirmed, true); assert.equal(observed.closes, 1)
        assert.equal(service.snapshot().state, 'error')
        await assert.rejects(service.send({ text: 'Unsafe next request', sharing: current.sharing }), /still working/)
      }
    })
  })
}

test('missing cancellation acknowledgement closes the exact owned listener without claiming receipt confirmation', async t => {
  const current = await fixture(t, { response: 'missing', close: 'successful' })
  await current.service.send({ text: 'Synthetic request', sharing: current.sharing })
  const result = await current.service.cancel()
  assert.equal(result.cancelled, false); assert.equal(result.stopUnconfirmed, true)
  assert.equal(current.observed.closes, 1); assert.equal(current.listener.listening, false)
  assert.equal(current.service.snapshot().state, 'error')
})

test('an invalid delayed acknowledgement retains admission when owned shutdown exceeds its bound', async t => {
  const current = await fixture(t, { delayed: true, response: 'wrong-id', close: 'bounded' })
  const sending = current.service.send({ text: 'Synthetic request', sharing: current.sharing }).catch(error => error)
  await current.arrived.promise
  const stopping = current.service.cancel()
  await until(() => current.observed.cancellations === 1); current.release.resolve()
  const result = await stopping
  assert.ok(await sending instanceof Error)
  assert.equal(result.cancelled, false); assert.equal(result.stopUnconfirmed, true); assert.equal(current.observed.closes, 1)
  await assert.rejects(current.service.send({ text: 'Unsafe request', sharing: current.sharing }), /still working/)
  assert.match(current.service.snapshot().text, /shutdown could not be confirmed/)
})

test('withdrawal with an invalid receipt still blocks a pending private tool result', async t => {
  const current = await fixture(t, { response: 'missing', tool: true })
  await current.service.send({ text: 'Synthetic inspection', sharing: current.sharing })
  await current.enteredTool.promise
  const revoked = await current.service.revokeSharing()
  assert.equal(revoked.approved, false); assert.equal(revoked.revoked, true); assert.equal(revoked.stopUnconfirmed, true); assert.equal(revoked.cancelled, false)
  current.releaseTool.resolve()
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(current.observed.tools, 1); assert.equal(current.observed.replies, 0)
  await assert.rejects(current.service.send({ text: 'Unsafe next request', sharing: current.sharing }), /still working/)
})

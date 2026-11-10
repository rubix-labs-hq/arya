'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const Stripe = require('stripe');
const { createHandler } = require(process.env.ARYA_TIP_HANDLER_PATH || './webhook.cjs');
const stripe = new Stripe('test-signature-only');
const secret = 'test-local-signing-secret';

async function fixture(fn, options = {}) {
  const logs = [];
  const server = createServer(createHandler({ secret, liveMode: true, log: line => logs.push(line), ...options }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}/`, logs); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function event(type = 'checkout.session.completed', paymentStatus = 'paid', overrides = {}) {
  return { id: 'evt_test', livemode: true, type, data: { object: {
    payment_status: paymentStatus, metadata: { app: 'arya', purpose: 'optional_tip' },
    customer_details: { email: 'private-payer@example.invalid', address: { line1: 'PRIVATE ADDRESS' } },
  } }, ...overrides };
}
async function send(url, value, options = {}) {
  const body = JSON.stringify(value);
  const signature = stripe.webhooks.generateTestHeaderString({ payload: body, secret,
    ...(options.timestamp ? { timestamp: options.timestamp } : {}) });
  return fetch(url, { method: 'POST', headers: { 'stripe-signature': signature }, body, ...options.request });
}

test('paid and asynchronous outcomes are distinct and never disclose payer details', async () => {
  await fixture(async (url, logs) => {
    for (const [type, status, expected] of [
      ['checkout.session.completed', 'unpaid', 'pending'],
      ['checkout.session.async_payment_succeeded', 'paid', 'paid'],
      ['checkout.session.async_payment_failed', 'unpaid', 'failed'],
    ]) {
      const result = await send(url, event(type, status));
      assert.equal(result.status, 200);
      assert.equal(JSON.parse(logs.at(-1)).outcome, expected);
    }
    assert.ok(!logs.join('').includes('private-payer'));
    assert.ok(!logs.join('').includes('PRIVATE ADDRESS'));
  });
});

test('unsigned, changed, expired and wrong-mode events cannot produce a paid outcome', async () => {
  await fixture(async (url, logs) => {
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 400);
    assert.equal((await send(url, event(), { request: { body: '{}' } })).status, 400);
    assert.equal((await send(url, event(), { timestamp: Math.floor(Date.now() / 1000) - 600 })).status, 400);
    assert.equal((await send(url, event(undefined, undefined, { livemode: false }))).status, 400);
    assert.equal(logs.length, 0);
  });
});

test('unrelated merchant events are ignored; replay has no fulfillment side effects', async () => {
  await fixture(async (url, logs) => {
    const other = event(); other.data.object.metadata.app = 'another-product';
    assert.equal((await send(url, other)).status, 200);
    assert.equal(logs.length, 0);
    assert.equal((await send(url, event())).status, 200);
    assert.equal((await send(url, event())).status, 200);
    assert.deepEqual(logs.map(JSON.parse), [
      { event: 'arya_tip', eventId: 'evt_test', outcome: 'paid' },
      { event: 'arya_tip', eventId: 'evt_test', outcome: 'paid' },
    ]);
  });
});

test('missing configuration, unsupported methods and oversized bodies fail safely', async () => {
  await fixture(async url => assert.equal((await send(url, event())).status, 503), { secret: undefined });
  await fixture(async (url, logs) => {
    const get = await fetch(url); assert.equal(get.status, 405); assert.equal(get.headers.get('allow'), 'POST');
    assert.equal((await fetch(url, { method: 'POST', headers: { 'stripe-signature': 'bad' }, body: 'x'.repeat(512 * 1024 + 1) })).status, 413);
    assert.equal(logs.length, 0);
  });
});

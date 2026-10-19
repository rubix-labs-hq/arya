import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createFigmaBroker } from '../services/figma-oauth-broker.mjs';

const random = () => randomBytes(32).toString('base64url');
const challenge = value => createHash('sha256').update(value).digest('base64url');
async function fixture(t, options = {}) {
  const calls = [], clock = { value: Date.now() };
  const broker = createFigmaBroker({ publicURL: 'https://auth.reel.test', clientID: 'public-app', clientSecret: 'server-only-secret', encryptionKey: Buffer.alloc(32, 7).toString('base64'), now: () => clock.value,
    fetch: async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ access_token: 'private-access', refresh_token: 'provider-refresh', expires_in: 3600 })); }, ...options });
  const server = createServer(broker.handle); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const send = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method: body === undefined ? 'GET' : 'POST', headers: { Host: 'auth.reel.test', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
    }); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { broker, calls, clock, send };
}
async function authorize(f, verifier = random() + random()) {
  const state = random(), start = await f.send('/v1/figma/start', { state, challenge: challenge(verifier) });
  assert.equal(start.status, 200);
  const url = new URL(JSON.parse(start.text).authorizationURL);
  const callback = await f.send(`/v1/figma/callback?state=${url.searchParams.get('state')}&code=valid-code`);
  assert.equal(callback.status, 302);
  const native = new URL(callback.headers.location);
  return { state, verifier, url, native, ticket: native.searchParams.get('ticket') };
}

test('Figma broker exchanges browser authorization for a device-bound ticket and sealed refresh handle', async t => {
  const f = await fixture(t), auth = await authorize(f);
  assert.equal(auth.url.origin, 'https://www.figma.com');
  assert.equal(auth.url.searchParams.get('scope'), 'current_user:read,file_content:read');
  assert.equal(auth.url.searchParams.get('redirect_uri'), f.broker.redirectURI);
  assert.equal(auth.native.searchParams.get('state'), auth.state);
  assert.equal(auth.native.protocol, 'reelfigma:');
  assert(!auth.native.href.includes('private-access')); assert(!auth.native.href.includes('provider-refresh'));
  const wrong = await f.send('/v1/figma/exchange', { ticket: auth.ticket, verifier: random() }); assert.equal(wrong.status, 401);
  const exchanged = await f.send('/v1/figma/exchange', { ticket: auth.ticket, verifier: auth.verifier }); assert.equal(exchanged.status, 200);
  const credentials = JSON.parse(exchanged.text); assert.equal(credentials.access_token, 'private-access');
  assert(!credentials.refresh_token.includes('provider-refresh')); assert(!exchanged.text.includes('server-only-secret'));
  const renewed = await f.send('/v1/figma/refresh', { refresh_token: credentials.refresh_token }); assert.equal(renewed.status, 200);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].url, 'https://api.figma.com/v1/oauth/token');
  assert.equal(f.calls[0].init.body.get('code_challenge_method'), null);
  assert.equal(challenge(f.calls[0].init.body.get('code_verifier')), auth.url.searchParams.get('code_challenge'));
  assert.equal(f.calls[1].init.body.get('grant_type'), 'refresh_token'); assert.equal(f.calls[1].init.body.get('refresh_token'), 'provider-refresh');
  assert.equal((await f.send('/v1/figma/exchange', { ticket: auth.ticket, verifier: auth.verifier })).status, 401);
  assert.equal((await f.send(`/v1/figma/callback?state=${auth.url.searchParams.get('state')}&code=valid-code`)).status, 400);
});

test('Figma broker rejects expired, tampered, cross-origin and injected sign-in requests without contacting Figma', async t => {
  const f = await fixture(t);
  assert.equal((await f.send('/v1/figma/start', { state: random(), challenge: random(), redirect: 'https://attacker.test' })).status, 400);
  assert.equal((await f.send('/v1/figma/status', undefined, { Origin: 'https://attacker.test' })).status, 403);
  assert.equal((await f.send('/v1/figma/status', undefined, { Host: 'attacker.test' })).status, 403);
  assert.equal((await f.send('/v1/figma/refresh', { refresh_token: random() })).status, 401);
  const state = random(), start = await f.send('/v1/figma/start', { state, challenge: random() });
  const providerState = new URL(JSON.parse(start.text).authorizationURL).searchParams.get('state');
  assert.equal((await f.send(`/v1/figma/callback?state=${providerState}&state=${providerState}&code=test`)).status, 400);
  f.clock.value += 600001;
  assert.equal((await f.send(`/v1/figma/callback?state=${providerState}&code=test`)).status, 400);
  assert.equal(f.calls.length, 0);
});

test('Figma broker bounds outstanding sessions and redacts provider failures', async t => {
  const f = await fixture(t, { capacity: 1, fetch: async () => new Response('server-only-secret private-access', { status: 401 }) });
  const first = await f.send('/v1/figma/start', { state: random(), challenge: random() }); assert.equal(first.status, 200);
  assert.equal((await f.send('/v1/figma/start', { state: random(), challenge: random() })).status, 503);
  const url = new URL(JSON.parse(first.text).authorizationURL);
  const failed = await f.send(`/v1/figma/callback?state=${url.searchParams.get('state')}&code=valid-code`);
  assert.equal(failed.status, 401); assert(!failed.text.includes('secret')); assert(!failed.text.includes('private-access'));
  assert.equal(failed.headers['cache-control'], 'no-store'); assert.equal(failed.headers['referrer-policy'], 'no-referrer');
});

test('Figma broker expires transfer tickets and rejects altered refresh handles', async t => {
  const f = await fixture(t), auth = await authorize(f);
  f.clock.value += 120001;
  assert.equal((await f.send('/v1/figma/exchange', { ticket: auth.ticket, verifier: auth.verifier })).status, 401);
  const second = await authorize(f);
  const credentials = JSON.parse((await f.send('/v1/figma/exchange', { ticket: second.ticket, verifier: second.verifier })).text);
  const altered = credentials.refresh_token.slice(0, 20) + (credentials.refresh_token[20] === 'A' ? 'B' : 'A') + credentials.refresh_token.slice(21);
  assert.equal((await f.send('/v1/figma/refresh', { refresh_token: altered })).status, 401);
  assert.equal(f.calls.length, 2);
});

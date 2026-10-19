import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const random = () => randomBytes(32).toString('base64url');
const sha = value => createHash('sha256').update(value).digest('base64url');
const valid = (value, min = 43, max = 128) => typeof value === 'string' && value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
class Failure extends Error { constructor(status, message) { super(message); this.status = status; } }

// Deploy behind HTTPS. Secrets and refresh credentials never enter the app bundle.
export function createFigmaBroker({ publicURL, clientID, clientSecret, encryptionKey, fetch: providerFetch = globalThis.fetch, now = Date.now, capacity = 2000 }) {
  const base = new URL(publicURL);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/' || (base.port && base.port !== '443')) throw new Error('Figma broker needs an HTTPS origin.');
  if (typeof clientID !== 'string' || !clientID || clientID.length > 256 || typeof clientSecret !== 'string' || !clientSecret || clientSecret.length > 512) throw new Error('Configure the Figma OAuth app credentials.');
  const key = Buffer.from(encryptionKey ?? '', 'base64');
  if (key.length !== 32) throw new Error('FIGMA_BROKER_KEY must contain a base64 encoded 32 byte key.');
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2000) throw new Error('Invalid broker session capacity.');
  const redirect = new URL('/v1/figma/callback', base).href;
  const pending = new Map(), tickets = new Map(), refreshes = new Map();
  let active = 0, windowStart = now(), requests = 0;
  const scopes = 'current_user:read,file_content:read';
  const prune = () => { for (const map of [pending, tickets]) for (const [id, value] of map) if (value.expires <= now()) map.delete(id); };
  const room = () => { prune(); if (pending.size + tickets.size >= capacity) throw new Failure(503, 'Figma sign-in is busy. Try again shortly.'); };
  const seal = value => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`reel.figma.refresh.v1:${clientID}`));
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64url');
  };
  const unseal = value => {
    if (!valid(value, 40, 4096)) throw new Failure(401, 'Reconnect your Figma account.');
    try {
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.length < 29) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(`reel.figma.refresh.v1:${clientID}`));
      decipher.setAuthTag(bytes.subarray(-16));
      const body = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString());
      if (body.expires <= now() || typeof body.token !== 'string' || !body.token || body.token.length > 2048) throw new Error();
      return body.token;
    } catch { throw new Failure(401, 'Reconnect your Figma account.'); }
  };
  const token = async values => {
    let response;
    try {
      response = await providerFetch('https://api.figma.com/v1/oauth/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${clientID}:${clientSecret}`).toString('base64')}` },
        body: new URLSearchParams(values),
      });
    } catch { throw new Failure(502, 'Figma could not be reached. Try signing in again.'); }
    if (!response.ok) throw new Failure(response.status === 429 ? 429 : 401, 'Figma sign-in failed. Reconnect your account.');
    let length = 0, chunks = [];
    for await (const chunk of response.body ?? []) { length += chunk.length; if (length > 16384) throw new Failure(502, 'Figma returned an invalid sign-in response.'); chunks.push(chunk); }
    let data; try { data = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Failure(502, 'Figma returned an invalid sign-in response.'); }
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 2048 || /\s/.test(data.access_token) || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Failure(502, 'Figma returned an invalid sign-in response.');
    if (data.refresh_token != null && (typeof data.refresh_token !== 'string' || !data.refresh_token || data.refresh_token.length > 2048 || /\s/.test(data.refresh_token))) throw new Failure(502, 'Figma returned an invalid sign-in response.');
    return data;
  };
  const packaged = (data, fallback) => ({ access_token: data.access_token, expires_in: data.expires_in, refresh_token: seal({ token: data.refresh_token ?? fallback, expires: now() + 365 * 86400000 }) });
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  const body = async req => {
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Failure(415, 'Send a JSON request.');
    let size = 0, chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Failure(413, 'Sign-in request is too large.'); chunks.push(chunk); }
    try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
    catch { throw new Failure(400, 'Send a valid sign-in request.'); }
  };
  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    let counted = false;
    try {
      if (req.headers.host !== base.host || req.headers.origin && req.headers.origin !== base.origin) throw new Failure(403, 'Invalid sign-in origin.');
      if (now() - windowStart >= 60000) { windowStart = now(); requests = 0; }
      if (++requests > 600 || active >= 64) throw new Failure(429, 'Figma sign-in is busy. Try again shortly.');
      active++; counted = true;
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 8192) throw new Failure(400, 'Invalid sign-in URL.');
      const url = new URL(req.url, base); prune();
      if (req.method === 'GET' && url.pathname === '/v1/figma/status') return json(res, 200, { configured: true, scopes: scopes.split(',') });
      if (req.method === 'POST' && url.pathname === '/v1/figma/start') {
        const b = await body(req);
        if (!valid(b.state) || !valid(b.challenge, 43, 43) || Object.keys(b).some(k => !['state', 'challenge'].includes(k))) throw new Failure(400, 'Invalid sign-in challenge.');
        room(); const state = random(), verifier = random() + random();
        pending.set(state, { state: b.state, challenge: b.challenge, verifier, expires: now() + 600000 });
        const authorization = new URL('https://www.figma.com/oauth');
        authorization.search = new URLSearchParams({ client_id: clientID, redirect_uri: redirect, scope: scopes, state, response_type: 'code', code_challenge: sha(verifier), code_challenge_method: 'S256' }).toString();
        return json(res, 200, { authorizationURL: authorization.href });
      }
      if (req.method === 'GET' && url.pathname === '/v1/figma/callback') {
        const states = url.searchParams.getAll('state'), codes = url.searchParams.getAll('code');
        if (states.length !== 1 || codes.length !== 1 || !valid(states[0]) || !codes[0] || codes[0].length > 2048 || /\s/.test(codes[0])) throw new Failure(400, 'Invalid Figma callback.');
        const transaction = pending.get(states[0]);
        if (!transaction) throw new Failure(400, 'Figma sign-in expired or was already completed.');
        pending.delete(states[0]);
        const data = await token({ grant_type: 'authorization_code', code: codes[0], redirect_uri: redirect, code_verifier: transaction.verifier });
        if (!data.refresh_token) throw new Failure(502, 'Figma returned no refresh credential.');
        room(); const ticket = random();
        tickets.set(ticket, { ...transaction, credential: packaged(data), expires: now() + 120000 });
        const callback = new URL('reelfigma://oauth/callback'); callback.search = new URLSearchParams({ state: transaction.state, ticket }).toString();
        res.writeHead(302, { Location: callback.href }); return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/v1/figma/exchange') {
        const b = await body(req);
        if (!valid(b.ticket) || !valid(b.verifier) || Object.keys(b).some(k => !['ticket', 'verifier'].includes(k))) throw new Failure(400, 'Invalid sign-in transfer.');
        const transaction = tickets.get(b.ticket);
        if (!transaction || !same(sha(b.verifier), transaction.challenge)) throw new Failure(401, 'Figma sign-in expired or belongs to another device.');
        tickets.delete(b.ticket); return json(res, 200, transaction.credential);
      }
      if (req.method === 'POST' && url.pathname === '/v1/figma/refresh') {
        const b = await body(req);
        if (Object.keys(b).some(k => k !== 'refresh_token')) throw new Failure(400, 'Invalid refresh request.');
        const original = unseal(b.refresh_token), id = sha(original);
        if (refreshes.size >= capacity && !refreshes.has(id)) throw new Failure(503, 'Figma sign-in is busy. Try again shortly.');
        let work = refreshes.get(id);
        if (!work) {
          work = token({ grant_type: 'refresh_token', refresh_token: original }).then(data => packaged(data, original)); refreshes.set(id, work);
          work.finally(() => { if (refreshes.get(id) === work) refreshes.delete(id); }).catch(() => {});
        }
        return json(res, 200, await work);
      }
      throw new Failure(404, 'Unknown sign-in route.');
    } catch (error) { if (!res.headersSent) json(res, error instanceof Failure ? error.status : 500, { error: error instanceof Failure ? error.message : 'Figma sign-in could not finish.' }); else res.end(); }
    finally { if (counted) active--; }
  }
  return { handle, redirectURI: redirect };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const broker = createFigmaBroker({ publicURL: process.env.FIGMA_BROKER_ORIGIN, clientID: process.env.FIGMA_CLIENT_ID, clientSecret: process.env.FIGMA_CLIENT_SECRET, encryptionKey: process.env.FIGMA_BROKER_KEY });
  const port = Number(process.env.PORT ?? 8789);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid broker port.');
  const server = createServer(broker.handle); server.requestTimeout = 20000; server.headersTimeout = 10000; server.maxHeadersCount = 32;
  server.listen(port, '127.0.0.1');
}

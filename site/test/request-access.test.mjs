import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { contributionAmount, checkoutDestination, releaseDestination, safeDestination } from '../assets/config.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const shipped = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
// The unreleased state, independent of the release the committed config ships.
const defaults = { ...shipped, release: { ...shipped.release, ready: false, notarized: false, version: null, macURL: null, sha256: null, size: null } };
const source = (await readFile(join(root, 'assets/site.mjs'), 'utf8')).replace(/^import[^\n]+\n/, '');

class Element {
  constructor(properties = {}) {
    this.listeners = {}; this.attributes = {}; this.children = []; this.dataset = {};
    this.classes = new Set(); this.disabled = true; this.textContent = ''; this.value = '';
    this.classList = { add: (...values) => values.forEach(value => this.classes.add(value)), remove: (...values) => values.forEach(value => this.classes.delete(value)), toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value) };
    Object.assign(this, properties);
  }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.focused = true; }
  replaceChildren(...children) { this.children = children; this.textContent = children.map(child => child.textContent).join(''); }
  querySelectorAll() { return []; }
}

async function accessFixture() {
  const email = new Element(); const tools = new Element(); const project = new Element(); const submit = new Element(); const state = new Element();
  const form = new Element({ querySelectorAll: () => [email, tools, project, submit] });
  const selectors = { '#access-form': form, '#access-email': email, '#access-state': state };
  const requests = [];
  const document = { documentElement: new Element(), querySelector: selector => selectors[selector] ?? null, querySelectorAll: () => [], addEventListener() {}, createTextNode: textContent => new Element({ textContent }), createElement: () => new Element() };
  const context = { document, contributionAmount, checkoutDestination, releaseDestination, safeDestination, AbortController, setTimeout: () => 1, clearTimeout() {}, fetch: async (url, options) => { requests.push({ url, method: options?.method ?? 'GET' }); return { ok: true, json: async () => defaults }; } };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.loaded = configLoad;`, context);
  await context.loaded;
  return { email, tools, project, submit, state, form, requests, submitForm: () => { let prevented = false; form.listeners.submit({ preventDefault() { prevented = true; } }); return prevented; } };
}

async function build(config) {
  const directory = await mkdtemp(join(tmpdir(), 'arya-site-access-'));
  try {
    await cp(root, directory, { recursive: true });
    await writeFile(join(directory, 'config.json'), JSON.stringify(config));
    const result = spawnSync(process.execPath, [join(directory, 'scripts/build.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const download = new String(await readFile(join(directory, 'download/index.html'), 'utf8'));
    download.home = await readFile(join(directory, 'index.html'), 'utf8');
    return download;
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Builds the unreleased pages, since the committed pages may ship a release that replaces the access form.
async function unreleasedPage(page) {
  unreleasedPages ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arya-site-unreleased-'));
    try {
      await cp(root, directory, { recursive: true });
      await writeFile(join(directory, 'config.json'), JSON.stringify(defaults));
      const result = spawnSync(process.execPath, [join(directory, 'scripts/build.mjs')], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return Object.fromEntries(await Promise.all(['', 'download', 'install', 'support', 'privacy', 'project'].map(async route => [route, await readFile(join(directory, route, 'index.html'), 'utf8')])));
    } finally { await rm(directory, { recursive: true, force: true }); }
  })();
  return (await unreleasedPages)[page];
}
let unreleasedPages;

test('the public default has no access destination and the download page shows an inert, labeled placeholder', async () => {
  assert.equal(defaults.requestAccessURL, null);
  const html = await unreleasedPage('download');
  const form = html.slice(html.indexOf('<form class="access-card" id="access-form"'), html.indexOf('</form>') + 7);
  assert.ok(form.length > 100, 'the access form is present');
  assert.ok(!/\saction=/.test(form), 'the placeholder form has no submission destination');
  assert.ok(!/\smethod=/.test(form));
  assert.match(form, /<strong>Placeholder\.<\/strong> This form is not connected yet\. Nothing you type is sent or stored\./);
  for (const control of ['<input disabled id="access-email"', '<select disabled id="access-tools"', '<textarea disabled id="access-project"', 'type="submit" disabled']) assert.ok(form.includes(control), control);
  assert.match(form, /<noscript><p>This form needs JavaScript and is not connected yet\.<\/p><\/noscript>/);
  for (const page of ['', 'download', 'install', 'support', 'privacy', 'project']) {
    const pageHTML = await unreleasedPage(page);
    assert.ok(pageHTML.includes('href="/download/#access"'), `${page || 'home'} links its primary action to the access form`);
  }
  const privacy = await unreleasedPage('privacy');
  assert.ok(privacy.includes('Effective date: 2026-10-20.'));
  assert.ok(!privacy.includes('beta access form on the download page is a placeholder'));
});

test('with no connected form, Home invites no access requests and says when requests open', async () => {
  const home = await unreleasedPage('');
  assert.ok(!home.includes('Request beta access'), 'nothing takes requests yet');
  assert.ok(!/request (beta )?access/i.test(home.replace(/<[^>]+>/g, ' ')), 'no copy asks visitors to request access');
  assert.equal([...home.matchAll(/<a class="button " href="\/download\/#access">Beta access<\/a>/g)].length, 2);
  assert.ok(home.includes('Beta requests open when the form on the download page is connected.'));
});

test('the placeholder handler validates in the browser and never sends what was typed', async () => {
  const f = await accessFixture();
  assert.ok([f.email, f.tools, f.project, f.submit].every(control => control.disabled === false), 'controls enable only after the handler installs');
  assert.deepEqual(f.requests.map(request => request.url), ['/config.json']);
  f.email.value = 'not an address';
  assert.equal(f.submitForm(), true);
  assert.equal(f.email.getAttribute('aria-invalid'), 'true');
  assert.ok(f.email.focused);
  assert.ok(f.state.classes.has('error'));
  assert.match(f.state.textContent, /Enter an email address/);
  f.email.listeners.input();
  assert.equal(f.email.getAttribute('aria-invalid'), null);
  f.email.value = ' editor@example.com ';
  f.tools.value = 'DaVinci Resolve';
  assert.equal(f.submitForm(), true);
  assert.equal(f.state.textContent, 'Access requests are not connected yet. Nothing you typed left this page.');
  assert.ok(!f.state.classes.has('error'));
  assert.deepEqual(f.requests.map(request => request.url), ['/config.json'], 'submitting makes no request');
});

test('a configured access form on an allowlisted HTTPS host replaces the placeholder with a link', async () => {
  const configured = await build({ ...defaults, requestAccessURL: 'https://forms.example.com/arya-beta', externalHosts: ['forms.example.com'] });
  assert.ok(configured.includes('href="https://forms.example.com/arya-beta"'));
  assert.ok(!configured.includes('id="access-form"'));
  assert.ok(configured.includes('id="access"'), 'the #access target still exists');
  assert.ok(configured.home.includes('>Request beta access</a>'), 'a connected form may be invited from Home');
  assert.ok(!configured.home.includes('Beta requests open when the form on the download page is connected.'));
  for (const requestAccessURL of ['https://forms.example.com/arya-beta', 'http://forms.example.com/arya-beta', 'javascript:alert(1)']) {
    const hosts = requestAccessURL.startsWith('https:') ? [] : ['forms.example.com'];
    const html = await build({ ...defaults, requestAccessURL, externalHosts: hosts });
    assert.ok(html.includes('id="access-form"'), requestAccessURL);
    assert.ok(!html.includes('forms.example.com'), requestAccessURL);
  }
});

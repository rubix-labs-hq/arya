import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { contributionAmount, checkoutDestination, releaseDestination, safeDestination } from '../assets/config.mjs';

const defaults = JSON.parse(await readFile(new URL('../config.json', import.meta.url), 'utf8'));
const source = (await readFile(new URL('../assets/site.mjs', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, '');
const ready = { ...defaults, release: { ...defaults.release, ready: true, notarized: true, version: '0.3.0', sha256: 'a'.repeat(64), macURL: 'https://example.com/Arya.dmg', allowedHosts: ['example.com'] } };

class Element {
  constructor(properties = {}) {
    this.listeners = {}; this.attributes = {}; this.children = []; this.dataset = {};
    this.classes = new Set(); this.disabled = true; this.text = '';
    this.classList = { add: (...values) => values.forEach(value => this.classes.add(value)), remove: (...values) => values.forEach(value => this.classes.delete(value)), toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value) };
    Object.assign(this, properties);
  }
  set textContent(value) { this.text = value; this.children = []; }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  replaceChildren(...children) { this.text = ''; this.children = children; }
  append(...children) { this.children.push(...children); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  focus() { this.focused = true; }
}

function fixture(fetch) {
  const elements = Object.fromEntries(['#release-state', '#release-heading', '#release-description', '#release-action', '#contribution-form', '#custom-amount', '#contribution-state'].map(selector => [selector, new Element()]));
  elements['#release-action'].append(new Element({ href: ready.release.macURL }));
  elements['#release-heading'].textContent = 'The official Mac release is available.';
  const submit = new Element();
  const input = elements['#custom-amount']; input.value = '15';
  const amounts = [5, 15, 30].map(amount => new Element({ dataset: { amount: String(amount) } }));
  elements['#contribution-form'].querySelector = () => submit;
  elements['#contribution-form'].querySelectorAll = () => [...amounts, input, submit];
  const document = { documentElement: new Element(), querySelector: selector => elements[selector] ?? null, querySelectorAll: selector => selector === '[data-amount]' ? amounts : [], addEventListener() {}, createTextNode: textContent => new Element({ textContent }), createElement: () => new Element() };
  let timeout;
  const context = { document, contributionAmount, checkoutDestination, releaseDestination, safeDestination, AbortController, fetch, setTimeout: callback => { timeout = callback; return 1; }, clearTimeout() {} };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.loaded = configLoad;`, context);
  return { elements, submit, input, amounts, loaded: context.loaded, expire: () => timeout(), submitAmount: () => elements['#contribution-form'].listeners.submit({ preventDefault() {} }) };
}

function assertUnavailable(f) {
  assert.equal(f.elements['#release-action'].children.length, 0);
  assert.equal(f.elements['#release-state'].textContent, 'Release status unavailable');
  assert.equal(f.elements['#release-heading'].textContent, 'We could not check the current release.');
  assert.match(f.elements['#release-description'].textContent, /Reload/);
  assert.match(f.elements['#contribution-state'].textContent, /could not be loaded/);
}

test('failed configuration removes an enhanced release link and reports the load error', async () => {
  for (const fetch of [() => Promise.reject(new Error('offline')), async () => ({ ok: false }), async () => ({ ok: true, json: async () => { throw new SyntaxError('invalid JSON'); } })]) {
    const f = fixture(fetch);
    await f.loaded;
    assertUnavailable(f);
    await f.submitAmount();
    assert.match(f.elements['#contribution-state'].textContent, /could not be loaded/);
    assert.equal(f.elements['#contribution-state'].children.length, 0);
    assert.equal(f.submit.disabled, false);
  }
});

test('a timed-out fetch follows the same unavailable and contribution recovery path', async () => {
  const f = fixture((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  f.expire();
  await f.loaded;
  assertUnavailable(f);
  await f.submitAmount();
  assert.match(f.elements['#contribution-state'].textContent, /Try reloading/);
});

test('an amount change during a failed load preserves recovery while a successful load rejects the stale amount', async () => {
  for (const outcome of ['failed', 'loaded']) {
    let finish;
    const pendingConfiguration = new Promise((resolve, reject) => {
      finish = () => outcome === 'failed' ? reject(new Error('offline')) : resolve({ ok: true, json: async () => defaults });
    });
    const f = fixture(() => pendingConfiguration);
    const submission = f.submitAmount();
    assert.equal(f.submit.disabled, true);
    f.input.value = '5';
    f.input.listeners.input();
    finish();
    await submission;
    assert.equal(f.submit.disabled, false);
    assert.equal(f.elements['#contribution-state'].children.length, 0);
    if (outcome === 'failed') {
      assertUnavailable(f);
      assert.match(f.elements['#contribution-state'].textContent, /Try reloading/);
      assert.doesNotMatch(f.elements['#contribution-state'].textContent, /Check contribution options again/);
    } else {
      assert.match(f.elements['#contribution-state'].textContent, /Your amount changed/);
      assert.doesNotMatch(f.elements['#contribution-state'].textContent, /could not be loaded/);
    }
  }
});

test('unsupported configuration does not offer release or contribution options', async () => {
  for (const config of [null, [], {}, { ...defaults, release: null }, { ...defaults, release: { ...defaults.release, ready: 'true' } }, { ...defaults, contributions: null }, { ...defaults, contributions: { ...defaults.contributions, policy: 'other' } }, { ...defaults, contributions: { ...defaults.contributions, minimum: 15 } }, { ...defaults, contributions: { ...defaults.contributions, currency: 'EUR' } }]) {
    const f = fixture(async () => ({ ok: true, json: async () => config }));
    await f.loaded;
    assertUnavailable(f);
    await f.submitAmount();
    assert.equal(f.elements['#contribution-state'].children.length, 0);
  }
});

test('valid unavailable configuration remains distinct from a load failure', async () => {
  const f = fixture(async () => ({ ok: true, json: async () => defaults }));
  await f.loaded;
  assert.equal(f.elements['#release-heading'].textContent, 'The public installer is not ready.');
  await f.submitAmount();
  assert.match(f.elements['#contribution-state'].textContent, /Contributions are not open yet/);
  assert.doesNotMatch(f.elements['#contribution-state'].textContent, /could not be loaded/);
});

test('valid approved configuration still offers its exact release and checkout destinations', async () => {
  const config = { ...ready, contributions: { ...defaults.contributions, allowedHosts: ['example.com'], checkoutURLs: { '15': 'https://example.com/support-fifteen' } } };
  const f = fixture(async () => ({ ok: true, json: async () => config }));
  await f.loaded;
  assert.equal(f.elements['#release-action'].children[0].href, config.release.macURL);
  await f.submitAmount();
  assert.equal(f.elements['#contribution-state'].children[1].href, config.contributions.checkoutURLs['15']);
  assert.match(f.elements['#contribution-state'].textContent, /one-time contribution/);
});

test('changing an amount removes an offered checkout before a new check', async () => {
  const config = { ...defaults, contributions: { ...defaults.contributions, allowedHosts: ['example.com'], checkoutURLs: { '15': 'https://example.com/support-fifteen' } } };
  for (const change of ['input', 'preset']) {
    const f = fixture(async () => ({ ok: true, json: async () => config }));
    await f.loaded;
    await f.submitAmount();
    assert.equal(f.elements['#contribution-state'].children.length, 2);
    if (change === 'input') { f.input.value = '5'; f.input.listeners.input(); }
    else f.amounts[0].listeners.click();
    assert.equal(f.elements['#contribution-state'].children.length, 0);
    await f.submitAmount();
    assert.match(f.elements['#contribution-state'].textContent, /There is no checkout for \$5\.00/);
    assert.doesNotMatch(f.elements['#contribution-state'].textContent, /Contributions are not open yet/);
  }
});

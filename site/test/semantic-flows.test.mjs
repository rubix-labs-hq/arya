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
const defaults = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const source = (await readFile(join(root, 'assets/site.mjs'), 'utf8')).replace(/^import[^\n]+\n/, '');

class Element {
  constructor(properties = {}) {
    this.listeners = {}; this.attributes = {}; this.children = []; this.dataset = {};
    this.disabled = true; this.textContent = ''; this.classes = new Set();
    this.classList = { add: (...values) => values.forEach(value => this.classes.add(value)), remove: (...values) => values.forEach(value => this.classes.delete(value)), toggle: (value, enabled) => enabled ? this.classes.add(value) : this.classes.delete(value) };
    Object.assign(this, properties);
  }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  focus() { this.ownerDocument.activeElement = this; this.focusCalls = (this.focusCalls || 0) + 1; }
  replaceChildren(...children) { this.children = children; this.textContent = children.map(child => child.textContent).join(''); }
  querySelectorAll() { return []; }
}

async function handlers() {
  const selectors = Object.fromEntries(['.header-inner', '.menu-button', '#site-nav', '.stage', '#layer-description', '.artboard', '[data-layer-action]', '#inspector-name', '#inspector-property', '#inspector-value', '#mobile-inspector-property', '#mobile-inspector-value'].map(selector => [selector, new Element()]));
  const menuButton = selectors['.menu-button'];
  const menu = selectors['#site-nav'];
  const links = [new Element(), new Element()];
  menu.children = links; menu.querySelectorAll = () => links;
  selectors['.header-inner'].children = [menuButton, menu];
  const layers = ['title', 'motion', 'scenery'].map(layer => new Element({ dataset: { layer } }));
  const outside = new Element();
  const document = { documentElement: new Element(), activeElement: outside, listeners: {}, querySelector: selector => selectors[selector] ?? null, querySelectorAll: selector => selector === '[data-layer]' ? layers : [], addEventListener(type, callback) { this.listeners[type] = callback; }, createTextNode: textContent => new Element({ textContent }), createElement: () => new Element() };
  for (const element of [...Object.values(selectors), ...links, ...layers, outside]) element.ownerDocument = document;
  const context = { document, contributionAmount, checkoutDestination, releaseDestination, safeDestination, AbortController, fetch: async () => ({ ok: true, json: async () => defaults }), setTimeout: () => 1, clearTimeout() {} };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.loaded = configLoad;`, context);
  await context.loaded;
  return { document, selectors, menu, menuButton, links, layers, outside, header: selectors['.header-inner'] };
}

test('the static illustration has disabled controls and a local script explanation', async () => {
  const html = await readFile(join(root, 'index.html'), 'utf8');
  const controls = [...html.matchAll(/<button\b[^>]*\bdata-layer(?:=|-action)[^>]*>/g)].map(match => match[0]);
  assert.equal(controls.length, 4);
  assert.ok(controls.every(control => /\bdisabled(?:\s|>)/.test(control)));
  const study = html.slice(html.indexOf('<div class="layer-study-body">'), html.indexOf('<div class="wrap"><section class="closing">'));
  assert.match(study, /<noscript><p>Layer controls need JavaScript\./);
});

test('installed illustration handlers enable the controls and keep selection and action state together', async () => {
  const f = await handlers();
  assert.ok(f.layers.every(layer => layer.disabled === false));
  const action = f.selectors['[data-layer-action]'];
  assert.equal(action.disabled, false);
  const motion = f.layers[1];
  motion.listeners.click();
  assert.equal(motion.getAttribute('aria-pressed'), 'true');
  assert.equal(f.layers.filter(layer => layer.getAttribute('aria-pressed') === 'true').length, 1);
  assert.equal(f.selectors['#inspector-property'].textContent, 'Rotation');
  assert.equal(f.selectors['#inspector-value'].textContent, '0°');
  action.listeners.click();
  assert.equal(f.selectors['#inspector-value'].textContent, '30°');
  assert.ok(f.selectors['.artboard'].classes.has('demo-motion'));
  action.listeners.click();
  assert.equal(f.selectors['#inspector-value'].textContent, '0°');
  assert.ok(!f.selectors['.artboard'].classes.has('demo-motion'));
});

test('Escape inside the open navigation returns focus to Menu', async () => {
  const f = await handlers();
  f.menuButton.listeners.click();
  f.links[0].focus();
  f.document.listeners.keydown({ key: 'Escape' });
  assert.equal(f.menuButton.getAttribute('aria-expanded'), 'false');
  assert.ok(!f.menu.classes.has('is-open'));
  assert.equal(f.document.activeElement, f.menuButton);
});

test('Escape outside the open navigation closes it without moving outside focus', async () => {
  const f = await handlers();
  f.menuButton.listeners.click();
  f.outside.focus();
  f.document.listeners.keydown({ key: 'Escape' });
  assert.equal(f.menuButton.getAttribute('aria-expanded'), 'false');
  assert.ok(!f.menu.classes.has('is-open'));
  assert.equal(f.document.activeElement, f.outside);
  assert.equal(f.menuButton.focusCalls || 0, 0);
});

test('leaving header navigation closes it while internal focus movement retains it', async () => {
  const f = await handlers();
  f.menuButton.listeners.click();
  f.header.listeners.focusout({ relatedTarget: f.links[0] });
  assert.equal(f.menuButton.getAttribute('aria-expanded'), 'true');
  f.header.listeners.focusout({ relatedTarget: f.menuButton });
  assert.equal(f.menuButton.getAttribute('aria-expanded'), 'true');
  f.outside.focus();
  f.header.listeners.focusout({ relatedTarget: f.outside });
  assert.equal(f.menuButton.getAttribute('aria-expanded'), 'false');
  assert.equal(f.document.activeElement, f.outside);
  f.menuButton.listeners.click();
  f.header.listeners.focusout({ relatedTarget: null });
  assert.equal(f.menuButton.getAttribute('aria-expanded'), 'false');
});

async function generated(config) {
  const directory = await mkdtemp(join(tmpdir(), 'arya-site-semantics-'));
  try {
    await cp(root, directory, { recursive: true });
    await writeFile(join(directory, 'config.json'), JSON.stringify(config));
    const result = spawnSync(process.execPath, [join(directory, 'scripts/build.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(await Promise.all(['', 'download', 'install', 'support', 'privacy', 'project'].map(async route => [route || 'home', await readFile(join(directory, route, 'index.html'), 'utf8')])));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('page copy, metadata and guide artwork follow release and public-source configuration independently', async () => {
  const ready = { ...defaults.release, ready: true, notarized: true, version: '0.3.0', sha256: 'a'.repeat(64), macURL: 'https://example.com/Arya.dmg', allowedHosts: ['example.com'] };
  for (const releaseReady of [false, true]) {
    for (const sourcePublic of [false, true]) {
      const config = { ...defaults, release: releaseReady ? ready : defaults.release, publicSourceURL: sourcePublic ? 'https://github.com/example/arya' : null, externalHosts: ['github.com'] };
      const pages = await generated(config);
      assert.equal(pages.download.includes('Public installer in preparation'), !releaseReady);
      assert.equal(pages.download.includes('Official Mac release available'), releaseReady);
      assert.equal(pages.support.includes('Private beta by invitation'), !releaseReady);
      assert.equal(pages.support.includes('Mac release available'), releaseReady);
      assert.equal(pages.project.includes('Public source to follow'), !sourcePublic);
      assert.equal(pages.project.includes('Public source available'), sourcePublic);
      assert.equal(pages.home.includes('Not yet. Arya is in a private beta by invitation.'), !releaseReady);
      assert.equal(pages.home.includes('Yes. The approved Mac release is on the download page'), releaseReady);
      // The owner has not set pricing (2026-10-09). With no checkout configured, no page may state a price or promise a free download.
      for (const [name, html] of Object.entries(pages)) {
        const text = html.replace(/<[^>]+>/g, ' ');
        assert.ok(!/\$\s?\d/.test(text), `${name} states a price`);
        assert.ok(!/free download|pay what you can/i.test(text), `${name} makes a pricing promise`);
      }
      assert.ok(pages.install.includes('Public hosted sign-in is deferred.'));
      assert.ok(!pages.install.includes('Public hosted sign-in remains in setup.'));
      for (const name of ['download', 'install', 'project']) {
        const description = pages[name].match(/<meta name="description" content="([^"]+)"/)[1];
        const socialDescription = pages[name].match(/<meta property="og:description" content="([^"]+)"/)[1];
        assert.equal(description, socialDescription);
        if (name === 'download') assert.equal(description.includes('planned Mac requirements'), !releaseReady);
        if (name === 'install') assert.equal(description.includes('before the public release'), !releaseReady);
        if (name === 'project') assert.equal(description.includes('the plan to publish'), !sourcePublic);
      }
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { safeDestination, contributionAmount, releaseDestination, checkoutDestination } from '../assets/config.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const shipped = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
// The unreleased state, independent of the release the committed config ships.
const defaults = { ...shipped, release: { ...shipped.release, ready: false, notarized: false, version: null, macURL: null, sha256: null, size: null } };
const ready = { ...defaults, release: { ...defaults.release, ready: true, notarized: true, version: '0.3.0', sha256: 'a'.repeat(64), size: '150 MB', macURL: 'https://example.com/Arya.dmg', allowedHosts: ['example.com'] } };
const publicConfig = { ...ready, siteURL: 'https://example.com/', contactURL: 'https://example.com/help', publicSourceURL: 'https://github.com/example/arya', externalHosts: ['example.com', 'github.com'] };

test('release flags and malformed destination allowlists fail closed', () => {
  for (const value of ['true', 'false', 1, {}, []]) {
    for (const field of ['ready', 'notarized']) assert.equal(releaseDestination({ release: { ...ready.release, [field]: value } }), null);
  }
  for (const hosts of [null, 'example.com', {}, [1]]) assert.equal(safeDestination('https://example.com/Arya.dmg', hosts), null);
  assert.equal(releaseDestination(ready), ready.release.macURL);
});

async function buildFixture(config) {
  const directory = await mkdtemp(join(tmpdir(), 'arya-site-release-'));
  try {
    await cp(root, directory, { recursive: true });
    await writeFile(join(directory, 'config.json'), JSON.stringify(config));
    const result = spawnSync(process.execPath, [join(directory, 'scripts/build.mjs')], { encoding: 'utf8' });
    const pages = result.status === 0 ? Object.fromEntries(await Promise.all(['', 'download', 'install', 'support', 'privacy', 'project'].map(async route => [route || 'home', await readFile(join(directory, route, 'index.html'), 'utf8')]))) : null;
    return { result, pages };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('configured release, contact, source and social metadata survive static generation', async () => {
  const { result, pages } = await buildFixture(publicConfig);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(pages.download.includes('href="https://example.com/Arya.dmg"'));
  assert.ok(pages.download.includes('Version 0.3.0'));
  assert.ok(pages.download.includes(ready.release.sha256));
  assert.ok(!pages.download.includes('The public installer is not ready.'));
  assert.ok(!pages.home.includes('Public download not yet available.'));
  assert.ok(!pages.home.includes('The repository is currently private.'));
  assert.ok(!pages.project.includes('The source is currently private.'));
  assert.ok(!pages.install.includes('The public installer has not shipped.'));
  for (const html of Object.values(pages)) {
    assert.ok(html.includes('href="https://example.com/help"'));
    assert.ok(html.includes('content="https://example.com/assets/brand/social.png"'));
    assert.ok(html.includes('name="twitter:card"'));
  }
  assert.ok(pages.support.includes('No payment will be taken here.'));
  // A ready release sends every primary action to the download, not to the beta access form.
  for (const [name, html] of Object.entries(pages)) {
    assert.ok(!html.includes('href="/download/#access"'), `${name} still links to beta access`);
    assert.ok(html.includes('<a class="button small" href="/download/#mac">Download</a>'), `${name} header action`);
  }
  assert.equal([...pages.home.matchAll(/<a class="button " href="\/download\/#mac">Download Arya<\/a>/g)].length, 3);
  assert.ok(!pages.download.includes('id="access-form"'));
});

test('partial release configuration cannot generate a download', async () => {
  for (const release of [{ ...ready.release, notarized: false }, { ...ready.release, sha256: null }, { ...ready.release, allowedHosts: [] }]) {
    const { result } = await buildFixture({ ...defaults, release });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('A ready release requires'));
  }
  const { result, pages } = await buildFixture({ ...defaults, siteURL: null });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!pages.download.includes('href="https://example.com/Arya.dmg"'));
  assert.ok(pages.download.includes('The public installer is not ready.'));
  assert.ok(!pages.home.includes('property="og:image"'));
});

test('static installation guides explain manual update and rollback with release gates intact', async () => {
  for (const config of [defaults, publicConfig]) {
    const { result, pages } = await buildFixture(config);
    assert.equal(result.status, 0, result.stderr);
    const html = pages.install;
    assert.ok(html.includes('href="#updates"'));
    assert.ok(html.includes('id="updates">Updates and rollback'));
    assert.ok(html.includes('press Control-C in that companion\'s window'));
    assert.ok(html.includes('previous approved installer and its published checksum'));
    assert.ok(html.includes('backup made before the update'));
    assert.ok(html.includes('Replacing the app does not undo project edits'));
    assert.ok(html.includes('Get Info'));
    assert.ok(!html.includes('automatic update flow'));
    assert.equal(html.includes('The public installer has not shipped.'), config === defaults);
    assert.equal(pages.download.includes('href="https://example.com/Arya.dmg"'), config === publicConfig);
  }
});

test('configured support describes checkout options without claiming payment success', async () => {
  const config = { ...defaults, contributions: { ...defaults.contributions, allowedHosts: ['example.com'], checkoutURLs: { ...defaults.contributions.checkoutURLs, '15': 'https://example.com/support-fifteen' } } };
  const { result, pages } = await buildFixture(config);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(pages.support.includes('Choose an amount to check the configured provider options. No payment has been made.'));
  assert.ok(!pages.support.includes('Contributions are not open yet.'));
  assert.ok(pages.project.includes('Configured contribution options send you to the payment provider.'));
  assert.ok(!pages.project.includes('A provider and checkout destinations still need setup.'));
  const fixture = await browserFixture(config);
  await fixture.configLoaded;
  await fixture.selectors['#contribution-form'].listeners.submit({ preventDefault() {} });
  const state = fixture.selectors['#contribution-state'];
  assert.equal(state.children.length, 2);
  assert.equal(state.children[1].href, config.contributions.checkoutURLs['15']);
  assert.equal(state.children[1].textContent, 'Continue to secure checkout');
  assert.ok(state.children[0].textContent.includes('one-time contribution'));
});

class Element {
  constructor(properties = {}) { Object.assign(this, { listeners: {}, attributes: {}, children: [], dataset: {}, disabled: true, textContent: '', style: {} }, properties); this.classes = new Set(); this.classList = { add: (...values) => values.forEach(value => this.classes.add(value)), remove: (...values) => values.forEach(value => this.classes.delete(value)), toggle: (value, enabled) => { if (enabled) this.classes.add(value); else this.classes.delete(value); } }; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  replaceChildren(...children) { this.children = children; this.textContent = children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  focus() { this.focused = true; }
  contains(element) { return element === this || this.children.some(child => child.contains(element)); }
  querySelectorAll() { return []; }
}

const galleryBaseURI='http://127.0.0.1:4173/';
const captureURL=src=>new URL(src,galleryBaseURI).href;
class ImageElement extends Element {
  set src(value) { this.requestedURL=captureURL(value); this.complete=false; }
  get src() { return this.requestedURL; }
}

async function browserFixture(config, load, initialImage = {}) {
  const selectors = Object.fromEntries(['.menu-button', '#site-nav', '#release-state', '#release-heading', '#release-description', '#release-action', '#workspace-image', '#workspace-caption', '#workspace-full', '#contribution-form', '#custom-amount', '#contribution-state'].map(key => [key, new Element()]));
  const navigationLinks = [new Element()];
  selectors['#site-nav'].querySelectorAll = () => navigationLinks;
  const galleries = ['edit', 'motion', 'color', 'audio'].map(id => new Element({ dataset: { src: `/assets/product/${id}.jpg`, alt: `${id} workspace`, caption: `${id} caption` } }));
  galleries[0].setAttribute('aria-current','true');
  selectors['#workspace-image']=new ImageElement({ src: galleries[0].dataset.src, currentSrc: captureURL(galleries[0].dataset.src), complete: true, naturalWidth: 1329, ...initialImage });
  selectors['#workspace-caption'].textContent=galleries[0].dataset.caption;
  selectors['#workspace-full'].href=galleries[0].dataset.src;
  const amounts = [5, 15, 30].map(amount => new Element({ dataset: { amount: String(amount) } }));
  const submit = new Element();
  const input = selectors['#custom-amount']; input.value = '15';
  selectors['#contribution-form'].querySelector = () => submit;
  selectors['#contribution-form'].querySelectorAll = () => [...amounts, input, submit];
  const document = { baseURI: galleryBaseURI, documentElement: new Element(), listeners: {}, querySelector: selector => selectors[selector] || null, querySelectorAll: selector => selector === '[data-workspace]' ? galleries : selector === '[data-amount]' ? amounts : [], addEventListener(type, callback) { this.listeners[type] = callback; }, createElement: () => new Element(), createTextNode: textContent => new Element({ textContent }) };
  const context = { document, URL, safeDestination, contributionAmount, releaseDestination, checkoutDestination, AbortController, setTimeout: () => 1, clearTimeout: () => {}, fetch: load || (() => Promise.resolve({ ok: true, json: async () => config })) };
  vm.createContext(context);
  const source = (await readFile(join(root, 'assets/site.mjs'), 'utf8')).replace(/^import[^\n]+\n/, '');
  vm.runInContext(`${source}\nglobalThis.configLoaded = configLoad;`, context);
  return { ...context, selectors, navigationLinks, galleries, amounts, submit, input };
}

test('runtime navigation, gallery and withdrawal use their real event handlers', async () => {
  const fixture = await browserFixture(ready);
  await fixture.configLoaded;
  assert.ok(fixture.document.documentElement.classes.has('has-navigation'));
  fixture.selectors['.menu-button'].listeners.click();
  assert.equal(fixture.selectors['.menu-button'].getAttribute('aria-expanded'), 'true');
  fixture.document.activeElement = fixture.selectors['.menu-button'];
  fixture.document.listeners.keydown({ key: 'Escape' });
  assert.equal(fixture.selectors['.menu-button'].getAttribute('aria-expanded'), 'false');
  assert.ok(fixture.selectors['.menu-button'].focused);
  assert.equal(fixture.selectors['#release-action'].children.length, 1);
  assert.equal(fixture.selectors['#release-action'].children[0].href, ready.release.macURL);
  for (const gallery of fixture.galleries) {
    let prevented = false;
    gallery.listeners.click({ preventDefault() { prevented = true; } });
    assert.ok(prevented);
    assert.equal(fixture.selectors['#workspace-image'].src, captureURL(gallery.dataset.src));
    assert.equal(fixture.selectors['#workspace-image'].alt, gallery.dataset.alt);
    assert.equal(fixture.selectors['#workspace-caption'].textContent, gallery.dataset.caption);
    assert.equal(fixture.selectors['#workspace-full'].href, gallery.dataset.src);
    assert.equal(fixture.galleries.filter(item => item.getAttribute('aria-current') === 'true').length, 1);
  }
  fixture.galleries[0].listeners.click({ ctrlKey: true, preventDefault() { assert.fail('modified click must follow the full-size link'); } });
  const withdrawn = await browserFixture(defaults);
  withdrawn.selectors['#release-action'].children.push(new Element({ href: ready.release.macURL }));
  await withdrawn.configLoaded;
  assert.equal(withdrawn.selectors['#release-action'].children.length, 0);
  assert.equal(withdrawn.selectors['#release-heading'].textContent, 'The public installer is not ready.');
});

test('gallery failures announce the missing capture and recover after another capture loads', async () => {
  const fixture = await browserFixture(defaults);
  await fixture.configLoaded;
  const image = fixture.selectors['#workspace-image'];
  const caption = fixture.selectors['#workspace-caption'];
  const full = fixture.selectors['#workspace-full'];
  fixture.galleries[1].listeners.click({ preventDefault() {} });
  Object.assign(image,{ complete: true, naturalWidth: 0, currentSrc: captureURL(fixture.galleries[1].dataset.src) });
  image.listeners.error();
  assert.equal(caption.textContent, 'The workspace capture could not load. Select another workspace or reload this page to try again.');
  assert.equal(full.style.display, 'none');
  fixture.galleries[2].listeners.click({ preventDefault() {} });
  Object.assign(image,{ complete: true, naturalWidth: 1329, currentSrc: captureURL(fixture.galleries[2].dataset.src) });
  image.listeners.load();
  assert.equal(caption.textContent, fixture.galleries[2].dataset.caption);
  assert.equal(full.style.display, '');
  assert.equal(full.href, fixture.galleries[2].dataset.src);
});

test('queued gallery events cannot expose a pending capture or replace its caption', async () => {
  const fixture=await browserFixture(defaults);
  const image=fixture.selectors['#workspace-image'];
  const caption=fixture.selectors['#workspace-caption'];
  const full=fixture.selectors['#workspace-full'];
  for(const selected of fixture.galleries.slice(1)){
    selected.listeners.click({ preventDefault() {} });
    assert.equal(image.complete,false);
    for(const event of ['error','load']){
      image.listeners[event]();
      assert.equal(caption.textContent,selected.dataset.caption);
      assert.equal(full.href,selected.dataset.src);
      assert.equal(full.style.display,'none');
    }
  }
  image.complete=true;
  image.listeners.load();
  assert.equal(full.style.display,'none');
  assert.equal(caption.textContent,fixture.galleries[3].dataset.caption);
  Object.assign(image,{ currentSrc: image.src, complete: true, naturalWidth: 1329 });
  image.listeners.error();
  assert.equal(full.style.display,'');
  assert.equal(caption.textContent,fixture.galleries[3].dataset.caption);
  Object.assign(image,{ naturalWidth: 0 });
  image.listeners.load();
  assert.equal(full.style.display,'none');
  assert.ok(caption.textContent.includes('could not load'));
});

test('gallery failure before module startup hides the failed capture and allows recovery', async () => {
  for(const currentSrc of ['',captureURL('/assets/product/edit.jpg')]){
    const fixture=await browserFixture(defaults,undefined,{ complete: true, naturalWidth: 0, currentSrc });
    const image=fixture.selectors['#workspace-image'];
    const full=fixture.selectors['#workspace-full'];
    assert.equal(full.style.display,'none');
    assert.ok(fixture.selectors['#workspace-caption'].textContent.includes('could not load'));
    fixture.galleries[2].listeners.click({ preventDefault() {} });
    image.listeners.error();
    assert.equal(fixture.selectors['#workspace-caption'].textContent,fixture.galleries[2].dataset.caption);
    assert.equal(full.style.display,'none');
    Object.assign(image,{ complete: true, naturalWidth: 1329, currentSrc: image.src });
    image.listeners.load();
    assert.equal(full.style.display,'');
    assert.equal(full.href,fixture.galleries[2].dataset.src);
  }
});

test('support events reject invalid and stale amounts without offering checkout', async () => {
  let resolveConfiguration;
  const configuration = new Promise(resolve => { resolveConfiguration = resolve; });
  const fixture = await browserFixture(defaults, () => configuration);
  assert.equal(fixture.submit.disabled, false);
  fixture.input.value = '4.99';
  await fixture.selectors['#contribution-form'].listeners.submit({ preventDefault() {} });
  assert.equal(fixture.input.getAttribute('aria-invalid'), 'true');
  assert.ok(fixture.input.focused);
  fixture.input.value = '15';
  const pending = fixture.selectors['#contribution-form'].listeners.submit({ preventDefault() {} });
  assert.equal(fixture.submit.disabled, true);
  fixture.input.value = '30';
  resolveConfiguration({ ok: true, json: async () => defaults });
  await pending;
  assert.ok(fixture.selectors['#contribution-state'].textContent.includes('Your amount changed.'));
  assert.equal(fixture.selectors['#contribution-state'].children.length, 0);
  await fixture.selectors['#contribution-form'].listeners.submit({ preventDefault() {} });
  assert.ok(fixture.selectors['#contribution-state'].textContent.includes('Contributions are not open yet.'));
  assert.equal(fixture.selectors['#contribution-state'].children.length, 0);
});

test('static pages offer gallery links and keep forms inert until handlers exist', async () => {
  const home = await readFile(join(root, 'index.html'), 'utf8');
  assert.equal([...home.matchAll(/<a class="workspace-tab" href="\/assets\/product\//g)].length, 4);
  const support = await readFile(join(root, 'support/index.html'), 'utf8');
  assert.ok(!support.includes('id="custom-amount"'), 'no amounts are offered before a checkout is configured');
  const configured = { ...defaults, contributions: { ...defaults.contributions, allowedHosts: ['example.com'], checkoutURLs: { ...defaults.contributions.checkoutURLs, '15': 'https://example.com/support-fifteen' } } };
  const { result, pages } = await buildFixture(configured);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(pages.support.includes('<input disabled id="custom-amount"'));
  assert.ok(pages.support.includes('type="submit" disabled'));
  const css = await readFile(join(root, 'assets/site.css'), 'utf8');
  assert.ok(css.includes('.menu-button{display:none}.nav{display:flex;position:static;'));
  assert.ok(css.includes('.has-navigation .nav{display:none;position:absolute}'));
});

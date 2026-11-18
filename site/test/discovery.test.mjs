import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { structuredMetadata, writeDiscoveryFiles } from '../scripts/discovery.mjs';

const root = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('config.json', root), 'utf8'));

test('generated share metadata and structured data identify the canonical page', async () => {
  for (const route of ['', 'download/', 'install/', 'support/', 'privacy/', 'project/']) {
    const html = await readFile(new URL(`${route}index.html`, root), 'utf8');
    const canonical = new URL(route, config.siteURL + '/').href;
    assert.ok(html.includes(`rel="canonical" href="${canonical}"`));
    assert.match(html, /name="twitter:image" content="https:\/\/editwitharya.app\/assets\/brand\/link-preview\.png"/);
    assert.match(html, /property="og:image:width" content="1200"/);
    assert.match(html, /property="og:image:height" content="630"/);
    const data = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    assert.equal(data['@context'], 'https://schema.org');
    assert.ok(data['@graph'].some(item => item['@type'] === 'WebPage' && item.url === canonical));
    assert.ok(!JSON.stringify(data).includes('aggregateRating'));
  }
});

test('unavailable native releases are not represented as downloadable structured offers', () => {
  const metadata = structuredMetadata({ ...config, release: { ...config.release, ready: false },
    mobileRelease: { ...config.mobileRelease, ready: false } },
  { canonical: config.siteURL + '/', title: 'Arya', description: 'Editor' });
  const apps = metadata['@graph'].filter(item => item['@type'] === 'SoftwareApplication');
  assert.deepEqual(apps.map(app => app.operatingSystem), ['Web']);
  assert.equal(structuredMetadata({ ...config, siteURL: 'http://unsafe.example' }, { canonical: '/'}), null);
});

test('machine-readable discovery contains the real release and explicit edition limits', async () => {
  const summary = await readFile(new URL('llms.txt', root), 'utf8');
  const full = await readFile(new URL('llms-full.txt', root), 'utf8');
  assert.match(summary, /^# Arya/);
  assert.ok(summary.includes(`${config.siteURL}/privacy/`));
  assert.ok(full.includes(`version ${config.release.version}`));
  assert.ok(full.includes(config.release.sha256));
  assert.ok(full.includes('Hosted browser limits'));
  assert.ok(full.includes('public Figma OAuth is not configured'));
  assert.ok(full.includes('Tips are voluntary one-time payments and unlock no features'));
});

test('discovery files link the source only while a public repository is configured', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arya-site-discovery-'));
  try {
    for (const publicSourceURL of [null, undefined, 'https://private.example/arya', 'http://github.com/rubix-labs-hq/arya']) {
      await writeDiscoveryFiles(directory, { ...config, publicSourceURL });
      for (const name of ['llms.txt', 'llms-full.txt']) {
        const file = await readFile(join(directory, name), 'utf8');
        assert.doesNotMatch(file, /\bnull\b|\bundefined\b|Source code|private\.example/, `${name} with ${publicSourceURL}`);
        assert.ok(file.includes('License: MIT.') || name === 'llms.txt');
      }
    }
    await writeDiscoveryFiles(directory, config);
    for (const name of ['llms.txt', 'llms-full.txt']) assert.equal(await readFile(join(directory, name), 'utf8'), await readFile(new URL(name, root), 'utf8'), `${name} matches the committed file`);
    assert.ok((await readFile(join(directory, 'llms.txt'), 'utf8')).includes(`- [Source code](${config.publicSourceURL}): MIT-licensed repository and issue tracker.`));
    assert.ok((await readFile(join(directory, 'llms-full.txt'), 'utf8')).includes(`Source code: ${config.publicSourceURL}\nLicense: MIT.`));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

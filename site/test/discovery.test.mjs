import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { structuredMetadata } from '../scripts/discovery.mjs';

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

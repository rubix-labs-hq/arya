import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mobileReleaseDestination } from '../assets/config.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const shipped = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));

const validLiveConfig = {
  ...shipped,
  mobileRelease: {
    ready: true,
    version: '1.0.5',
    build: '1',
    appStoreURL: 'https://apps.apple.com/app/id6826357116',
    appId: '6826357116',
    allowedHosts: ['apps.apple.com']
  }
};

async function buildFixture(config) {
  const directory = await mkdtemp(join(tmpdir(), 'arya-site-mobile-'));
  try {
    await cp(root, directory, { recursive: true });
    await writeFile(join(directory, 'config.json'), JSON.stringify(config));
    const result = spawnSync(process.execPath, [join(directory, 'scripts/build.mjs')], { encoding: 'utf8' });
    const pages = result.status === 0
      ? Object.fromEntries(await Promise.all(['', 'download', 'install', 'support', 'privacy', 'project'].map(async route => [route || 'home', await readFile(join(directory, route, 'index.html'), 'utf8')])))
      : null;
    return { result, pages };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('mobile release destination helper enforces literal ready boolean, non-empty version, and verified App Store URL', () => {
  const live = validLiveConfig.mobileRelease;
  assert.equal(mobileReleaseDestination(validLiveConfig), 'https://apps.apple.com/app/id6826357116');

  // Literal ready boolean required
  for (const value of ['true', 'false', 1, 0, {}, [], null, undefined]) {
    assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, ready: value } }), null);
  }

  // Version required as non-empty string
  for (const version of ['', '   ', null, undefined, 1.0, {}]) {
    assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, version } }), null);
  }

  // Permitted ordinary official App Store destination paths for verified app 6826357116
  for (const url of [
    'https://apps.apple.com/app/id6826357116',
    'https://apps.apple.com/app/id6826357116/',
    'https://apps.apple.com/us/app/name/id6826357116',
    'https://apps.apple.com/app/arya/id6826357116',
    'https://apps.apple.com/us/app/arya/id6826357116'
  ]) {
    assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, appStoreURL: url } }), new URL(url).href);
  }

  // Rejection of non-default ports
  for (const port of [':8443', ':8080', ':3000', ':80']) {
    assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, appStoreURL: `https://apps.apple.com${port}/app/id6826357116` } }), null);
  }

  // Rejection of missing app paths or malformed paths
  for (const url of [
    'https://apps.apple.com/id6826357116',
    'https://apps.apple.com/store/id6826357116',
    'https://apps.apple.com/app/extra/extra/id6826357116',
    'https://apps.apple.com/123/app/id6826357116',
    'https://apps.apple.com/app/id1234567890',
    'https://apps.apple.com/app/id68263571160',
    'https://apps.apple.com/app/id6826357116abc',
    'https://apps.apple.com/app/id',
    'https://apps.apple.com/app/',
    'https://apps.apple.com/'
  ]) {
    assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, appStoreURL: url } }), null);
  }

  // Rejection of foreign hosts, evil subdomains, and unallowlisted hosts
  for (const url of [
    'https://example.com/app/id6826357116',
    'https://google.com/app/id6826357116',
    'https://apps.apple.com.attacker.com/app/id6826357116',
    'https://phishing-apple.com/app/id6826357116'
  ]) {
    assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, appStoreURL: url } }), null);
    assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, appStoreURL: url, allowedHosts: ['example.com', 'google.com', 'apps.apple.com.attacker.com', 'phishing-apple.com'] } }), null);
  }
  assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, allowedHosts: ['github.com'] } }), null);
  assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, allowedHosts: [] } }), null);
  assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, allowedHosts: null } }), null);

  // Rejection of non-matching appId config
  assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, appId: '1234567890' } }), null);

  // Rejection of credentials and non-HTTPS schemes
  assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, appStoreURL: 'https://user:pass@apps.apple.com/app/id6826357116' } }), null);
  assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, appStoreURL: 'http://apps.apple.com/app/id6826357116' } }), null);

  // Pending config has no destination link
  assert.equal(mobileReleaseDestination(shipped), null);
  assert.equal(mobileReleaseDestination({ mobileRelease: { ...live, ready: false } }), null);
});

test('pending mobile release renders plain review status and provides no active download link', async () => {
  const { result, pages } = await buildFixture(shipped);
  assert.equal(result.status, 0, result.stderr);

  const download = pages.download;
  assert.ok(download.includes('Version 1.0.5 (build 1) is waiting for App Review, with no download yet. It will be released automatically as a free download worldwide after approval.'));
  assert.ok(download.includes('waiting for App Review'));
  assert.ok(download.includes('no download yet'));
  assert.ok(/released automatically as a free download worldwide after approval/i.test(download));

  // Pending config must have no active App Store link
  assert.ok(!download.includes('https://apps.apple.com'));
  assert.ok(!download.includes('Download on the App Store'));
  assert.ok(download.includes('<div id="mobile-action"></div>'));

  // Plain user-facing copy without internal release mechanism identifiers
  assert.ok(!download.includes('WAITING_FOR_REVIEW'));
  assert.ok(!download.includes('AFTER_APPROVAL'));

  // /project/ page preserves pending roadmap state
  assert.ok(pages.project.includes('Shared project format is in testing on devices. Public iPhone and iPad builds are coming later.'));

  // Mac release config and links remain intact
  assert.ok(download.includes('Download Arya for Mac'));
  assert.ok(download.includes('Version 1.0.5'));
});

test('validated live mobile release enables the conditional App Store CTA and updates /project/', async () => {
  const { result, pages } = await buildFixture(validLiveConfig);
  assert.equal(result.status, 0, result.stderr);

  const download = pages.download;
  assert.ok(download.includes('Version 1.0.5 is available as a free download worldwide on the App Store.'));
  assert.ok(download.includes('<div id="mobile-action"><a class="button " href="https://apps.apple.com/app/id6826357116">Download on the App Store</a></div>'));
  assert.ok(!download.includes('is waiting for App Review'));

  // /project/ iPhone and iPad row reflects availability and does not claim builds are coming later
  assert.ok(pages.project.includes('Arya 1.0.5 is available on the App Store as a free download.'));
  assert.ok(!pages.project.includes('Public iPhone and iPad builds are coming later.'));

  // Mac release still preserved
  assert.ok(download.includes('Download Arya for Mac'));
});

test('invalid mobile release readiness or malformed App Store URL fails build closed', async () => {
  // ready is true, but URL is invalid or malformed
  for (const badURL of [
    null,
    'https://example.com/app/id6826357116',
    'https://apps.apple.com/id6826357116',
    'https://apps.apple.com/app/id12345',
    'https://apps.apple.com/app/id68263571160',
    'https://apps.apple.com:8443/app/id6826357116',
    'http://apps.apple.com/app/id6826357116'
  ]) {
    const config = {
      ...shipped,
      mobileRelease: {
        ...validLiveConfig.mobileRelease,
        ready: true,
        appStoreURL: badURL
      }
    };
    const { result } = await buildFixture(config);
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('A ready mobile release requires'));
  }
});

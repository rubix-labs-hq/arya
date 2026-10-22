import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { checkThirdPartyNotices } from './check-third-party-notices.mjs';

function fixture(run) {
  const base = realpathSync(mkdtempSync(resolve(tmpdir(), 'arya-notice-check-')));
  const source = resolve(base, 'source'), bundle = resolve(base, 'bundle');
  mkdirSync(source); mkdirSync(bundle);
  const write = (scope, path, data) => { const file = resolve(scope, path); mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, data); };
  const packages = {};
  let notice = 'https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz\n';
  for (const [name, version, license] of [['preact', '10.29.8', 'MIT'], ['htm', '3.1.1', 'Apache-2.0'], ['mediabunny', '1.61.0', 'MPL-2.0']]) {
    packages[`node_modules/${name}`] = { version, license };
    write(source, `editor/node_modules/${name}/package.json`, JSON.stringify({ version, license }));
    const text = `${name} fixture license text.\n`;
    write(source, `editor/node_modules/${name}/LICENSE`, text); write(bundle, `vendor/${name}/LICENSE`, text);
    notice += `| ${version} | ${license} |\n${text}`;
  }
  for (const [sourcePath, bundlePath, text] of [
    ['editor/web/fonts/LICENSE-Inter.txt', 'web/fonts/LICENSE-Inter.txt', 'Inter'],
    ['editor/web/fonts/MrsSaintDelafield-OFL.txt', 'web/fonts/MrsSaintDelafield-OFL.txt', 'Mrs Saint Delafield'],
    ['editor/web/fonts/manrope-OFL.txt', 'web/fonts/manrope-OFL.txt', 'Manrope'],
    ['site/assets/fonts/newsreader-OFL.txt', null, 'Newsreader'],
  ]) {
    const license = `${text} fixture license text.\n`; write(source, sourcePath, license);
    if (bundlePath) write(bundle, bundlePath, license);
    notice += license;
  }
  write(source, 'editor/package-lock.json', JSON.stringify({ packages }));
  write(source, 'THIRD_PARTY_NOTICES.md', notice); write(bundle, 'THIRD_PARTY_NOTICES.md', notice);
  try { run({ source, bundle, write, notice }); }
  finally { rmSync(base, { recursive: true, force: true }); }
}

test('checks the complete shared-editor notice and names the source license', () => fixture(({ source, bundle, write }) => {
  let receipt = checkThirdPartyNotices({ sourceRoot: source, bundleRoot: bundle });
  assert.equal(receipt.componentNoticesVerified, true);
  assert.equal(receipt.sharedEditorBundleChecked, true);
  assert.equal(receipt.sourceLicense, null);
  assert(!('readyToPublish' in receipt));
  write(source, 'LICENSE', 'MIT License\n\nCopyright (c) 2026 Rubix Labs\n');
  receipt = checkThirdPartyNotices({ sourceRoot: source, bundleRoot: bundle });
  assert.equal(receipt.sourceLicense, 'MIT');
  assert.equal(receipt.components.length, 7);
  assert(!JSON.stringify(receipt).includes(source));
}));

test('rejects dependency drift, absent source access, missing bundle licenses and changed notices', () => fixture(({ source, bundle, write, notice }) => {
  const packagePath = 'editor/node_modules/mediabunny/package.json';
  const original = readFileSync(resolve(source, packagePath));
  write(source, packagePath, JSON.stringify({ version: '1.62.0', license: 'MPL-2.0' }));
  assert.throws(() => checkThirdPartyNotices({ sourceRoot: source }), /dependency changed/);
  write(source, packagePath, original);
  write(source, 'THIRD_PARTY_NOTICES.md', notice.replace('https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz', ''));
  assert.throws(() => checkThirdPartyNotices({ sourceRoot: source }), /source-access notice/);
  write(source, 'THIRD_PARTY_NOTICES.md', notice.replace('Inter fixture license text.', ''));
  assert.throws(() => checkThirdPartyNotices({ sourceRoot: source }), /complete component license/);
  write(source, 'THIRD_PARTY_NOTICES.md', notice);
  write(bundle, 'vendor/preact/LICENSE', 'changed');
  assert.throws(() => checkThirdPartyNotices({ sourceRoot: source, bundleRoot: bundle }), /bundled license differs/);
  write(bundle, 'vendor/preact/LICENSE', readFileSync(resolve(source, 'editor/node_modules/preact/LICENSE')));
  rmSync(resolve(bundle, 'vendor/htm/LICENSE'));
  assert.throws(() => checkThirdPartyNotices({ sourceRoot: source, bundleRoot: bundle }), /Working-file read rejected/);
  write(bundle, 'vendor/htm/LICENSE', readFileSync(resolve(source, 'editor/node_modules/htm/LICENSE')));
  write(bundle, 'THIRD_PARTY_NOTICES.md', notice + 'changed');
  assert.throws(() => checkThirdPartyNotices({ sourceRoot: source, bundleRoot: bundle }), /bundled third-party notice differs/);
}));

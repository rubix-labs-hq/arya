#!/usr/bin/env node
// Check dependency versions, complete notice texts and optional shared-editor bundle copies.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedWorkingFile } from './public-readiness.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = [
  { name: 'preact', version: '10.29.8', license: 'MIT' },
  { name: 'htm', version: '3.1.1', license: 'Apache-2.0' },
  { name: 'mediabunny', version: '1.61.0', license: 'MPL-2.0' },
];
const fonts = [
  ['Inter', 'editor/web/fonts/LICENSE-Inter.txt', 'web/fonts/LICENSE-Inter.txt'],
  ['Mrs Saint Delafield', 'editor/web/fonts/MrsSaintDelafield-OFL.txt', 'web/fonts/MrsSaintDelafield-OFL.txt'],
  ['Manrope', 'editor/web/fonts/manrope-OFL.txt', 'web/fonts/manrope-OFL.txt'],
  ['Newsreader', 'site/assets/fonts/newsreader-OFL.txt', null],
];
const sourceURL = 'https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function bytes(scope, path) {
  const result = boundedWorkingFile(resolve(scope, path), scope);
  if (!result || result.length === 0) throw new Error('A notice input is missing or outside the byte limit.');
  return result;
}
function json(scope, path) { return JSON.parse(bytes(scope, path).toString('utf8')); }

export function checkThirdPartyNotices({ sourceRoot = root, noticeRoot = sourceRoot, bundleRoot = null } = {}) {
  sourceRoot = resolve(sourceRoot); noticeRoot = resolve(noticeRoot);
  if (bundleRoot) bundleRoot = resolve(bundleRoot);
  const lockBytes = bytes(sourceRoot, 'editor/package-lock.json');
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const noticeBytes = bytes(noticeRoot, 'THIRD_PARTY_NOTICES.md');
  const notice = noticeBytes.toString('utf8');
  if (!notice.includes(sourceURL)) throw new Error('The exact Mediabunny source-access notice is missing.');
  const components = [];
  function include(name, licensePath, bundlePath) {
    const licenseBytes = bytes(sourceRoot, licensePath);
    if (!notice.includes(licenseBytes.toString('utf8').trim())) throw new Error('A complete component license text is missing.');
    if (bundleRoot && bundlePath && !licenseBytes.equals(bytes(bundleRoot, bundlePath))) {
      throw new Error('A bundled license differs from the inventoried source.');
    }
    components.push({ name, sourcePath: licensePath, licenseSHA256: hash(licenseBytes), bundlePath });
  }
  for (const dependency of runtime) {
    const locked = lock.packages?.[`node_modules/${dependency.name}`];
    const installed = json(sourceRoot, `editor/node_modules/${dependency.name}/package.json`);
    if (locked?.version !== dependency.version || installed.version !== dependency.version ||
        locked.license !== dependency.license || installed.license !== dependency.license ||
        !notice.includes(`| ${dependency.version} | ${dependency.license} |`)) {
      throw new Error('A dependency changed. Update and review the notices before distribution.');
    }
    include(dependency.name, `editor/node_modules/${dependency.name}/LICENSE`, `vendor/${dependency.name}/LICENSE`);
  }
  for (const [name, sourcePath, bundlePath] of fonts) include(name, sourcePath, bundlePath);
  if (bundleRoot && !noticeBytes.equals(bytes(bundleRoot, 'THIRD_PARTY_NOTICES.md'))) {
    throw new Error('The bundled third-party notice differs from the release notice.');
  }
  let license = '';
  try { license = boundedWorkingFile(resolve(sourceRoot, 'LICENSE'), sourceRoot)?.toString('utf8') ?? ''; } catch {}
  return {
    schema: 2, componentNoticesVerified: true, sharedEditorBundleChecked: Boolean(bundleRoot),
    sourceLicense: /^MIT License\b/.test(license) ? 'MIT' : null,
    lockfileSHA256: hash(lockBytes), noticeSHA256: hash(noticeBytes), components,
    limitations: ['This checks notice packaging and names the source license. It does not review copyright ownership.',
      'Node helper payloads and their complete license files need separate runtime-manifest validation.',
      'Fixture, project, screenshot and artwork provenance needs a separate owner record.'],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--bundle')) throw new Error('Invalid arguments.');
    console.log(JSON.stringify(checkThirdPartyNotices({ bundleRoot: args[1] || null }), null, 2));
  } catch {
    console.error('Third-party notice verification failed. No private paths or file contents were printed.');
    process.exitCode = 2;
  }
}

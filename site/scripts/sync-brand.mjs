// Run after generate-brand.py. Requires sharp in the local Node runtime.
import { createRequire } from 'node:module';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
for (const name of ['social', 'installer', 'identity-board']) {
  await sharp(resolve(root, `site/assets/brand/${name}.svg`)).png().toFile(resolve(root, `site/assets/brand/${name}.png`));
}
for (const name of ['mark.svg', 'mark-mono.svg', 'mark-ink.svg', 'wordmark.svg', 'wordmark-ink.svg', 'icon.svg']) {
  await copyFile(resolve(root, `site/assets/brand/${name}`), resolve(root, `editor/web/assets/brand/${name}`));
}
const wordmarkSVG = await readFile(resolve(root, 'site/assets/brand/wordmark.svg'), 'utf8');
const bounds = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(wordmarkSVG);
if (!bounds) throw new Error('Expected canonical wordmark bounds');
const [wordmarkWidth, wordmarkHeight] = bounds.slice(1).map(Number);
for (const scale of [1, 2, 3]) {
  await sharp(resolve(root, 'site/assets/brand/wordmark.svg'), { density: 72 * scale }).resize(Math.round(wordmarkWidth * scale), Math.round(wordmarkHeight * scale)).png().toFile(resolve(root, `native/App/Shared/Assets.xcassets/AryaWordmark.imageset/arya-wordmark@${scale}x.png`));
}
const manifestPath = resolve(root, 'editor/web/assets/brand/source-manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
for (const entry of manifest.files) {
  const bytes = await readFile(resolve(root, entry.path));
  entry.sha256 = createHash('sha256').update(bytes).digest('hex');
  entry.bytes = bytes.length;
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log('Synchronized canonical SVGs, native wordmark scales and provenance manifest.');

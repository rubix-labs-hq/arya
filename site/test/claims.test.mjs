import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Claims the 2026-10-09 review checked against the editor, updated 2026-10-20 after the local editor gained
// alpha export (editor/test/export-alpha.test.mjs). Update these together with the code they describe.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const page = async route => (await readFile(join(root, route, 'index.html'), 'utf8')).replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

test('home makes no feature claim the review found untrue', async () => {
  const home = await page('');
  const untrue = [
    [/polygon window/i, 'color windows are circle, rectangle and linear'],
    [/4:5/, 'the shorts format picker offers 9:16, 1:1 and 16:9'],
    [/lists each one|import lists|reported rendering fallbacks/i, 'the Figma import does not list the layers it turns into images'],
    [/without transparency|EDL and AAF are not supported/i, 'the local editor keeps alpha and exports EDL'],
    [/hosted[^.]*exports? (ProRes|PNG)/i, 'the hosted editor exports only H.264, HEVC, WAV and AAC'],
  ];
  for (const [pattern, reason] of untrue) assert.ok(!pattern.test(home), reason);
});

test('guide pages repeat none of those claims', async () => {
  for (const route of ['download', 'install', 'privacy', 'project', 'support']) {
    const text = await page(route);
    assert.ok(!/polygon window|4:5|reported rendering fallbacks|lists each one|4444 with alpha/i.test(text), route);
  }
});

test('home states the limits next to the claims they qualify', async () => {
  const home = await page('');
  for (const required of [
    "The Mac app's native interface does not expose every feature shown on this page yet.",
    'automatic proxies',
    'circle, rectangle or linear window',
    '9:16, 1:1 or 16:9 composition',
    'exports H.264, HEVC, WAV and AAC up to five minutes.',
    'They do not predict views.',
    'Premiere XML and AAF are not supported, and EDL is export only',
    'Footage: Tears of Steel , (CC) Blender Foundation',
  ]) assert.ok(home.includes(required), required);
});

test('every image of the film carries or sits beside its credit', async () => {
  const figures = JSON.parse(await readFile(join(root, 'assets/product/figures.json'), 'utf8'));
  assert.match(figures.shorts.caption, /Tears of Steel, \(CC\) Blender Foundation, CC BY 3\.0\./);
  const provenance = await readFile(join(root, 'assets/product/README.md'), 'utf8');
  assert.ok(provenance.includes('credits the film beside the gallery and in the caption of the rendered 9:16 frame'));
});

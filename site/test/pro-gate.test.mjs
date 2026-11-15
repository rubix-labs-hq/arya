import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Arya Pro copy for the App Store edition stays hidden until mobileRelease.pro is the JSON boolean
// true and the App Store release is live. The Mac download and the browser editor never need Pro.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const shipped = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const withPro = value => {
  const mobileRelease = { ...shipped.mobileRelease };
  if (value === undefined) delete mobileRelease.pro; else mobileRelease.pro = value;
  return { ...shipped, mobileRelease };
};
const outputs = ['index.html', '404.html', ...['download', 'install', 'help', 'support', 'privacy', 'project'].map(route => `${route}/index.html`), 'llms.txt', 'llms-full.txt'];
const text = html => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/\s+/g, ' ');

async function build(config) {
  const directory = await mkdtemp(join(tmpdir(), 'arya-site-pro-'));
  try {
    await cp(root, directory, { recursive: true });
    await writeFile(join(directory, 'config.json'), JSON.stringify(config));
    const result = spawnSync(process.execPath, [join(directory, 'scripts/build.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return Object.fromEntries(await Promise.all(outputs.map(async name => [name, await readFile(join(directory, name), 'utf8')])));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('without pro set to true, no page or discovery file mentions Arya Pro', async () => {
  const off = await build(withPro(false));
  const variants = [
    ['missing', await build(withPro(undefined))],
    ['string', await build(withPro('true'))],
    ['not live', await build({ ...withPro(true), mobileRelease: { ...withPro(true).mobileRelease, ready: false, appStoreURL: null } })],
  ];
  for (const [name, file] of Object.entries(off)) {
    assert.ok(!/Arya Pro|1080p|HDR10|8K/.test(file), `${name} shows Pro copy while pro is false`);
  }
  // The committed pages and discovery files are the build of the committed configuration.
  const committed = await build(shipped);
  for (const name of outputs) assert.equal(committed[name], await readFile(join(root, name), 'utf8'), `${name} is stale; run npm run build`);
  for (const [label, pages] of variants) {
    for (const [name, file] of Object.entries(pages)) assert.ok(!/Arya Pro|1080p/.test(file), `${name} shows Pro copy when pro is ${label}`);
  }
  for (const [name, file] of Object.entries(variants[0][1])) assert.equal(file, off[name], `${name} changes when the pro key is missing`);
});

test('with pro true, the App Store copy names the free tier, Arya Pro and the free Mac and browser editions', async () => {
  const on = await build(withPro(true));
  const home = text(on['index.html']), download = text(on['download/index.html']), support = text(on['support/index.html']);
  const privacy = text(on['privacy/index.html']), summary = on['llms.txt'], full = on['llms-full.txt'];

  // iPhone and iPad: editing and 1080p export are free. 4K, ProRes and HDR are Arya Pro.
  for (const page of [home, download, full]) {
    assert.ok(page.includes('Editing and export up to 1080p are free, with no watermark, ads or account.'));
    assert.ok(page.includes('Arya Pro adds export above 1080p (4K and up to 8K), Apple ProRes 422, 422 HQ and 4444, and HDR10 (PQ) and HLG delivery.'));
  }
  assert.ok(home.includes('Free editing and 1080p export. Arya Pro adds 4K, ProRes and HDR.'));
  assert.ok(!home.includes('Free core editor.'));
  assert.ok(download.includes('Plans and prices are shown in the app.'));
  assert.ok(download.includes('before version 1.2.0, Arya Pro is included at no charge'));

  // The Mac download and the browser editor stay free.
  assert.ok(download.includes('The Mac download from this site and the browser editor stay free and never need Arya Pro.'));
  assert.ok(support.includes('The Mac download from this site and the browser editor stay free and never need Arya Pro.'));
  assert.ok(full.includes('The Mac download and the browser editor are free and never need Arya Pro.'));

  // The FAQ no longer says the App Store edition has no subscriptions or paid tiers.
  assert.ok(!home.includes('Yes. Arya is released under the MIT license with no subscriptions, watermarks or paid tiers.'));
  assert.ok(home.includes('The Mac download from this site and the browser editor are free, with no subscriptions, watermarks or paid tiers.'));
  assert.ok(!home.includes('Arya is free and MIT licensed.'));

  // Discovery and privacy describe Pro, not tip-only App Store purchases.
  assert.ok(!summary.includes('Optional tips support development.'));
  assert.ok(summary.includes('Arya Pro adds 4K, ProRes and HDR export.'));
  assert.ok(!full.includes('Core editing and export are free.'));
  assert.ok(!full.includes('There is no required Arya subscription.'));
  assert.ok(privacy.includes('Apple processes Arya Pro subscriptions and purchases in App Store builds'));
  assert.ok(!privacy.includes('Apple processes optional in-app purchases'));

  // No Pro sentence states a price. The support page keeps its website contribution amounts.
  for (const name of outputs.filter(name => name !== 'support/index.html')) {
    assert.ok(!/[$€£¥]\s?\d|\d\s?(USD|EUR|GBP)\b/.test(text(on[name])), `${name} states a price`);
  }
  const proParagraph = support.match(/Arya Pro in the App Store edition is separate\.[^$]*?Arya Pro\./)?.[0];
  assert.ok(proParagraph, 'the support page explains that Arya Pro is separate');
  assert.ok(!/[$€£¥]\s?\d/.test(proParagraph));
  assert.ok(!/\$\s?\d/.test(on['llms-full.txt'].split('## Cost and privacy')[1]));
});

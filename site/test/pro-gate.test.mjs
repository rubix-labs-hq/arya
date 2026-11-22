import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Arya Pro copy for the App Store edition stays hidden until mobileRelease.pro is the JSON boolean
// true and the App Store release is live. The Mac download and the browser editor never need Pro.
// Each channel is stated by itself: the Mac App Store edition is named with the version in
// macAppStoreRelease and is said to have Arya Pro only when that object says so.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const shipped = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const withPro = value => {
  const mobileRelease = { ...shipped.mobileRelease };
  if (value === undefined) delete mobileRelease.pro; else mobileRelease.pro = value;
  return { ...shipped, mobileRelease };
};
// The App Store release that sells Arya Pro, with whatever the Mac App Store edition is at.
// `undefined` leaves the Mac App Store object out.
const proLive = macAppStoreRelease => {
  const config = { ...shipped, mobileRelease: { ...shipped.mobileRelease, version: '1.2.0', build: '7', pro: true } };
  if (macAppStoreRelease === undefined) delete config.macAppStoreRelease; else config.macAppStoreRelease = macAppStoreRelease;
  return config;
};
const macStoreTips = { version: '1.1.1', build: '5', pro: false };
const universal = 'One Arya Pro purchase covers iPhone, iPad and the Mac App Store edition.';
const early = 'If you installed Arya from the App Store before version 1.2.0, Arya Pro is included at no charge.';
// No page prints a missing value, and no page names the release that is still being prepared.
// That version is assembled here so this file does not name it either.
const unreleased = [1, 5, 0].join('.');
const noLeaks = (pages, label) => {
  for (const [name, file] of Object.entries(pages)) {
    assert.doesNotMatch(text(file), /\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/, `${name} prints a missing value (${label})`);
    assert.ok(!file.includes(unreleased), `${name} names the unreleased version (${label})`);
  }
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
  // While pro is false the Mac App Store object changes nothing, whatever it holds.
  for (const macAppStoreRelease of [undefined, null, { ...macStoreTips, pro: true }, { version: '1.2.0', build: '7', pro: true }]) {
    const config = withPro(false);
    if (macAppStoreRelease === undefined) delete config.macAppStoreRelease; else config.macAppStoreRelease = macAppStoreRelease;
    const pages = await build(config);
    for (const name of outputs) assert.equal(pages[name], off[name], `${name} changes with the Mac App Store object while pro is false`);
  }
  noLeaks(off, 'pro false');
  assert.doesNotMatch(Object.values(off).join(' '), /Mac App Store · Version|Mac App Store edition: version/);
});

test('with pro true, the App Store copy names the free tier, Arya Pro and the free Mac and browser editions', async () => {
  // The state published first: iPhone and iPad sell Arya Pro, the Mac App Store edition does not yet.
  const on = await build(proLive(macStoreTips));
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
  const mac = text(on['download/index.html'].match(/<section class="edition" aria-labelledby="mac">[\s\S]*?<\/section>/)[0]);
  const browser = text(on['download/index.html'].match(/<section class="edition" aria-labelledby="browser">[\s\S]*?<\/section>/)[0]);
  assert.ok(mac.includes('Free to edit and export in every format the Mac app supports.'));
  assert.ok(browser.includes('Free editing and export. Supports H.264, HEVC, WAV and AAC exports up to five minutes.'));
  assert.match(download, /App Store iPhone and iPad · Version 1\.2\.0 /);
  assert.match(download, /Arya Pro in Settings.*Restore Purchases/);
  assert.doesNotMatch(mac + browser, /1080p|Arya Pro/);
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

  // No Pro sentence states a price. The support page keeps its website contribution amounts.
  for (const name of outputs.filter(name => name !== 'support/index.html')) {
    assert.ok(!/[$€£¥]\s?\d|\d\s?(USD|EUR|GBP)\b/.test(text(on[name])), `${name} states a price`);
  }
  const proParagraph = support.match(/Arya Pro on iPhone and iPad is separate\.[^$]*?Arya Pro\./)?.[0];
  assert.ok(proParagraph, 'the support page explains that Arya Pro is separate');
  assert.ok(!/[$€£¥]\s?\d/.test(proParagraph));
  assert.ok(!/\$\s?\d/.test(on['llms-full.txt'].split('## Cost and privacy')[1]));
});

test('iPhone and iPad sell Arya Pro while the Mac App Store edition is still at its tip-era version', async () => {
  const on = await build(proLive(macStoreTips));
  const pages = Object.fromEntries(Object.entries(on).map(([name, file]) => [name, text(file)]));
  const home = pages['index.html'], download = pages['download/index.html'], support = pages['support/index.html'];
  const privacy = pages['privacy/index.html'], full = on['llms-full.txt'], everything = Object.values(pages).join(' ');
  noLeaks(on, 'iPhone and iPad pro, Mac App Store tips');

  // iPhone and iPad state their own version and Arya Pro.
  assert.match(download, /App Store iPhone and iPad · Version 1\.2\.0 On iPhone and iPad, editing and 1080p export are free, and Arya Pro adds 4K, ProRes and HDR export\./);
  assert.ok(home.includes('Arya 1.2.0 for iPhone and iPad. Free editing and 1080p export. Arya Pro adds 4K, ProRes and HDR.'));
  assert.match(on['index.html'], /<article class="platform"><h3>iPhone and iPad<\/h3>/);
  assert.match(full, /- iPhone and iPad: version 1\.2\.0, available on the App Store/);

  // The Mac App Store edition is named with its own version and is not said to have Arya Pro.
  assert.ok(download.includes('Mac App Store · Version 1.1.1. Free to edit and export, with optional tips. Arya Pro starts there with version 1.2.0.'));
  assert.match(full, /- Mac App Store edition: version 1\.1\.1, on the same App Store listing\. It is free to edit and export, offers optional tips and has no Arya Pro\./);
  assert.ok(!everything.includes(universal), 'no sentence says one purchase covers the Mac App Store edition');
  // The purchase details follow the iPhone and iPad button. The Mac App Store line closes the card.
  assert.match(on['download/index.html'], /Download on the App Store<\/a><\/div>\n<div class="edition-more"><details class="download-details"><summary>Export formats and purchase options<\/summary>[\s\S]*?<\/details>\n<p class="edition-meta" id="mac-app-store">Mac App Store · Version 1\.1\.1\.[^<]*<\/p><\/div>\n<\/section>/);
  assert.doesNotMatch(everything, /iPhone, iPad and Mac ·|for iPhone, iPad and Mac[,.]|covers iPhone, iPad and the Mac App Store edition|In the App Store edition/);
  assert.doesNotMatch(everything, /Mac App Store[^.]*Version 1\.2\.0\b|Mac App Store edition: version 1\.2\.0/);

  // The tips that Mac App Store 1.1.1 still offers keep their disclosure.
  assert.ok(privacy.includes('Apple processes optional in-app purchases in App Store builds under its own privacy terms.'));
  assert.ok(privacy.includes('Apple processes Arya Pro subscriptions and purchases in App Store builds under its own privacy terms.'));
  assert.ok(support.includes('The Mac App Store edition is at version 1.1.1, which has no Arya Pro. Its optional tips are bought in the app through Apple and unlock no features.'));
  assert.ok(support.includes('Arya Pro on iPhone and iPad is separate.'));

  // Sign in with ChatGPT is not stated as present in the Mac App Store edition before its version 1.2.0.
  assert.ok(privacy.includes('Sign in with ChatGPT is available in the direct Mac app and, from version 1.2.0, in the iPhone and iPad apps. It comes to the Mac App Store edition with version 1.2.0. You sign in'));
  assert.ok(privacy.includes('Assistant editing is optional and runs through your own AI account.'));

  // The direct Mac download and the browser editor never need Arya Pro.
  for (const page of [download, support]) assert.ok(page.includes('The Mac download from this site and the browser editor stay free and never need Arya Pro.'));
  assert.ok(full.includes('The Mac download and the browser editor are free and never need Arya Pro.'));
  assert.ok(home.includes('The Mac download from this site and the browser editor are free, with no subscriptions, watermarks or paid tiers.'));

  // The early-install sentence stays where it was, word for word.
  assert.ok(download.includes(early) && home.includes(early));

  // An extra `ready` key, as in the release checklist, changes nothing.
  const withReady = await build(proLive({ ready: true, ...macStoreTips }));
  for (const name of outputs) assert.equal(withReady[name], on[name], `${name} changes with macAppStoreRelease.ready`);
});

test('once the Mac App Store edition sells Arya Pro too, one purchase covers all three', async () => {
  const same = await build(proLive({ version: '1.2.0', build: '7', pro: true }));
  const download = text(same['download/index.html']), home = text(same['index.html']), full = same['llms-full.txt'];
  noLeaks(same, 'both pro, same version');
  assert.match(download, /App Store iPhone, iPad and Mac · Version 1\.2\.0 In the App Store edition, editing and 1080p export are free/);
  assert.doesNotMatch(download, /Mac App Store · Version/);
  for (const page of [download, full]) assert.ok(page.includes(universal));
  assert.ok(home.includes('In the App Store edition for iPhone, iPad and Mac, editing and export up to 1080p are free'));
  assert.ok(full.includes('In the App Store edition for iPhone, iPad and Mac,'));
  assert.match(full, /- Mac App Store edition: version 1\.2\.0, on the same App Store listing\. It has the same free tier and Arya Pro as the iPhone and iPad apps\./);
  const support = text(same['support/index.html']), privacy = text(same['privacy/index.html']);
  assert.ok(support.includes('Arya Pro in the App Store edition is separate.'));
  assert.doesNotMatch(support, /Its optional tips are bought in the app/);
  assert.ok(privacy.includes('Apple processes Arya Pro subscriptions and purchases in App Store builds'));
  assert.ok(!privacy.includes('Apple processes optional in-app purchases'));
  assert.ok(privacy.includes('Sign in with ChatGPT is available in the direct Mac app and, from version 1.2.0, in the iPhone, iPad and Mac App Store apps. You sign in'));
  assert.doesNotMatch(privacy, /It comes to the Mac App Store edition/);
  assert.ok(download.includes(early) && home.includes(early));

  // Both sell Arya Pro at different versions: each channel keeps its own version line.
  const apart = await build({ ...proLive({ version: '1.2.0', build: '7', pro: true }), mobileRelease: { ...shipped.mobileRelease, version: '1.2.1', build: '9', pro: true } });
  const apartDownload = text(apart['download/index.html']);
  noLeaks(apart, 'both pro, different versions');
  assert.match(apartDownload, /App Store iPhone and iPad · Version 1\.2\.1 /);
  assert.ok(apartDownload.includes('Mac App Store · Version 1.2.0. The same free tier and Arya Pro as on iPhone and iPad.'));
  assert.ok(apartDownload.includes(universal));
});

test('without a usable Mac App Store object, no page states a Mac App Store version or Arya Pro there', async () => {
  const cases = [
    ['missing', undefined],
    ['null', null],
    ['empty', {}],
    ['no version', { build: '5', pro: true }],
    ['null version', { version: null, build: null, pro: true }],
    ['numeric version', { version: 1.2, build: 7, pro: true }],
    ['not a version', { version: 'undefined', build: '5', pro: true }],
    ['not ready', { ready: false, version: '1.2.0', build: '7', pro: true }],
    ['a string', '1.2.0'],
  ];
  const missing = await build(proLive(undefined));
  for (const [label, macAppStoreRelease] of cases) {
    const pages = label === 'missing' ? missing : await build(proLive(macAppStoreRelease));
    noLeaks(pages, `Mac App Store object ${label}`);
    const everything = Object.values(pages).map(text).join(' ');
    assert.doesNotMatch(everything, /Mac App Store · Version|Mac App Store edition: version|Mac App Store edition is at version/, label);
    assert.ok(!everything.includes(universal), label);
    assert.doesNotMatch(everything, /iPhone, iPad and Mac ·|for iPhone, iPad and Mac[,.]|In the App Store edition/, label);
    assert.match(text(pages['download/index.html']), /App Store iPhone and iPad · Version 1\.2\.0 On iPhone and iPad, editing and 1080p export are free/, label);
    for (const name of outputs) assert.equal(pages[name], missing[name], `${name} differs from the missing-object build (${label})`);
  }
  // A version without build or with a string pro flag is stated, and never as selling Arya Pro.
  for (const macAppStoreRelease of [{ version: '1.1.1' }, { version: '1.1.1', build: '5', pro: 'true' }, { version: '1.1.1', pro: 1 }]) {
    const pages = await build(proLive(macAppStoreRelease));
    noLeaks(pages, JSON.stringify(macAppStoreRelease));
    const download = text(pages['download/index.html']);
    assert.ok(download.includes('Mac App Store · Version 1.1.1. Free to edit and export, with optional tips.'));
    assert.ok(!Object.values(pages).map(text).join(' ').includes(universal));
  }
});

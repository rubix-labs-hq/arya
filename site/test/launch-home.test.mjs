// The launch home page: native captures, the exported clip and what a visitor is told about them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { nativeCaptureNote } from '../scripts/product-home.mjs';
import { preparePublicOutput } from '../scripts/prepare-public.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const shipped = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'));
const native = JSON.parse(await readFile(join(root, 'assets/product/native.json'), 'utf8'));
const allowlist = JSON.parse(await readFile(join(root, 'public-files.json'), 'utf8'));
const css = await readFile(join(root, 'assets/site.css'), 'utf8');
const disclosure = 'The still picture in After the Tide was AI-generated for this demo.';
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

// Builds a copy of the site with another config, and optionally another native.json.
async function build(config, nativeFile = null) {
  const directory = await mkdtemp(join(tmpdir(), 'arya-site-launch-'));
  try {
    await cp(root, directory, { recursive: true });
    await writeFile(join(directory, 'config.json'), JSON.stringify(config));
    if (nativeFile) await writeFile(join(directory, 'assets/product/native.json'), JSON.stringify(nativeFile));
    const result = spawnSync(process.execPath, [join(directory, 'scripts/build.mjs')], { encoding: 'utf8' });
    const page = async route => readFile(join(directory, route, 'index.html'), 'utf8');
    return { result, home: result.status === 0 ? await page('') : null, download: result.status === 0 ? await page('download') : null };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const live = await build(shipped);
const macOnly = await build({ ...shipped, mobileRelease: null });

test('the capture note names the captured version and only says a download differs when it does', () => {
  const same = nativeCaptureNote({ native, releaseReady: true, version: '1.1.0', mobileURL: 'https://apps.apple.com/app/id1', mobileVersion: '1.1.2' });
  assert.match(same, /^Captured from Arya 1\.1 on Mac, iPad and iPhone, November 2026, /);
  assert.doesNotMatch(same, /current download/);

  const both = nativeCaptureNote({ native, releaseReady: true, version: '1.0.7', mobileURL: 'https://apps.apple.com/app/id1', mobileVersion: '1.0.5' });
  assert.ok(both.endsWith('The current downloads are Arya 1.0.7 for Mac and Arya 1.0.5 for iPhone and iPad. Screens in those versions can differ.'));

  const one = nativeCaptureNote({ native, releaseReady: true, version: '1.0.7', mobileURL: 'https://apps.apple.com/app/id1', mobileVersion: '1.1.0' });
  assert.ok(one.endsWith('The current download is Arya 1.0.7 for Mac. Screens in that version can differ.'));

  const unreleased = nativeCaptureNote({ native, releaseReady: false, version: '1.0.7' });
  assert.match(unreleased, /^Captured from Arya 1\.1 on Mac, /);
  assert.doesNotMatch(unreleased, /iPad|iPhone|current download/);

  // A version that is not available is never described.
  for (const note of [same, both, one, unreleased]) assert.doesNotMatch(note, /review|coming|soon|upcoming/i);
});

test('the capture note names the sample projects on screen and says what their media is', () => {
  const study = Object.keys(native.images).filter(id => native.images[id].project === 'Motion Study');
  const studyNote = nativeCaptureNote({ native, shown: study });
  assert.ok(study.length > 0);
  assert.match(studyNote, /with the Motion Study sample project\./);
  assert.doesNotMatch(studyNote, /After the Tide|AI-generated|Mac App Store/);

  // Mac screens of After the Tide come from the Mac App Store build. The note says so and
  // does not say that build can be downloaded.
  const mac = Object.keys(native.images).filter(id => native.images[id].device === 'Mac');
  const macNote = nativeCaptureNote({ native, shown: mac });
  assert.ok(macNote.includes(disclosure));
  assert.ok(macNote.includes('come from a Mac App Store build of Arya 1.1.0 that is not public. Screens in the direct Mac build can differ.'));
  for (const id of mac) assert.equal(native.images[id].edition === 'Mac App Store', native.images[id].project === 'After the Tide', id);
  const phone = nativeCaptureNote({ native, shown: ['iphone-edit', 'iphone-deliver'], mobileURL: 'https://apps.apple.com/app/id1', mobileVersion: '1.1.0' });
  assert.doesNotMatch(phone, /Mac App Store/);

  const all = nativeCaptureNote({ native, shown: [...Object.keys(native.images), 'after-the-tide'], mobileURL: 'https://apps.apple.com/app/id1', mobileVersion: '1.1.0' });
  assert.match(all, /with the After the Tide and Motion Study sample projects\./);
  assert.ok(all.includes(disclosure));

  // The clip alone still carries the disclosure.
  assert.ok(nativeCaptureNote({ native, shown: ['after-the-tide'] }).includes(disclosure));
});

test('every After the Tide picture on the home page sits beside its disclosure', () => {
  assert.equal(live.result.status, 0, live.result.stderr);
  const tide = Object.values(native.images).filter(item => item.project === 'After the Tide');
  assert.ok(tide.length >= 2 && native.clips['after-the-tide'].project === 'After the Tide');
  // Under the device stage, under each capture further down that shows the picture, and under the clip.
  const pictured = ['mac-media-panel', 'mac-edit'];
  assert.equal(native.stills['After the Tide'], disclosure);
  assert.ok(native.projects['After the Tide'].startsWith(disclosure));
  for (const id of pictured) {
    assert.equal(native.images[id].still, true, id);
    const start = live.home.indexOf(`native-${id}.webp`);
    assert.ok(live.home.slice(start, live.home.indexOf('</figure>', start)).includes(disclosure), id);
  }
  assert.equal(live.home.split(disclosure).length - 1, 2 + pictured.length);
  // Panels that show no picture carry no flag.
  for (const id of ['mac-color-inspector', 'ipad-color-inspector', 'iphone-deliver']) assert.ok(!native.images[id].still, id);
  const stage = live.home.slice(live.home.indexOf('<figure class="family"'), live.home.indexOf('</figure>', live.home.indexOf('<figure class="family"')));
  assert.ok(stage.includes('native-iphone-edit.webp') && stage.includes(disclosure));
  const clip = live.home.slice(live.home.indexOf('<figure class="chapter-figure figure-clip">'), live.home.indexOf('</figure>', live.home.indexOf('<figure class="chapter-figure figure-clip">')));
  assert.ok(clip.includes('after-the-tide.mp4') && clip.includes(disclosure));
  // It is a generated still with editable layers. Nothing calls it footage or a camera original.
  assert.doesNotMatch(text(live.home), /After the Tide[^.]*(footage|filmed|shot on)|camera footage|live.action/i);
});

test('the exported clip never plays by itself and has a text alternative', () => {
  const video = live.home.match(/<video\b[^>]*>/g).find(tag => tag.includes('after-the-tide-poster'));
  assert.equal(live.home.match(/<video\b/g).length, 2);
  for (const attribute of ['controls', 'playsinline', 'preload="none"', 'poster="/assets/product/after-the-tide-poster.webp?v=', 'width="1280"', 'height="720"', 'aria-label="A 12 second clip without sound.']) assert.ok(video.includes(attribute), attribute);
  assert.doesNotMatch(video, /autoplay|loop|muted/);
  assert.match(live.home, /<source src="\/assets\/product\/after-the-tide\.mp4\?v=[0-9a-f]{12}" type="video\/mp4"><a href="\/assets\/product\/after-the-tide\.mp4\?v=[0-9a-f]{12}">Open the exported clip<\/a><\/video>/);
  assert.ok(text(live.home).includes('shown here as a 720p copy without sound'));
});

test('the launch film plays only when started and sits under the hero', () => {
  const start = live.home.indexOf('<section class="launch-film"');
  assert.ok(start > live.home.indexOf('<section class="hero">') && start < live.home.indexOf('<section class="pages"'));
  const section = live.home.slice(start, live.home.indexOf('</section>', start));
  const [video] = section.match(/<video\b[^>]*>/);
  for (const attribute of ['controls', 'playsinline', 'preload="none"', 'poster="/assets/film/launch-film-poster.webp?v=', 'width="1920"', 'height="1080"', 'aria-label="The Arya launch film, 75 seconds with narration and music.']) assert.ok(video.includes(attribute), attribute);
  assert.doesNotMatch(video, /autoplay|loop|muted/);
  assert.match(section, /<source src="\/assets\/film\/launch-film\.mp4\?v=[0-9a-f]{12}" type="video\/mp4"><a href="\/assets\/film\/launch-film\.mp4\?v=[0-9a-f]{12}">Download the launch film<\/a><\/video>/);
  assert.doesNotMatch(section, /<figcaption/);
  assert.doesNotMatch(text(section), /on the Mac App Store|available on the Mac App Store/);
});

test('the launch film is hidden while its narration would not be true', async () => {
  assert.doesNotMatch(macOnly.home, /launch-film/);
  const unpublished = await build({ ...shipped, publicSourceURL: null });
  assert.equal(unpublished.result.status, 0, unpublished.result.stderr);
  assert.doesNotMatch(unpublished.home, /launch-film/);
});

test('every image, poster and clip the home page loads is reviewed, versioned and packaged', async () => {
  const targets = [
    ...[...live.home.matchAll(/\b(?:src|srcset|poster)="(\/assets\/[^"]+)"/g)].map(match => match[1]),
    ...[...live.home.matchAll(/<a class="(?:figure-link|workspace-tab)[^"]*" href="(\/assets\/[^"]+)"/g)].map(match => match[1]),
  ];
  assert.ok(targets.length > 20);
  for (const target of new Set(targets)) {
    assert.doesNotMatch(target, /\s/, `${target} must be one file, not a list`);
    const [path, version] = target.split('?v=');
    assert.ok(allowlist.includes(path.slice(1)), `${path} is not in public-files.json`);
    const bytes = await readFile(join(root, path));
    if (version !== undefined) assert.equal(version, createHash('sha256').update(bytes).digest('hex').slice(0, 12), `${path} has a stale version`);
  }
  for (const item of [...Object.values(native.images), ...Object.values(native.clips)]) {
    assert.ok(allowlist.includes(item.src.slice(1)), `${item.src} is not in public-files.json`);
    assert.ok(item.project in native.projects && item.device && item.page && item.label);
    if (item.poster) assert.ok(allowlist.includes(item.poster.slice(1)));
    else assert.ok(item.alt.startsWith(`${item.label.split(' on ')[0]}`) || item.alt.includes(item.device), `${item.src} needs alt text that names what it shows`);
  }
});

test('iPad and iPhone screens appear only while the App Store release is live', () => {
  assert.equal(macOnly.result.status, 0, macOnly.result.stderr);
  // Live: three device layers, phone first so a narrow screen starts on it.
  assert.deepEqual([...live.home.matchAll(/class="family-layer family-([a-z]+)"/g)].map(match => match[1]), ['iphone', 'ipad', 'mac']);
  assert.ok(live.home.includes('<meta name="apple-itunes-app" content="app-id=6826357116">'));
  assert.ok(live.download.includes('<meta name="apple-itunes-app" content="app-id=6826357116">'));
  assert.ok(live.home.includes('<h2 id="closing-heading">Start your first cut.</h2>'));
  assert.ok(text(live.home).includes('Arya 1.0.5 for iPhone and iPad is on the App Store.'));

  // Not live: the Mac alone, no clip, no claim about the other devices.
  assert.deepEqual([...macOnly.home.matchAll(/class="family-layer family-([a-z]+)"/g)].map(match => match[1]), ['mac']);
  assert.ok(macOnly.home.includes('<figure class="family family-solo"'));
  assert.doesNotMatch(macOnly.home, /native-iphone|native-ipad|after-the-tide|<video|apple-itunes-app|closing-ios|apps\.apple\.com/);
  assert.doesNotMatch(text(macOnly.home), /Edit on iPhone|Color on iPad|Deliver on iPhone|Exported on iPhone/);
  assert.match(text(macOnly.home), /Captured from Arya 1\.1 on Mac, November 2026, with the After the Tide and Motion Study sample projects\./);
  assert.ok(text(macOnly.home).includes(disclosure));
  assert.ok(macOnly.home.includes('<article class="chapter chapter-text" id="deliver"'));
  assert.ok(macOnly.home.includes('<h2 id="closing-heading">Start cutting on your Mac.</h2>'));
  assert.doesNotMatch(macOnly.download, /apple-itunes-app/);
});

test('the six pages keep the app’s tab order and native screens stay apart from browser screens', () => {
  assert.deepEqual([...live.home.matchAll(/<article class="chapter chapter-[a-z]+" id="([a-z]+)"/g)].map(match => match[1]), ['media', 'edit', 'motion', 'color', 'audio', 'deliver']);
  assert.deepEqual([...live.home.matchAll(/<nav class="page-rail"[^>]*>(.*?)<\/nav>/gs)].flatMap(match => [...match[1].matchAll(/href="#([a-z]+)"/g)].map(link => link[1])), ['media', 'edit', 'motion', 'color', 'audio', 'deliver']);
  // A browser capture is never labelled as a device, and a native capture is never labelled as the browser editor.
  for (const [figure] of live.home.matchAll(/<figure\b[^>]*>.*?<\/figure>/gs)) {
    const label = /<span class="plate-label">([^<]+)<\/span>/.exec(figure)?.[1];
    if (!label) continue;
    const isNative = /native-(?:mac|ipad|iphone)-|after-the-tide/.test(figure);
    assert.equal(/ on (?:Mac|iPad|iPhone)$/.test(label), isNative, `${label} labels the wrong kind of screen`);
    if (!isNative) assert.equal(label, 'Browser editor');
  }
  assert.ok(text(live.home).includes('Screens labelled Mac, iPad or iPhone are from the native apps. Screens labelled Browser editor are from the browser editor.'));
  // No sentence on the page ties the assistant or a provider sign-in to iPhone or iPad.
  const sentences = text(live.home.slice(live.home.indexOf('<main'), live.home.indexOf('</main>'))).split(/(?<=[.?!])\s+/);
  assert.ok(sentences.length > 100);
  for (const sentence of sentences) assert.ok(!(/iPhone|iPad/.test(sentence) && /assistant|Claude|Codex|Antigravity|sign-in|\bAI\b/i.test(sentence)), sentence.slice(0, 200));
});

test('the build refuses native media it cannot vouch for', async () => {
  const change = edit => { const copy = structuredClone(native); edit(copy); return copy; };
  const cases = [
    [change(copy => { copy.images['mac-edit'].src = 'https://example.com/native-mac-edit.webp'; }), /A native capture must be a local reviewed WebP image/],
    [change(copy => { copy.images['iphone-edit'].project = 'Unlisted'; }), /A native capture must name its sample project/],
    [change(copy => { copy.clips['after-the-tide'].src = '/assets/product/after-the-tide.mov'; }), /A native clip must be a local reviewed MP4 file with a WebP poster/],
    [change(copy => { copy.clips['after-the-tide'].project = 'Unlisted'; }), /A native clip must name its sample project/],
    [change(copy => { delete copy.clips; }), /The home page needs the exported clip/],
    [change(copy => { delete copy.images['iphone-deliver']; }), /The home page needs every native capture/],
    [change(copy => { copy.version = 'next'; }), /Native captures must name the app version/],
  ];
  for (const [file, message] of cases) {
    const attempt = await build(shipped, file);
    assert.notEqual(attempt.result.status, 0);
    assert.match(attempt.result.stderr, message);
  }
});

test('a clip is packaged only with its poster on the allowlist', async t => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'arya-launch-package-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const put = async (name, value) => { const path = join(repo, name); await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, value); };
  await put('LICENSE', 'MIT License\n'); await put('THIRD_PARTY_NOTICES.md', 'Notices\n');
  await put('site/index.html', '<h1>Arya</h1><video controls poster="/assets/product/clip-poster.webp?v=1"><source src="/assets/product/clip.mp4?v=1" type="video/mp4"></video>');
  await put('site/404.html', '<h1>Page not found</h1>');
  await put('site/assets/product/clip.mp4', 'clip'); await put('site/assets/product/clip-poster.webp', 'poster');
  await put('editor/browser-public-files.json', JSON.stringify([{ source: 'web/browser-local.html', target: 'editor/index.html' }, { source: 'web/browser-local/bootstrap.js', target: 'editor/browser-local/bootstrap.js' }]));
  await put('editor/web/browser-local.html', '<script type="module" src="./browser-local/bootstrap.js"></script>');
  await put('editor/web/browser-local/bootstrap.js', '');

  await put('site/public-files.json', JSON.stringify(['index.html', '404.html', 'assets/product/clip.mp4']));
  await assert.rejects(preparePublicOutput({ repoRoot: repo, outputRoot: join(base, 'first') }), /Unmapped asset \/assets\/product\/clip-poster\.webp/);
  await put('site/public-files.json', JSON.stringify(['index.html', '404.html', 'assets/product/clip-poster.webp']));
  await assert.rejects(preparePublicOutput({ repoRoot: repo, outputRoot: join(base, 'second') }), /Unmapped asset \/assets\/product\/clip\.mp4/);
  await put('site/public-files.json', JSON.stringify(['index.html', '404.html', 'assets/product/clip.mp4', 'assets/product/clip-poster.webp']));
  await preparePublicOutput({ repoRoot: repo, outputRoot: join(base, 'third') });
  assert.equal(await readFile(join(base, 'third/.vercel/output/static/assets/product/clip.mp4'), 'utf8'), 'clip');
  // Other media types stay out.
  await put('site/public-files.json', JSON.stringify(['index.html', '404.html', 'assets/product/clip.mp4', 'assets/product/clip-poster.webp', 'assets/product/clip.mov']));
  await assert.rejects(preparePublicOutput({ repoRoot: repo, outputRoot: join(base, 'fourth') }), /Unexpected website file: assets\/product\/clip\.mov/);
});

test('the device stage moves once on load, and not at all with reduced motion or on a phone', () => {
  const motion = css.indexOf('@media(prefers-reduced-motion:no-preference){');
  assert.ok(motion > 0);
  assert.equal(css.split('animation:layer-in').length - 1, 1);
  assert.ok(css.indexOf('animation:layer-in') > motion && css.indexOf('@keyframes layer-in') > motion);
  assert.ok(css.includes('@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*,*:before,*:after{animation:none!important;transition:none!important}}'));
  const phone = css.slice(css.indexOf('@media(max-width:760px){'), css.indexOf('@media(max-width:650px){'));
  assert.ok(phone.includes('scroll-snap-type:x mandatory') && phone.includes('animation:none'));
  // Device labels are links, so they keep a 44px touch height on a phone.
  assert.ok(phone.includes('.family-tag,.family-mac .family-tag,.family-iphone .family-tag{position:static;display:inline-flex;align-items:center;min-height:44px}'));
});

test('the link preview image exists at the size the metadata declares and makes no dated claim', async () => {
  const live = await build(shipped);
  assert.equal(live.result.status, 0, live.result.stderr);
  const image = live.home.match(/property="og:image" content="([^"]+)"/)[1];
  assert.equal(image, `${shipped.siteURL}/assets/brand/link-preview.png`);
  assert.ok(live.home.includes(`name="twitter:image" content="${image}"`));
  const path = new URL(image).pathname.slice(1);
  assert.ok(allowlist.includes(path), `${path} is not in public-files.json`);
  // A PNG starts with an 8-byte signature and an IHDR chunk: width and height at bytes 16 and 20.
  const bytes = await readFile(join(root, path));
  assert.equal(bytes.readUInt32BE(0), 0x89504e47);
  assert.equal(String(bytes.readUInt32BE(16)), live.home.match(/property="og:image:width" content="(\d+)"/)[1]);
  assert.equal(String(bytes.readUInt32BE(20)), live.home.match(/property="og:image:height" content="(\d+)"/)[1]);
  assert.ok(live.home.includes('property="og:image:type" content="image/png"'));
  assert.ok(bytes.length < 400_000, 'link previews should stay small');
  // Previews are cached for a long time, so the words on the image and its alt text name what
  // is shown and promise nothing about platforms, prices, sign-in or the assistant.
  const source = await readFile(join(root, '../docs/design/link-preview.html'), 'utf8');
  const words = source.slice(source.indexOf('<main')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(words, 'Your edit. Every layer. Editing, motion, color and delivery in one project.');
  for (const alt of [live.home.match(/property="og:image:alt" content="([^"]+)"/)[1], live.home.match(/name="twitter:image:alt" content="([^"]+)"/)[1]]) {
    assert.match(alt, /Color inspector/);
    assert.doesNotMatch(`${alt} ${words}`, /\b(AI|assistant|sign in|free|iPhone|iPad|App Store)\b/i);
  }
  // The earlier artwork stays published so previews that platforms cached still resolve.
  assert.ok(allowlist.includes('assets/brand/social.png'));
});

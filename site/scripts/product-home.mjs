// Home page. Every product claim here must be true of the code today; see site/README.md.
// Downloads are free with optional contributions. Checkout controls require a configured provider.
//
// The page answers one question: is Arya a real editor I can use on my device today, and what
// does it cost? The order follows that: availability, the app on each device, the six pages the
// app is built from, then limits and answers.
export const footageCredit = 'Footage: <cite>Tears of Steel</cite>, (CC) Blender Foundation, <a href="https://mango.blender.org/" rel="noopener noreferrer">mango.blender.org</a>, licensed <a href="https://creativecommons.org/licenses/by/3.0/" rel="noopener noreferrer">CC BY 3.0</a>.';
export const betaRequestsClosed = 'Beta requests open when the form on the download page is connected.';

// Every assistant claim on the home page is in this object, so it can be reviewed and changed in
// one place. It covers the Mac app and the local browser editor only. The home page makes no
// assistant claim for iPhone and iPad; add that wording here once the supported sign-in routes
// are confirmed.
const assistantProviders = 'Claude Code, Codex or Google Antigravity';
export const assistantCopy = {
  providers: assistantProviders,
  scope: 'In the Mac app and the local browser editor',
  heading: 'Ask in plain words. Undo like any edit.',
  lead: 'Select clips, a title or a range and describe what should change. The assistant reads your selection, playhead, transcript and rendered frames, then edits through the same timeline operations you use by hand.',
  points: [
    ['Ordinary edits, not a black box.', 'Every change comes with a receipt of what changed and reverses with Undo.'],
    ['Bring your own account.', `Connect ${assistantProviders} through the provider’s official sign-in. Arya includes no AI credits.`],
    ['Always optional.', 'Every timeline, color, motion and audio tool works offline without an assistant.'],
  ],
  link: ['/install/#accounts', 'How assistant sign-in works'],
  // The "AI assistant" row of What works where: Mac app, local browser editor, hosted browser editor.
  editions: [
    `Connect your own ${assistantProviders} account. Ordinary timeline edits with a change receipt and Undo.`,
    `Connect your own ${assistantProviders} account through the local server.`,
    'Not available in the hosted browser editor.',
  ],
  faq: ['Do I need an AI subscription?', `No. Editing, grading, motion, audio and export all work without an assistant. Connecting your own ${assistantProviders} account is optional.`],
};

// Arya Pro in the App Store edition: iPhone, iPad and the Mac App Store edition, one purchase across
// all three. Every Pro sentence on the site comes from here and shows only when
// config.mobileRelease.pro is true and the App Store release is live. The direct Mac download and
// the browser editor never need Pro. Prices vary by storefront, so no page states one.
export const proCopy = {
  short: 'Free editing and 1080p export. Arya Pro adds 4K, ProRes and HDR.',
  store: 'In the App Store edition, editing and 1080p export are free, and Arya Pro adds 4K, ProRes and HDR export.',
  free: 'Editing and export up to 1080p are free, with no watermark, ads or account.',
  adds: 'Arya Pro adds export above 1080p (4K and up to 8K), Apple ProRes 422, 422 HQ and 4444, and HDR10 (PQ) and HLG delivery.',
  universal: 'One Arya Pro purchase covers iPhone, iPad and the Mac App Store edition.',
  plans: 'Choose a monthly plan, a yearly plan with a one-week free trial, or a one-time lifetime purchase. Plans and prices are shown in the app.',
  early: 'If you installed Arya from the App Store before version 1.2.0, Arya Pro is included at no charge.',
  direct: 'The Mac download from this site and the browser editor stay free and never need Arya Pro.',
};

// The launch film. Its narration says Arya is free for Mac, on iPhone and iPad, and open source,
// so the home page shows it only while all three are true. What is in it is recorded in
// assets/film/README.md.
export const launchFilmCopy = {
  heading: 'Why Arya exists.',
  lead: 'A 75 second film with sound, from a single shot in 1895 to the edit you make today.',
  description: 'The Arya launch film, 75 seconds with narration and music. The narration appears on screen as it is spoken.',
  width: 1920, height: 1080,
};

// The six pages of the app, in the order of its tab bar.
export const pageNames = ['Media', 'Edit', 'Motion', 'Color', 'Audio', 'Deliver'];

export function primaryAction(releaseReady, accessURL) {
  if (releaseReady) return { href: '/download/#mac', label: 'Download for Mac', short: 'Download for Mac' };
  return { href: '/download/#access', label: accessURL ? 'Request beta access' : 'Beta access', short: accessURL ? 'Request access' : 'Beta access' };
}

// Native screens are captured from one app version. When a downloadable version is older or
// newer, the caption says so. It never describes a version that is not available. It also names
// the sample projects on screen, says what their media is, and says when a screen comes from a
// build other than the one this site offers.
const minorVersion = value => String(value || '').split('.').slice(0, 2).join('.');
const listed = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
export function nativeCaptureNote({ native, shown = null, releaseReady = false, version = null, mobileURL = null, mobileVersion = null }) {
  const devices = mobileURL ? 'Mac, iPad and iPhone' : 'Mac';
  const items = (shown || Object.keys(native.images)).map(id => native.images[id] || native.clips?.[id]);
  const projects = [...new Set(items.map(item => item.project))];
  const media = [...projects.map(name => native.projects?.[name]), ...new Set(items.map(item => native.editions?.[item.edition]))].filter(Boolean).join(' ');
  const differing = [];
  if (releaseReady && minorVersion(version) !== minorVersion(native.version)) differing.push(`Arya ${version} for Mac`);
  if (mobileURL && minorVersion(mobileVersion) !== minorVersion(native.version)) differing.push(`Arya ${mobileVersion} for iPhone and iPad`);
  const current = differing.length === 2
    ? ` The current downloads are ${differing.join(' and ')}. Screens in those versions can differ.`
    : differing.length === 1 ? ` The current download is ${differing[0]}. Screens in that version can differ.` : '';
  return `Captured from Arya ${native.version} on ${devices}, ${native.captured}, with the ${listed(projects)} sample project${projects.length > 1 ? 's' : ''}.${media ? ` ${media}` : ''}${current}`;
}

export function productHome({ button, link, faq, stage, shots, figures, native, film = null, releaseReady = false, publicSource = null, accessURL = null, browserEditor = null, mobileURL = null, mobileVersion = null, pro = false, contributionsConfigured = false, version = '1.0.0', size = '104 MB', minimumOS = 'macOS 14', architectures = 'Apple silicon and Intel' }) {
  if (!Array.isArray(shots) || shots.length !== 4 || shots[0].id !== 'edit') throw new Error('The home gallery needs four verified captures, starting with Edit');
  const nativeIds = ['mac-color', 'mac-edit', 'ipad-color', 'iphone-edit', 'mac-color-inspector', 'mac-motion-inspector', 'mac-media-panel', 'ipad-color-inspector', 'iphone-deliver'];
  if (!native?.images || nativeIds.some(id => !native.images[id])) throw new Error('The home page needs every native capture listed in assets/product/native.json');
  if (!native.clips?.['after-the-tide']) throw new Error('The home page needs the exported clip listed in assets/product/native.json');
  // What a visitor can see: iPad and iPhone screens and the iPhone export appear only while the App Store release is live.
  const shownIds = mobileURL ? [...nativeIds, 'after-the-tide'] : nativeIds.filter(id => native.images[id].device === 'Mac');
  const action = primaryAction(releaseReady, accessURL);
  const shot = id => native.images[id];
  // A capture that shows a sample project's picture says what that picture is, in its own caption.
  const pictured = item => {
    if (!item.still) return '';
    if (!native.stills?.[item.project]) throw new Error(`native.json needs a stills note for ${item.project}`);
    return ` ${native.stills[item.project]}`;
  };

  // A browser editor figure. It is always labelled as such and never sits under a device name.
  const figure = (id, label = 'Browser editor') => {
    const item = figures[id];
    if (!item) throw new Error(`Missing chapter figure ${id}`);
    return `<figure class="chapter-figure figure-${id}"><a href="${item.src}" class="figure-link"><img src="${item.src}" alt="${item.alt}" width="${item.width}" height="${item.height}" loading="lazy" decoding="async"></a><figcaption>${label ? `<span class="plate-label">${label}</span> ` : ''}${item.caption}</figcaption></figure>`;
  };
  // A native capture, labelled with its device. `small` swaps in a detail of the same screen on phones.
  const picture = (item, { small = null, eager = false } = {}) => `<picture>${small ? `<source media="(max-width:760px)" srcset="${small.src}" width="${small.width}" height="${small.height}">` : ''}<img src="${item.src}" alt="${item.alt}" width="${item.width}" height="${item.height}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"></picture>`;
  const plate = id => {
    const item = shot(id);
    return `<figure class="plate plate-${id}"><div class="plate-frame">${picture(item)}</div><figcaption><span class="plate-label">${item.label}</span> ${item.caption}${pictured(item)}</figcaption></figure>`;
  };
  // A clip the native app exported. It plays only when the visitor starts it.
  const clipFigure = id => {
    const clip = native.clips[id];
    return `<figure class="chapter-figure figure-clip"><video controls playsinline preload="none" poster="${clip.poster}" width="${clip.width}" height="${clip.height}" aria-label="${clip.description}"><source src="${clip.src}" type="video/mp4"><a href="${clip.src}">Open the exported clip</a></video><figcaption><span class="plate-label">${clip.label}</span> ${clip.caption} ${native.projects?.[clip.project] || ''}</figcaption></figure>`;
  };
  const launchFilm = film && releaseReady && mobileURL && publicSource
    ? `<section class="launch-film" id="film" aria-labelledby="launch-film-heading">
<div class="wrap">
<div class="section-head"><h2 id="launch-film-heading">${launchFilmCopy.heading}</h2><p>${launchFilmCopy.lead}</p></div>
<figure class="launch-film-figure"><video controls playsinline preload="none" poster="${film.poster}" width="${launchFilmCopy.width}" height="${launchFilmCopy.height}" aria-label="${launchFilmCopy.description}"><source src="${film.src}" type="video/mp4"><a href="${film.src}">Download the launch film</a></video></figure>
</div>
</section>
`
    : '';
  const gallery = shots.map((item, index) => `<a class="workspace-tab" href="${item.src}" data-workspace="${item.id}" data-src="${item.src}" data-alt="${item.alt}" data-caption="${item.caption}" aria-current="${index === 0}" aria-controls="workspace-image workspace-caption">${item.label}</a>`).join('');

  const releaseLine = releaseReady
    ? `${minimumOS} or later · free · ${architectures}`
    : `Private beta for Mac, by invitation. The public download is not available yet.${accessURL ? '' : ` ${betaRequestsClosed}`}`;
  const captureNote = nativeCaptureNote({ native, shown: shownIds, releaseReady, version, mobileURL, mobileVersion });

  // Availability: one row per place Arya runs, with the state it is really in.
  const ledger = [
    `<li class="ledger-row ledger-mac"><div class="ledger-what"><strong>Mac</strong><span>${releaseReady ? `Arya ${version}. ${minimumOS} or later, ${architectures}. Free.` : releaseLine}</span></div>${button(action.href, action.label)}</li>`,
    mobileURL
      ? `<li class="ledger-row ledger-ios"><div class="ledger-what"><strong>iPhone and iPad</strong><span>Arya ${mobileVersion} on the App Store. ${pro ? proCopy.short : 'Free core editor.'}</span></div>${button(mobileURL, 'Download on the App Store')}</li>`
      : '<li class="ledger-row ledger-later"><div class="ledger-what"><strong>iPhone and iPad</strong><span>Coming later. There is no public download yet.</span></div></li>',
    browserEditor ? `<li class="ledger-row ledger-browser"><div class="ledger-what"><strong>Browser</strong><span>No install. No AI assistant, Figma import or transcription.</span></div>${button(browserEditor, 'Try in your browser <span class="button-badge">Limited</span>', 'secondary')}</li>` : '',
  ].join('');

  // The app on each device. iPad and iPhone screens appear only while the App Store release is live.
  const layer = (id, kind, options) => `<div class="family-layer family-${kind}"><a class="family-tag" href="${shot(id).src}" aria-label="${shot(id).label}. Open the capture at full size.">${shot(id).label}</a>${picture(shot(id), options)}</div>`;
  const family = `<figure class="family${mobileURL ? '' : ' family-solo'}">
<div class="family-stage">
${mobileURL ? `${layer('iphone-edit', 'iphone', { eager: true })}
${layer('ipad-color', 'ipad', { small: shot('ipad-color-inspector'), eager: true })}
` : ''}${layer('mac-color', 'mac', { small: shot('mac-color-inspector'), eager: true })}
</div>
<figcaption class="credit">${captureNote}</figcaption>
</figure>`;

  // The six pages. Copy is the reviewed suite and craft copy; each screen is labelled with where it was captured.
  // Layouts: plate (copy beside a native panel), duo (copy and a browser figure beside a native panel),
  // side (copy beside a browser figure), wide (copy above a whole window), text (copy only).
  const chapters = [
    {
      id: 'media', statement: 'Bring your footage in.',
      text: `On Mac, use Import Media or drag files into Arya, and your project file and media stay in the local folder you choose.${mobileURL ? ' On iPhone and iPad, add media from Files or Photos.' : ''}`,
      layout: 'plate', plate: plate('mac-media-panel'),
    },
    {
      id: 'edit', statement: 'Cut on a multitrack timeline.',
      text: 'Blade, ripple, roll, slip and slide on a multitrack timeline, with snapping, markers, automatic proxies, nested compositions and multicam with audio sync for up to nine angles.',
      layout: 'wide', figure: `<figure class="chapter-figure figure-mac-edit"><a class="figure-link" href="${shot('mac-edit').src}">${picture(shot('mac-edit'))}</a><figcaption><span class="plate-label">${shot('mac-edit').label}</span> ${shot('mac-edit').caption}${pictured(shot('mac-edit'))}</figcaption></figure>`,
    },
    {
      id: 'motion', statement: 'Keyframes, expressions and real layers.',
      text: 'Animate position, scale, rotation and opacity with easing presets or custom curves in the value and speed graphs. Write expressions such as <code>wiggle(2, 30)</code>, parent layers to nulls, draw masks, apply alpha or luma track mattes and drive layers from a point or box tracker.',
      layout: 'duo', plateFirst: true, plate: plate('mac-motion-inspector'), figure: figure('motion'),
    },
    {
      id: 'color', statement: 'Grade with nodes, then check the scopes.',
      text: 'Build serial, parallel and layer-mixer graphs. Each corrector has its own lift, gamma, gain and offset wheels, curves, HSL qualifier and circle, rectangle or linear window. Load .cube LUTs, copy grades across clips and read the signal on the waveform, RGB parade, vectorscope and histogram.',
      layout: 'duo', plateFirst: true, plate: plate('mac-color-inspector'), figure: figure('color'),
    },
    {
      id: 'audio', statement: 'Mix to a loudness target.',
      text: 'Every track has a fader, pan and an effect rack with parametric EQ, compressor, gate, de-esser, limiter, reverb and delay. Clean dialogue with denoise and voice cleanup, measure integrated LUFS and true peak, then normalize clips to -14, -16 or -23 LUFS.',
      layout: 'side', figure: figure('audio'),
    },
    {
      id: 'deliver', statement: 'Export the file you need.',
      text: `Arya reads and writes FCPXML, OpenTimelineIO, SRT and WebVTT, and exports H.264, HEVC, ProRes 422, 422 HQ and 4444, GIF, PNG sequences, WAV and AAC. <a href="#editions">What each edition exports</a> is listed below.${pro && mobileURL ? ` ${proCopy.store}` : ''}`,
      layout: mobileURL ? 'duo' : 'text', plate: mobileURL ? plate('iphone-deliver') : '', figure: mobileURL ? clipFigure('after-the-tide') : '',
    },
  ].map((chapter, index) => {
    const name = pageNames[index];
    return `<article class="chapter chapter-${chapter.layout}" id="${chapter.id}" aria-labelledby="${chapter.id}-heading" data-chapter>
<div class="chapter-head"><h3 id="${chapter.id}-heading"><em>${name}</em> <span>${chapter.statement}</span></h3><p>${chapter.text}</p></div>
${chapter.plateFirst ? `${chapter.plate}${chapter.figure}` : `${chapter.figure || ''}${chapter.plate || ''}`}
</article>`;
  }).join('\n');
  const rail = pageNames.map(name => `<a href="#${name.toLowerCase()}">${name}</a>`).join('');

  const whatWorksWhere = [
    ['Editing', 'Full multitrack timeline, local project folders, automatic proxies, FCPXML and OTIO, ProRes 4444 and PNG alpha export.', 'Full timeline, proxies and render queue via local server. ProRes 4444 and PNG alpha export, plus CMX 3600 EDL.', 'Full timeline in browser storage (IndexedDB). Exports H.264, HEVC, WAV and AAC up to 5 minutes. No FCPXML or OTIO.'],
    ['Color', 'Serial, parallel and layer-mixer nodes, wheels, curves, HSL qualifiers, windows, .cube LUTs, four scopes and reference matching.', 'Included (renders Rec. 709).', 'Included (renders Rec. 709).'],
    ['Motion', 'Keyframes, value and speed graphs, expressions, vector titles and shapes, masks, track mattes, parenting, point and box tracker.', 'Included (point and box tracker; no planar tracker).', 'Included (point and box tracker; no planar tracker).'],
    ['Audio', 'Track mixer, EQ, dynamics, reverb, delay, denoise, voice cleanup, LUFS and true-peak metering, normalize to -14, -16 or -23 LUFS.', 'Included, with offline LUFS measurement and normalization.', 'Track mixer, effects, loudness metering and normalization. No denoise or voice cleanup.'],
    ['Shorts and transcription', '9:16, 1:1 and 16:9 compositions, reframing, four caption styles, and transcription with Apple Speech, on device where the Mac supports it.', 'Included, with local transcription when whisper.cpp is installed.', 'Vertical and square projects only. No transcription, captions or shorts tools.'],
    ['AI assistant', ...assistantCopy.editions],
    ['Figma import', 'Import frames as editable text, shape and nested layers with a personal access token, or paste Figma MCP node data.', 'Import frames with a personal access token, or ask Claude Code with the Figma MCP server through /reel.', 'Not available in the hosted browser editor.'],
  ].map(([feature, mac, local, hosted]) => `<tr><th scope="row">${feature}</th><td data-label="Mac app">${mac}</td><td data-label="Local browser editor">${local}</td><td data-label="Hosted browser editor">${hosted}</td></tr>`).join('');
  const switching = [
    ['Final Cut Pro', 'Import FCPXML files and .fcpxmld bundles, and export FCPXML.', 'Generators arrive as solid colors, multicam clips as their active angle and variable speed as one constant speed.'],
    ['DaVinci Resolve', 'Move timelines as FCPXML or OpenTimelineIO. Grades use a node graph with wheels, curves, qualifiers and windows.', 'Resolve grades and Fusion compositions do not import.'],
    ['Premiere Pro', 'Bring captions as SRT or WebVTT. Send a cut list as a CMX 3600 EDL from the local browser editor.', 'Premiere XML and AAF are not supported, and EDL is export only.'],
    ['After Effects', 'Precompose, parenting, track mattes, masks and expressions such as wiggle and loopOut.', 'No planar tracking and no third-party plug-ins.'],
    ['Opus Clip', 'Passage suggestions quote the transcript they come from. Each short stays an editable composition.', 'Suggestion scores rank structure only. They do not predict views.'],
  ].map(([from, carries, missing]) => `<tr><th scope="row">${from}</th><td data-label="Carries over">${carries}</td><td data-label="Not yet">${missing}</td></tr>`).join('');
  const downloadAnswer = releaseReady
    ? `Yes. Arya ${version} for Mac is on the download page with its version, requirements and SHA-256 checksum. It is free, signed, notarized and licensed under MIT. ${mobileURL ? `Arya ${mobileVersion} is also available on the App Store for iPhone and iPad.${pro ? ` ${proCopy.store}` : ''}` : 'iPhone and iPad builds are coming later.'}`
    : `Not yet. Arya is in a private beta by invitation. The Mac app needs final interface checks, a signed package and Apple notarization before a public download. ${accessURL ? 'You can request beta access on the download page.' : betaRequestsClosed}`;

  // What each place gives you. Facts only, each one already stated on a guide page or in the table below.
  const platforms = [
    `<article class="platform"><h3>Mac</h3><p class="platform-state">${releaseReady ? `Arya ${version}, a ${size} notarized universal DMG for ${minimumOS} or later.` : 'Private beta, by invitation.'}</p><ul><li>Local project folders with automatic proxies.</li><li>FCPXML and OpenTimelineIO interchange, with ProRes 4444 and PNG alpha export.</li><li>Assistant connections, Figma import and transcription with Apple Speech.</li></ul>${link(action.href, action.label)}</article>`,
    mobileURL
      ? `<article class="platform"><h3>iPhone and iPad</h3><p class="platform-state">Arya ${mobileVersion} on the App Store. ${pro ? proCopy.short : 'Free core editor.'}</p><ul>${pro ? `<li>${proCopy.free} ${proCopy.adds}</li><li>${proCopy.plans} ${proCopy.early}</li>` : ''}<li>Add media from Files or Photos.</li><li>New projects are saved in Arya’s Projects folder in Files. You can also open project folders you choose.</li><li>Export from Deliver. Keep Arya active until the export finishes if your device does not support background export.</li></ul>${link(mobileURL, 'Download on the App Store')}</article>`
      : '<article class="platform"><h3>iPhone and iPad</h3><p class="platform-state">Coming later. There is no public mobile download or TestFlight link yet.</p><ul><li>iPad and iPhone builds share the project format.</li></ul></article>',
    browserEditor ? `<article class="platform"><h3>Browser</h3><p class="platform-state">A hosted preview at <code>/editor/</code>, with no install.</p><ul><li>Runs in current Chrome and Edge.</li><li>Timeline editing, color grading, motion and audio, with projects kept in your browser profile.</li><li>No AI assistant, Figma import, transcription or captions.</li></ul>${link(browserEditor, 'Try in your browser')}</article>` : '',
  ].join('');

  return `<section class="hero">
<div class="wrap hero-grid">
<h1>One AI-native suite for editing, color, motion and shorts. <em>Your edit. Every layer.</em></h1>
<div class="hero-side">
<p class="lead">Work by hand on a timeline, or say what should change. Every change is an ordinary edit you can adjust and undo.</p>
<ul class="ledger" aria-label="Where you can get Arya">${ledger}</ul>
</div>
</div>
<div class="wrap">${family}</div>
</section>
${launchFilm}<section class="pages" id="suite" aria-labelledby="suite-heading">
<div class="wrap">
<div class="section-head"><h2 id="suite-heading">Six pages. One project.</h2><p>Cut, grade, animate, mix and deliver without round trips. Every workspace edits the same project file, so a grade, a title or a short stays live and editable.</p></div>
<div class="pages-grid">
<nav class="page-rail" aria-label="The six pages">${rail}</nav>
<div class="chapters">
${chapters}
</div>
</div>
<p class="credit pages-note">Screens labelled Mac${mobileURL ? ', iPad or iPhone' : ''} are from the native app${mobileURL ? 's' : ''}. Screens labelled Browser editor are from the browser editor. The Mac app's native interface does not expose every feature shown on this page yet. <a href="#editions">See what works where</a>.</p>
</div>
</section>
<section class="film" id="workspace" aria-labelledby="film-heading">
<div class="wrap">
<div class="section-head"><h2 id="film-heading">A film in the timeline.</h2><p>Four workspaces from the browser editor, with shots from <cite>Tears of Steel</cite> on the timeline. Choose one to look closer, or open it at full size.</p></div>
<div class="workspace">
<div class="workspace-tabs" role="group" aria-label="Show an Arya workspace">${gallery}</div>
<div class="workspace-frame"><img id="workspace-image" src="${shots[0].src}" alt="${shots[0].alt}" width="${shots[0].width}" height="${shots[0].height}" loading="lazy" decoding="async"></div>
<div class="workspace-meta"><p class="workspace-caption" id="workspace-caption" aria-live="polite">${shots[0].caption}</p><a class="workspace-full" id="workspace-full" href="${shots[0].src}">Open full size <span aria-hidden="true">↗</span></a></div>
<p class="credit">Captured from the Arya browser editor, October 2026. ${footageCredit}</p>
</div>
</div>
</section>
<section class="extras wrap" aria-label="Shorts and Figma">
<article class="extra extra-shorts" id="shorts" aria-labelledby="shorts-heading">
${figure('shorts', '')}
<div class="chapter-copy"><p class="where">In the Mac app and the local browser editor</p><h2 id="shorts-heading">Cut long recordings into editable shorts.</h2><p>Transcribe speech, search passages by topic or duration, and build each short as its own 9:16, 1:1 or 16:9 composition with linked audio, tracked reframing keyframes and captions in plain, boxed, word-highlight or one-word styles.</p></div>
</article>
<article class="extra extra-figma" id="figma" aria-labelledby="figma-heading">
<div class="chapter-copy"><p class="where">In the Mac app and the local browser editor</p><h2 id="figma-heading">Bring Figma frames in as layers.</h2><p>Import frames with a Figma personal access token. If you use the Figma MCP server in Claude Code, Claude can import frames for you. Smart Animate turns two frames into an animated transition.</p></div>
<ul class="figma-limits"><li><strong>Editable layers</strong>Text, rectangles and ellipses with a solid or gradient fill, and nested frames arrive as live Arya layers.</li><li><strong>Rendered images</strong>Complex vectors, boolean shapes, stars, polygons, lines, image fills, shadows and masked groups arrive as images you can still animate.</li><li><strong>Local token</strong>Your Figma personal access token stays on your device. Hosted OAuth sign-in is planned for a later release.</li></ul>
</article>
</section>
<section class="assistant" id="ai" aria-labelledby="ai-heading">
<div class="wrap assistant-grid">
<div class="chapter-copy"><p class="where">${assistantCopy.scope}</p><h2 id="ai-heading">${assistantCopy.heading}</h2><p>${assistantCopy.lead}</p>
<ul class="points">${assistantCopy.points.map(([lead, text]) => `<li><strong>${lead}</strong> ${text}</li>`).join('')}</ul>
${link(...assistantCopy.link)}</div>
${figure('assistant')}
</div>
</section>
<section class="platforms wrap" id="platforms" aria-labelledby="platforms-heading">
<div class="section-head"><h2 id="platforms-heading">${mobileURL ? 'On your Mac, iPhone and iPad.' : 'On your Mac.'}</h2><p>The Mac app and the browser editor share one open project format${mobileURL ? ', and the iPad and iPhone builds share it too' : ''}.</p></div>
<div class="platform-list">${platforms}</div>
</section>
<section class="editions-section wrap" id="editions" aria-labelledby="editions-heading">
<div class="section-head"><h2 id="editions-heading">What works where.</h2><p>Arya runs as a native Mac app, a local browser editor run from source, and a hosted browser preview at <code>/editor/</code>. The hosted preview keeps projects in browser storage and exports H.264, HEVC, WAV and AAC up to five minutes.</p></div>
<div class="table-wrap" tabindex="0" role="region" aria-label="What works in each Arya edition"><table class="editions-table"><thead><tr><th scope="col">Capability</th><th scope="col">Mac app (v${version})</th><th scope="col">Local browser editor (from source)</th><th scope="col">Hosted browser editor (/editor/)</th></tr></thead><tbody>${whatWorksWhere}</tbody></table></div>
</section>
<section class="switching wrap" id="switch" aria-labelledby="switch-heading">
<div class="section-head"><h2 id="switch-heading">Bring your timeline with you.</h2><p>Move timelines with FCPXML or OpenTimelineIO, and captions with SRT or WebVTT. This is what carries over from the tool you use now, and what does not yet.</p></div>
<div class="table-wrap" tabindex="0" role="region" aria-label="What carries over from other tools"><table><thead><tr><th scope="col">Coming from</th><th scope="col">What carries over</th><th scope="col">What does not, yet</th></tr></thead><tbody>${switching}</tbody></table></div>
</section>
<section class="faq-section wrap" id="faq" aria-labelledby="faq-heading">
<h2 id="faq-heading">Questions before you start</h2>
${faq([
  ['Can I download Arya now?', downloadAnswer],
  ['What is the difference between the Mac app and the browser editor?', 'The Mac app and the local browser editor (run from source) support local project folders, AI assistant connections, Figma imports and local transcription. The hosted browser editor at /editor/ runs entirely in your browser storage with no AI assistant, Figma import, transcription, captions or FCPXML and OTIO interchange.'],
  assistantCopy.faq,
  ['Where does my footage go?', 'On Mac, your project file and media stay in the local folder you choose. In the hosted browser editor, files stay in your browser profile storage. Nothing is uploaded unless you send a prompt to your connected AI provider, or the Mac app transcribes a language your Mac cannot recognize on device, which sends that audio to Apple. Read the privacy policy for details.'],
  ['Is Arya really free and open source?', publicSource ? (pro ? `Arya is open source under the MIT license, and the full source code is on GitHub. The Mac download from this site and the browser editor are free, with no subscriptions, watermarks or paid tiers. In the App Store edition for iPhone, iPad and Mac, editing and export up to 1080p are free, with no watermark, ads or account. ${proCopy.adds} ${proCopy.plans}` : 'Yes. Arya is released under the MIT license with no subscriptions, watermarks or paid tiers. The full source code is on GitHub.') : 'The repository is currently private. The plan is to publish it after a review of history, dependencies and licenses.'],
])}
</section>
<section class="layer-study-section wrap"><details class="layer-study"><summary>Explore the editable-layer illustration<span>An interactive brand study</span></summary><div class="layer-study-body"><noscript><p>Layer controls need JavaScript. The artwork remains available to view.</p></noscript><p>Afterlight is a separate illustration of editable layers. It does not run the Arya application or call an agent.</p>${stage}</div></details></section>
<section class="closing wrap" aria-labelledby="closing-heading">
<div class="closing-copy"><h2 id="closing-heading">${mobileURL ? 'Start your first cut.' : 'Start cutting on your Mac.'}</h2><p class="closing-meta">${releaseReady ? `Arya ${version} for Mac is a ${size} notarized universal DMG for ${minimumOS} or later.${mobileURL ? ` Arya ${mobileVersion} for iPhone and iPad is on the App Store.` : ''}${pro && mobileURL ? ` Arya is MIT licensed, and the Mac download is free. ${proCopy.store}` : ' Arya is free and MIT licensed.'}` : releaseLine}</p></div>
<div class="closing-actions">${button(action.href, action.label)}${mobileURL ? button(mobileURL, 'Download on the App Store', 'secondary closing-ios') : ''}${browserEditor ? button(browserEditor, 'Try in your browser (limited)', 'secondary') : ''}</div>
${contributionsConfigured ? (pro && mobileURL ? '<p class="closing-support">The Mac download and the browser editor are free to use. If Arya helps your work, you can <a href="/support/">support its development</a> with a one-time contribution. In the App Store edition, Arya Pro also funds development.</p>' : '<p class="closing-support">Arya is free to use. If it helps your work, you can <a href="/support/">support its development</a> with a one-time contribution.</p>') : ''}
</section>`;
}

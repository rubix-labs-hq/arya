// Home page. Every product claim here must be true of the code today; see site/README.md.
// Downloads are free with optional contributions. Checkout controls require a configured provider.
export const footageCredit = 'Footage: <cite>Tears of Steel</cite>, (CC) Blender Foundation, <a href="https://mango.blender.org/" rel="noopener noreferrer">mango.blender.org</a>, licensed <a href="https://creativecommons.org/licenses/by/3.0/" rel="noopener noreferrer">CC BY 3.0</a>.';
export const betaRequestsClosed = 'Beta requests open when the form on the download page is connected.';

export function primaryAction(releaseReady, accessURL) {
  if (releaseReady) return { href: '/download/#mac', label: 'Download for Mac', short: 'Download for Mac' };
  return { href: '/download/#access', label: accessURL ? 'Request beta access' : 'Beta access', short: accessURL ? 'Request access' : 'Beta access' };
}

export function productHome({ button, link, faq, stage, shots, figures, releaseReady = false, publicSource = null, accessURL = null, browserEditor = null, version = '1.0.0', size = '104 MB', minimumOS = 'macOS 14' }) {
  if (!Array.isArray(shots) || shots.length !== 4 || shots[0].id !== 'edit') throw new Error('The home gallery needs four verified captures, starting with Edit');
  const action = primaryAction(releaseReady, accessURL);
  const figure = id => {
    const item = figures[id];
    if (!item) throw new Error(`Missing chapter figure ${id}`);
    return `<figure class="chapter-figure figure-${id}"><a href="${item.src}" class="figure-link"><img src="${item.src}" alt="${item.alt}" width="${item.width}" height="${item.height}" loading="lazy" decoding="async"></a><figcaption>${item.caption}</figcaption></figure>`;
  };
  const gallery = shots.map((shot, index) => `<a class="workspace-tab" href="${shot.src}" data-workspace="${shot.id}" data-src="${shot.src}" data-alt="${shot.alt}" data-caption="${shot.caption}" aria-current="${index === 0}" aria-controls="workspace-image workspace-caption">${shot.label}</a>`).join('');
  const releaseLine = releaseReady
    ? `${minimumOS} or later · free · Apple silicon and Intel`
    : `Private beta for Mac, by invitation. The public download is not available yet.${accessURL ? '' : ` ${betaRequestsClosed}`}`;
  const suite = [
    ['Edit', 'Mac · Browser', 'Blade, ripple, roll, slip and slide on a multitrack timeline, with snapping, markers, automatic proxies, nested compositions and multicam with audio sync for up to nine angles.'],
    ['Color', 'Mac · Browser', 'A node graph with serial, parallel and layer-mixer nodes, lift, gamma, gain and offset wheels, curves, HSL qualifiers, circle, rectangle or linear windows, .cube LUTs and four scopes.'],
    ['Motion', 'Mac · Browser', 'Keyframes with easing and value and speed graphs, expressions, vector titles and shapes, masks, track mattes, parenting and a point and box tracker.'],
    ['Audio', 'Mac · Browser', 'A track mixer with parametric EQ, compressor, gate, de-esser, limiter, reverb and delay, plus denoise, voice cleanup and loudness measurement in LUFS and true peak.'],
    ['Shorts', 'Mac · Local', 'Transcript passages, 9:16, 1:1 and 16:9 compositions, tracked reframing with position keyframes and captions in four styles, all editable by hand.'],
    ['Figma', 'Mac · Local', 'Import a frame and get its text, rectangles, ellipses and nested frames as editable layers. Smart Animate turns two frames into an animated transition.'],
  ].map(([name, badge, text]) => `<li><div class="suite-card-head"><h3>${name}</h3><span class="edition-tag">${badge}</span></div><p>${text}</p></li>`).join('');
  const whatWorksWhere = [
    ['Editing', 'Full multitrack timeline, local project folders, automatic proxies, FCPXML and OTIO, ProRes 4444 and PNG alpha export.', 'Full timeline, proxies and render queue via local server. ProRes 4444 and PNG alpha export, plus CMX 3600 EDL.', 'Full timeline in browser storage (IndexedDB). Exports H.264, HEVC, WAV and AAC up to 5 minutes.'],
    ['Color', 'Serial, parallel and layer-mixer nodes, wheels, curves, HSL qualifiers, windows, .cube LUTs, four scopes and reference matching.', 'Included (renders Rec. 709).', 'Included (renders Rec. 709).'],
    ['Motion', 'Keyframes, value and speed graphs, expressions, vector titles and shapes, masks, track mattes, parenting, point and box tracker.', 'Included (point and box tracker; no planar tracker).', 'Included (point and box tracker; no planar tracker).'],
    ['Audio', 'Track mixer, EQ, dynamics, reverb, delay, denoise, voice cleanup, LUFS and true-peak metering, normalize to -14, -16 or -23 LUFS.', 'Included, with offline LUFS measurement and normalization.', 'Included in browser.'],
    ['Shorts and transcription', '9:16, 1:1 and 16:9 compositions, reframing, four caption styles, and on-device transcription via Apple Speech.', 'Included, with local transcription when whisper.cpp is installed.', 'Reframing and manual or SRT/WebVTT captions only. No transcription.'],
    ['AI assistant', 'Connect your own Claude Code or Codex account. Ordinary timeline edits with a change receipt and Undo.', 'Connect your own Claude Code or Codex account through the local server.', 'Not available in the hosted browser editor.'],
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
    ? `Yes. Arya ${version} for Mac is on the download page with its version, requirements and SHA-256 checksum. It is free, signed, notarized and licensed under MIT. iPhone and iPad builds are coming later.`
    : `Not yet. Arya is in a private beta by invitation. The Mac app needs final interface checks, a signed package and Apple notarization before a public download. ${accessURL ? 'You can request beta access on the download page.' : betaRequestsClosed}`;
  return `<section class="hero">
<div class="wrap hero-copy">
<p class="eyebrow"><span>${releaseReady ? `Arya ${version} for Mac · Free and open source` : 'Private beta by invitation · Mac'}</span></p>
<h1>One AI-native suite for editing, color, motion and shorts. <em>Your edit. Every layer.</em></h1>
<p class="lead">Work by hand on a timeline, or say what should change. Every change is an ordinary edit you can adjust and undo.</p>
<div class="actions hero-actions">
<div class="action-item">${button(action.href, action.label)}<span class="action-note">${releaseLine}</span></div>
${browserEditor ? `<div class="action-item">${button(browserEditor, 'Try in your browser <span class="button-badge">Limited</span>', 'secondary')}<span class="action-note">No AI assistant, Figma import or transcription</span></div>` : ''}
</div>
</div>
<div class="wrap workspace" id="workspace">
<div class="workspace-tabs" role="group" aria-label="Show an Arya workspace">${gallery}</div>
<div class="workspace-frame"><img id="workspace-image" src="${shots[0].src}" alt="${shots[0].alt}" width="${shots[0].width}" height="${shots[0].height}" fetchpriority="high" decoding="async"></div>
<div class="workspace-meta"><p class="workspace-caption" id="workspace-caption" aria-live="polite">${shots[0].caption}</p><a class="workspace-full" id="workspace-full" href="${shots[0].src}">Open full size <span aria-hidden="true">↗</span></a></div>
<p class="credit">Captured from the Arya browser editor, October 2026. ${footageCredit} The Mac app's native interface does not expose every feature shown on this page yet.</p>
</div>
</section>
<section class="suite wrap" id="suite" aria-labelledby="suite-heading">
<div class="section-head"><h2 id="suite-heading">One project for the whole finish.</h2><p>Cut, grade, animate, mix and deliver without round trips. Every workspace edits the same project file, so a grade, a title or a short stays live and editable.</p></div>
<ul class="suite-list">${suite}</ul>
</section>
<section class="assistant" id="ai" aria-labelledby="ai-heading">
<div class="wrap assistant-card">
<div class="assistant-grid">
<div class="chapter-copy"><p class="kicker">AI assistant · Mac &amp; local browser editor</p><h2 id="ai-heading">Ask in plain words. Undo like any edit.</h2><p>Select clips, a title or a range and describe what should change. The assistant reads your selection, playhead, transcript and rendered frames, then edits through the same timeline operations you use by hand.</p>
<ul class="points"><li><strong>Ordinary edits, not a black box.</strong> Every change comes with a receipt of what changed and reverses with Undo.</li><li><strong>Bring your own account.</strong> Connect Claude Code or Codex through their official sign-in. Arya includes no AI credits.</li><li><strong>Always optional.</strong> Every timeline, color, motion and audio tool works offline without an assistant.</li></ul>
${link('/install/#accounts', 'How assistant sign-in works')}</div>
${figure('assistant')}
</div>
</div>
</section>
<section class="craft-section wrap" aria-label="Editing workspaces">
<div class="craft-grid">
<article class="craft-card" id="color" aria-labelledby="color-heading">
<div class="chapter-copy"><p class="kicker">Color</p><h2 id="color-heading">Grade with nodes, then check the scopes.</h2><p>Build serial, parallel and layer-mixer graphs. Each corrector has its own lift, gamma, gain and offset wheels, curves, HSL qualifier and circle, rectangle or linear window. Load .cube LUTs, copy grades across clips and read the signal on the waveform, RGB parade, vectorscope and histogram.</p></div>
${figure('color')}
</article>
<article class="craft-card" id="motion" aria-labelledby="motion-heading">
<div class="chapter-copy"><p class="kicker">Motion</p><h2 id="motion-heading">Keyframes, expressions and real layers.</h2><p>Animate position, scale, rotation and opacity with easing presets or custom curves in the value and speed graphs. Write expressions such as <code>wiggle(2, 30)</code>, parent layers to nulls, draw masks, apply alpha or luma track mattes and drive layers from a point or box tracker.</p></div>
${figure('motion')}
</article>
<article class="craft-card" id="audio" aria-labelledby="audio-heading">
<div class="chapter-copy"><p class="kicker">Audio</p><h2 id="audio-heading">Mix to a loudness target.</h2><p>Every track has a fader, pan and an effect rack with parametric EQ, compressor, gate, de-esser, limiter, reverb and delay. Clean dialogue with denoise and voice cleanup, measure integrated LUFS and true peak, then normalize clips to -14, -16 or -23 LUFS.</p></div>
${figure('audio')}
</article>
<article class="craft-card craft-card-shorts" id="shorts" aria-labelledby="shorts-heading">
<div class="chapter-copy"><p class="kicker">Shorts</p><h2 id="shorts-heading">Cut long recordings into editable shorts.</h2><p>Transcribe speech locally, search passages by topic or duration, and build each short as its own 9:16, 1:1 or 16:9 composition with linked audio, tracked reframing keyframes and captions in plain, boxed, word-highlight or one-word styles.</p></div>
${figure('shorts')}
</article>
</div>
</section>
<section class="wrap figma-section" id="figma" aria-labelledby="figma-heading">
<div class="figma-card">
<div class="chapter-copy"><p class="kicker">Figma · Mac &amp; local browser editor</p><h2 id="figma-heading">Bring Figma frames in as layers.</h2><p>Import frames with a Figma personal access token. If you use the Figma MCP server in Claude Code, Claude can import frames for you. Smart Animate turns two frames into an animated transition.</p></div>
<ul class="figma-limits"><li><strong>Editable layers</strong>Text, rectangles and ellipses with a solid or gradient fill, and nested frames arrive as live Arya layers.</li><li><strong>Rendered images</strong>Complex vectors, boolean shapes, stars, polygons, lines, image fills, shadows and masked groups arrive as images you can still animate.</li><li><strong>Local token</strong>Your Figma personal access token stays on your device. Hosted OAuth sign-in is planned for a later release.</li></ul>
</div>
</section>
<section class="editions-section wrap" id="editions" aria-labelledby="editions-heading">
<div class="section-head"><h2 id="editions-heading">What works where.</h2><p>Arya runs as a native Mac app, a local browser editor run from source, and a hosted browser preview at <code>/editor/</code>. The hosted preview keeps projects in browser storage and exports H.264, HEVC, WAV and AAC up to five minutes.</p></div>
<div class="table-wrap" tabindex="0" role="region" aria-label="What works in each Arya edition"><table class="editions-table"><thead><tr><th scope="col">Capability</th><th scope="col">Mac app (v${version})</th><th scope="col">Local browser editor (from source)</th><th scope="col">Hosted browser editor (/editor/)</th></tr></thead><tbody>${whatWorksWhere}</tbody></table></div>
</section>
<section class="switching wrap" id="switch" aria-labelledby="switch-heading">
<div class="section-head"><h2 id="switch-heading">Bring your timeline with you.</h2><p>Arya reads and writes FCPXML, OpenTimelineIO, SRT and WebVTT, and exports H.264, HEVC, ProRes 422, 422 HQ and 4444, GIF, PNG sequences, WAV and AAC.</p></div>
<div class="table-wrap" tabindex="0" role="region" aria-label="What carries over from other tools"><table><thead><tr><th scope="col">Coming from</th><th scope="col">What carries over</th><th scope="col">What does not, yet</th></tr></thead><tbody>${switching}</tbody></table></div>
</section>
<section class="faq-section wrap" id="faq" aria-labelledby="faq-heading">
<h2 id="faq-heading">Questions before you start</h2>
${faq([
  ['Can I download Arya now?', downloadAnswer],
  ['What is the difference between the Mac app and the browser editor?', 'The Mac app and the local browser editor (run from source) support local project folders, AI assistant connections, Figma imports and local transcription. The hosted browser editor at /editor/ runs entirely in your browser storage with no AI assistant, no Figma import and no transcription.'],
  ['Do I need an AI subscription?', 'No. Editing, grading, motion, audio and export all work without an assistant. Connecting your own Claude Code or Codex account is optional.'],
  ['Where does my footage go?', 'On Mac, your project file and media stay in the local folder you choose. In the hosted browser editor, files stay in your browser profile storage. Nothing is uploaded unless you send a prompt to your connected AI provider or import a frame from Figma. Read the privacy policy for details.'],
  ['Is Arya really free and open source?', publicSource ? 'Yes. Arya is released under the MIT license with no subscriptions, watermarks or paid tiers. The full source code is on GitHub.' : 'The repository is currently private. The plan is to publish it after a review of history, dependencies and licenses.'],
])}
</section>
<section class="layer-study-section wrap"><details class="layer-study"><summary>Explore the editable-layer illustration<span>An interactive brand study</span></summary><div class="layer-study-body"><noscript><p>Layer controls need JavaScript. The artwork remains available to view.</p></noscript><p>Afterlight is a separate illustration of editable layers. It does not run the Arya application or call an agent.</p>${stage}</div></details></section>
<div class="wrap"><section class="closing" aria-labelledby="closing-heading"><div class="closing-copy"><h2 id="closing-heading">Start cutting on your Mac.</h2><p class="closing-meta">${releaseReady ? `Arya ${version} for Mac · ${size} notarized universal DMG · ${minimumOS} or later · Free under MIT` : releaseLine}</p></div><div class="closing-actions">${button(action.href, action.label)}${browserEditor ? button(browserEditor, 'Try in your browser (limited)', 'secondary') : ''}</div></section></div>`;
}

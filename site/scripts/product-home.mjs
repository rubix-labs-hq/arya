// Home page. Every product claim here must be true of the code today; see site/README.md.
// Downloads are free with optional contributions. Checkout controls require a configured provider.
export const footageCredit = 'Footage: <cite>Tears of Steel</cite>, (CC) Blender Foundation, <a href="https://mango.blender.org/" rel="noopener noreferrer">mango.blender.org</a>, licensed <a href="https://creativecommons.org/licenses/by/3.0/" rel="noopener noreferrer">CC BY 3.0</a>.';
export const betaRequestsClosed = 'Beta requests open when the form on the download page is connected.';

export function primaryAction(releaseReady, accessURL) {
  if (releaseReady) return { href: '/download/#mac', label: 'Download Arya', short: 'Download' };
  return { href: '/download/#access', label: accessURL ? 'Request beta access' : 'Beta access', short: accessURL ? 'Request access' : 'Beta access' };
}

export function productHome({ button, link, faq, stage, shots, figures, releaseReady = false, publicSource = null, accessURL = null, browserEditor = null }) {
  if (!Array.isArray(shots) || shots.length !== 4 || shots[0].id !== 'edit') throw new Error('The home gallery needs four verified captures, starting with Edit');
  const action = primaryAction(releaseReady, accessURL);
  const figure = id => {
    const item = figures[id];
    if (!item) throw new Error(`Missing chapter figure ${id}`);
    return `<figure class="chapter-figure figure-${id}"><a href="${item.src}" class="figure-link"><img src="${item.src}" alt="${item.alt}" width="${item.width}" height="${item.height}" loading="lazy" decoding="async"></a><figcaption>${item.caption}</figcaption></figure>`;
  };
  const gallery = shots.map((shot, index) => `<a class="workspace-tab" href="${shot.src}" data-workspace="${shot.id}" data-src="${shot.src}" data-alt="${shot.alt}" data-caption="${shot.caption}" aria-current="${index === 0}" aria-controls="workspace-image workspace-caption">${shot.label}</a>`).join('');
  const releaseLine = releaseReady
    ? 'The approved Mac release is available. Check the download page for its version and checksum.'
    : `Private beta for Mac, by invitation. The public download is not available yet.${accessURL ? '' : ` ${betaRequestsClosed}`}`;
  const suite = [
    ['Edit', 'Blade, ripple, roll, slip and slide on a multitrack timeline, with snapping, markers, automatic proxies, nested compositions and multicam with audio sync for up to nine angles.', 'Final Cut Pro and Premiere'],
    ['Color', 'A node graph with serial, parallel and layer-mixer nodes, lift, gamma, gain and offset wheels, curves, HSL qualifiers, windows, .cube LUTs and four scopes.', 'DaVinci Resolve'],
    ['Motion', 'Keyframes with easing and a value and speed graph, expressions, shapes, masks, track mattes, parenting, nine title animations and a point and box tracker.', 'After Effects'],
    ['Audio', 'A mixer with EQ, compressor, gate, de-esser, limiter, reverb and delay, plus denoise, voice cleanup and loudness measurement in LUFS and true peak.', 'Fairlight'],
    ['Shorts', 'Transcript passages, 9:16, 1:1 and 16:9 compositions, reframing with position keyframes and captions in four styles, all editable by hand.', 'Opus Clip'],
    ['Figma', 'Import a frame and get its text, rectangles, ellipses and nested frames as editable layers. Smart Animate turns two frames into a transition.', 'Figma'],
  ].map(([name, text, from]) => `<li><h3>${name}</h3><p>${text}</p><span class="suite-from">For work you would do in ${from}</span></li>`).join('');
  const switching = [
    ['Final Cut Pro', 'Import FCPXML files and .fcpxmld bundles, and export FCPXML.', 'Generators arrive as solid colors, multicam clips as their active angle and variable speed as one constant speed.'],
    ['DaVinci Resolve', 'Move timelines as FCPXML or OpenTimelineIO. Grades use a node graph with wheels, curves, qualifiers and windows.', 'Resolve grades and Fusion compositions do not import.'],
    ['Premiere Pro', 'Bring captions as SRT or WebVTT.', 'Premiere XML, EDL and AAF are not supported.'],
    ['After Effects', 'Precompose, parenting, track mattes, masks and expressions such as wiggle and loopOut.', 'No planar tracking and no third-party plug-ins.'],
    ['Opus Clip', 'Passage suggestions quote the transcript they come from. Each short stays an editable composition.', 'Suggestion scores rank structure only. They do not predict views.'],
  ].map(([from, carries, missing]) => `<tr><th scope="row">${from}</th><td data-label="Carries over">${carries}</td><td data-label="Not yet">${missing}</td></tr>`).join('');
  const betaText = releaseReady
    ? 'Download the approved Mac release and check its version and checksum before installing.'
    : `The Mac app is being tested before a public release. The beta is by invitation. ${accessURL ? 'Request access and say what you cut, grade or animate today.' : betaRequestsClosed}`;
  const downloadAnswer = releaseReady
    ? 'Yes. The approved Mac release is on the download page with its version, requirements and checksum. iPhone and iPad builds are still in testing.'
    : `Not yet. Arya is in a private beta by invitation. The Mac app needs final interface checks, a signed package and Apple notarization before a public download. ${accessURL ? 'You can request beta access on the download page.' : betaRequestsClosed}`;
  return `<section class="hero">
<div class="wrap hero-copy">
<p class="eyebrow"><span>${releaseReady ? 'Available for Mac' : 'Private beta by invitation · Mac'}</span></p>
<h1>One AI-native suite for editing, color, motion and shorts.</h1>
<div class="hero-side"><p class="tagline">Your edit. <em>Every layer.</em></p><p class="lead">Cut, grade, animate, mix and make shorts in one project, and direct any of it in plain words. The assistant edits the same project you do, so every change is an ordinary edit you can see, adjust and undo.</p>
<div class="actions">${button(action.href, action.label)}${browserEditor ? button(browserEditor, 'Open in your browser', 'secondary') : ''}${link('#suite', 'See what it does')}</div>
<p class="release-line">${releaseLine}</p></div>
</div>
<div class="wrap workspace" id="workspace">
<div class="workspace-tabs" role="group" aria-label="Show an Arya workspace">${gallery}</div>
<div class="workspace-frame"><img id="workspace-image" src="${shots[0].src}" alt="${shots[0].alt}" width="${shots[0].width}" height="${shots[0].height}" fetchpriority="high" decoding="async"></div>
<div class="workspace-meta"><p class="workspace-caption" id="workspace-caption" aria-live="polite">${shots[0].caption}</p><a class="workspace-full" id="workspace-full" href="${shots[0].src}">Open full size <span aria-hidden="true">↗</span></a></div>
<p class="credit">Captured from the Arya browser editor, development build, October 2026. ${footageCredit} The Mac app's native interface does not expose every feature shown on this page yet.</p>
</div>
</section>
<section class="suite wrap" id="suite" aria-labelledby="suite-heading">
<div class="section-head"><h2 id="suite-heading">One project for the whole finish.</h2><p>Cut, grade, animate, mix and deliver without round trips. Every page edits the same project file, so a grade, a title or a short stays live and editable.</p></div>
<ul class="suite-list">${suite}</ul>
</section>
<section class="chapter wrap" id="color" aria-labelledby="color-heading">
<div class="chapter-copy"><p class="kicker">Color</p><h2 id="color-heading">Grade with nodes, then check the scopes.</h2><p>Build serial, parallel and layer-mixer graphs. Each corrector has its own wheels, curves, HSL qualifier and circle, rectangle or linear window. Load .cube LUTs, copy a grade across clips and read the result on the waveform, RGB parade, vectorscope and histogram.</p><p class="note">Reference matching compares overall color statistics, so judge it by eye. The browser editor renders Rec. 709.</p></div>
${figure('color')}
</section>
<section class="chapter chapter-flip wrap" id="motion" aria-labelledby="motion-heading">
<div class="chapter-copy"><p class="kicker">Motion</p><h2 id="motion-heading">Keyframes, expressions and real layers.</h2><p>Animate position, scale, rotation and opacity with easing presets or your own curve, and shape the timing in the value and speed graphs. Write expressions such as <code>wiggle(2, 30)</code>, parent layers to nulls, draw masks, use alpha or luma track mattes and precompose. Titles and shapes stay vector layers, not baked frames.</p><p class="note">The tracker follows a box or a point and can drive a layer, a mask or a color window. There is no planar tracker.</p></div>
${figure('motion')}
</section>
<section class="chapter wrap" id="audio" aria-labelledby="audio-heading">
<div class="chapter-copy"><p class="kicker">Audio</p><h2 id="audio-heading">Mix to a loudness target.</h2><p>Each track has a fader, pan and an effect rack with parametric EQ, compressor, gate, de-esser, limiter, reverb and delay. Clean dialogue with denoise and voice cleanup, measure the mix in LUFS and true peak, then normalize clips to -14, -16 or -23 LUFS.</p></div>
${figure('audio')}
</section>
<section class="chapter chapter-flip chapter-tall wrap" id="shorts" aria-labelledby="shorts-heading">
<div class="chapter-copy"><p class="kicker">Shorts</p><h2 id="shorts-heading">Cut long recordings into shorts you can still edit.</h2><p>Transcribe the speech, correct any word, and ask for passages by length or topic. Each suggestion quotes the lines it comes from. Arya builds every short as its own 9:16, 1:1 or 16:9 composition with linked audio and captions in plain, boxed, word-highlight or one-word styles. Reframe with position keyframes from a tracked subject, then change anything by hand.</p><p class="note">Suggestions rank sentence boundaries, pauses and your search terms. They do not predict views. Transcription uses whisper.cpp in the browser editor, when it is installed, and Apple speech recognition in the Mac app.</p></div>
${figure('shorts')}
</section>
<section class="assistant" id="ai" aria-labelledby="ai-heading">
<div class="wrap assistant-grid">
<div class="chapter-copy"><p class="kicker">AI assistant</p><h2 id="ai-heading">Direct the edit in plain words.</h2><p>Select clips, a title or a range and say what should change. The assistant gets your selection and playhead, reads the project, can look at rendered frames, and edits through the same operations as the timeline.</p>
<ul class="points"><li><strong>Nothing hidden.</strong> Its edits are ordinary project changes with a receipt of what changed, and Undo reverses them.</li><li><strong>Your own subscription.</strong> Connect Claude Code or Codex through their official sign-in. Arya includes no AI credits, and the provider's plan limits apply.</li><li><strong>Optional.</strong> Manual editing and export never need an assistant.</li></ul>
${link('/install/#accounts', 'How assistant connections work')}</div>
${figure('assistant')}
</div>
</section>
<section class="chapter wrap figma" id="figma" aria-labelledby="figma-heading">
<div class="chapter-copy"><p class="kicker">Figma</p><h2 id="figma-heading">Bring Figma frames in as layers.</h2><p>Import a frame with your own Figma access token or through the Figma MCP server. Text, rectangles and ellipses with a solid or gradient fill, and nested frames, arrive as editable Arya layers and compositions. Other layers arrive as rendered images you can still move and animate. Smart Animate turns two frames into an animated transition.</p></div>
<ul class="figma-limits"><li><strong>Comes in as editable layers</strong>Text, rectangles and ellipses with one solid or gradient fill, nested frames</li><li><strong>Comes in as images</strong>Vectors, boolean shapes, stars, polygons, lines, image fills, shadows, several fills, mixed-style text and masked groups</li><li><strong>Not yet</strong>Auto layout, and Figma sign-in for the public release. Personal access tokens work today.</li></ul>
</section>
<section class="switching wrap" id="switch" aria-labelledby="switch-heading">
<div class="section-head"><h2 id="switch-heading">Bring your timeline with you.</h2><p>Arya reads and writes FCPXML, OpenTimelineIO, SRT and WebVTT. Export H.264, HEVC, ProRes 422, 422 HQ and 4444, GIF, PNG sequences, WAV and AAC from a render queue. The browser editor exports ProRes 4444 and PNG sequences without transparency; the Mac app keeps it.</p></div>
<div class="table-wrap" tabindex="0" role="region" aria-label="What carries over from other tools"><table><thead><tr><th scope="col">Coming from</th><th scope="col">What carries over</th><th scope="col">What does not, yet</th></tr></thead><tbody>${switching}</tbody></table></div>
</section>
<section class="beta" id="beta" aria-labelledby="beta-heading">
<div class="wrap beta-grid">
<div><h2 id="beta-heading">${releaseReady ? 'Arya for Mac is available.' : 'Arya is in private beta.'}</h2><p>${betaText}</p></div>
<div class="beta-actions">${button(action.href, action.label)}${link('/download/#mac', 'Release status and requirements')}</div>
</div>
</section>
<section class="faq-section wrap" aria-labelledby="faq-heading">
<h2 id="faq-heading">Questions before you start</h2>
${faq([
  ['Can I download Arya now?', downloadAnswer],
  ['Do I need an AI subscription?', 'No. Editing, grading, motion, audio and export all work without an assistant. Connecting Claude Code or Codex adds plain-language editing to the same project.'],
  ['Does Arya include Claude or ChatGPT?', 'No. You connect your own account through the provider\'s official sign-in. The provider sets the plan, models and usage limits. Arya does not include provider credits.'],
  ['Where does my footage go?', 'Arya keeps the project file and generated media in the folder you choose. A connected assistant receives the project context it needs for a request, and a Figma import downloads the design. The data guide lists each case.'],
  ['What do the screenshots show?', 'Real captures of the Arya browser editor, development build, editing scenes from Tears of Steel, an open film from the Blender Foundation. The Mac app uses the same project format and editing operations, but its native interface does not expose every feature yet.'],
  ['Is the source public?', publicSource ? 'Yes. The project page links the public source. Read its license and contributor guide before using or changing it.' : 'The repository is currently private. The plan is to publish it after a review of history, dependencies and licenses.'],
])}
</section>
<section class="layer-study-section wrap"><details class="layer-study"><summary>Explore the editable-layer illustration<span>An interactive brand study</span></summary><div class="layer-study-body"><noscript><p>Layer controls need JavaScript. The artwork remains available to view.</p></noscript><p>Afterlight is a separate illustration of editable layers. It does not run the Arya application or call an agent.</p>${stage}</div></details></section>
<div class="wrap"><section class="closing"><h2>Try it on your own footage.</h2>${button(action.href, action.label)}</section></div>`;
}

# Arya website

A framework-free static website with six pages, real editor captures, local fonts and no third-party scripts. It is a separate marketing site, not the editing application.

## Build and check

From this directory:

```sh
npm run build
npm test
```

No package install is needed. Serve this directory as the document root with any local static server. All links use root paths, so opening the HTML directly as a file is not the supported preview method.

The generated HTML is checked in. Edit `scripts/build.mjs`, then regenerate it. CSS and browser behavior live in `assets/`. The site has no card form, visitor tracking or publishing command. The beta access form is an unconnected placeholder; see below.

## Configuration and release gates

`config.json` contains public destinations only. Never put credentials, payment secrets, provider tokens or private source URLs in it.

Downloads are free with optional contributions (`optional-support`). Until a checkout destination is configured, the support page says contributions are not open. The contribution form and its amounts render only after a checkout destination is configured. The `paid-download` alternative changes pricing copy, but the build rejects a ready paid release until a separate reviewed checkout and authorized delivery flow exists. Do not route paid release fulfillment through this static form.

A Mac download requires `ready`, `notarized`, version, SHA-256 and an HTTPS URL on the explicit release host allowlist. Readiness and notarization must be the JSON boolean `true`. String values fail closed. These fields record a release decision; they do not verify an artifact. Packaging, signature, notarization, install and checksum checks must precede that configuration change. The static build and browser configuration use those same fields. The build generates a working download link for an approved release even without JavaScript. Browser configuration can withdraw that link when readiness is removed. Keep public copy consistent with the actual packaged version.

Contribution URLs have a separate allowlist. A preset checkout URL must represent that exact one-time USD amount at the provider. The custom destination must let the user explicitly choose the amount at the provider. The site never creates a payment, changes provider amounts by query string or claims payment success. Test the actual hosted checkout and receipt before configuring it.

`publicSourceURL` holds the public repository URL once it is published. An approved HTTPS `contactURL` on `externalHosts` adds a footer support link. A configured `siteURL` adds canonical links and the local social PNG metadata. Neither field proves deployment or reachability. The six pages explain current product and release limits. Check those facts against the product before every release.

Beta access: until a form service is chosen, `requestAccessURL` stays `null` and the download page shows a placeholder form marked "Placeholder. This form is not connected yet." Its controls start disabled, it has no `action`, and its handler validates the email in the browser, sends nothing and says so. Until then, primary buttons read "Beta access" and no page asks visitors to request access. After a release is approved, every primary button reads "Download Arya" and goes to `/download/#mac`. To connect the form, put the hosted form's HTTPS URL in `requestAccessURL` and its host in `externalHosts`; the build then replaces the placeholder with a link to that form. Update the data guide in the same change to name the service.

Search indexing follows `indexing` in `config.json`. It is `true` now, so `robots.txt` allows every page except `/editor/` and the build writes `sitemap.xml`. With `indexing` false or no `siteURL`, `robots.txt` blocks everything and no sitemap is written. Before changing `siteURL`, confirm the canonical metadata, the raster social preview and the dated privacy policy still match. The included SVG social artwork has outlined type and a 1200 by 630 PNG export. The identity board, app-icon concept and installer artwork live beside it in `assets/brand/`. Do not claim it is a validated preview for every social platform.

`_headers` provides a static-host header template. Confirm that the selected host actually applies it. Keep scripts, fonts and configuration on the same origin. No HSTS policy is supplied before a real HTTPS domain exists.

## Assets and licenses

All marks, illustrations and social artwork were authored for this website. The Home page shows captures of the browser editor editing *Tears of Steel*, (CC) Blender Foundation, licensed CC BY 3.0 and credited on the page. Footage and capture provenance are recorded in `assets/product/README.md` and `THIRD_PARTY_NOTICES.md`. The optional Afterlight illustration labels itself as an interactive brand study and its controls only change that illustration. No asset contains client footage. Never use private client media.

Manrope and Newsreader italic come from the [Google Fonts Manrope directory](https://github.com/google/fonts/tree/main/ofl/manrope) and [Google Fonts Newsreader directory](https://github.com/google/fonts/tree/main/ofl/newsreader). Their complete SIL Open Font License texts accompany the self-hosted fonts. Pages load Latin WOFF2 subsets (`manrope-latin.woff2`, about 23 KB, and a single italic instance in `newsreader-italic-latin.woff2`, about 20 KB) made with fontTools `pyftsubset` and `varLib.instancer`. The TTF sources stay beside them. Font requests stay on the site's own origin.

## Manual checks

Node checks validate content, link paths, pricing and destination guards. They cannot judge visual quality. After visible changes, render every page at desktop and 375px, test 400 percent browser zoom, touch and keyboard navigation, contribution invalid and unconfigured states, reduced motion, and VoiceOver.

See `docs/design/arya-brand.md` for the design brief.

## Brand source

The current illustration is Afterlight, an original study of the cut-A identity. It labels itself as an interactive illustration. Selecting a layer changes its inspector and timeline highlight. The action changes only that layer, apart from the explicitly labeled composition-separation action. No action calls a model or changes an editing project.

`python3 scripts/generate-brand.py` rebuilds the outlined SVG assets on macOS with Swift and CoreText. The fonts are local and licensed. The checked-in PNG exports include a 1024-pixel app-icon concept, a 1200 by 630 social graphic, 1800 by 1200 installer artwork and a 1600 by 1180 identity board. These are branding deliverables. Native icon integration and installer packaging require their own implementation and checks.

## Product evidence

Home is generated by `scripts/product-home.mjs`. Its workspace gallery reads the reviewed local images and captions in `assets/product/captures.json`; the chapter images come from `assets/product/figures.json`. The gallery needs exactly four entries and the first must be the editing workspace. The build rejects a missing capture or a nonlocal image path. It preserves each image's original aspect ratio and provides a full-size link. Capture URLs include a SHA-256 content version so revised screenshots cannot reuse an older browser-cache entry. The link check verifies those versions against the actual bytes. New workspace sections appear only after their corresponding capture is registered.

Every product claim on Home must be true of the code today. Before changing feature copy, check it against the editor source, and state limits next to the claim (for example, no Premiere XML, no planar tracker, suggestion scores do not predict views). The captures show a development build of the browser editor; the Mac app opens a native editor with the same project format. The optional Afterlight illustration remains a distinct secondary demonstration. No image establishes a public release or a performance result.

## Navigation and failed scripts

Phone navigation stays visible until the menu handlers are installed. Workspace gallery entries are ordinary full-size links without JavaScript; their installed handlers switch the image, alternative text, caption and selected state in place. Modified clicks retain the normal link behavior. Contribution inputs and buttons start disabled and enable only after their handlers are installed. A failed script cannot submit the amount as a form request.

The release-readiness fixture suite builds disposable copies with configured and incomplete releases, exercises the production browser handlers in a minimal DOM, and checks current defaults. It does not certify browser layout or accessibility. After any navigation change, repeat phone layout, keyboard focus, screen reader, reduced-motion and JavaScript-disabled browser acceptance.

If configuration loading fails, the enhanced download page removes its download action and reports that release status could not be checked. Reload the page to try again. Support submission preserves the load error. When another contribution amount has a destination, a missing checkout for the chosen amount is reported separately from closed contributions. Runtime configuration must retain literal release booleans and the reviewed USD, $5 minimum and $15 suggestion. These checks do not verify the actual release or payment provider.

The navigation disclosure closes when keyboard focus leaves its header. Escape returns focus to Menu when focus is inside navigation and preserves focus elsewhere. The Afterlight controls start disabled and enable after their handlers are installed; its local no-script explanation keeps the static artwork understandable. Guide illustration status follows the configured release and public-source state. Check these behaviors with a real keyboard, VoiceOver and browser zoom after changes.

# Native builds and distribution

Arya builds from the committed Xcode project. Install the editor dependencies with `npm ci` in `editor/` before building. Xcode's build phase bundles the shared JavaScript core, web editor and fonts. The Reel scheme, module and callback names remain compatibility identifiers. Follow [the Arya distribution guide](arya-distribution.md) for the complete runtime, installer and fresh-Mac acceptance requirements.

## Clean-source setup

Start in a new checkout at the intended commit, or in a materialized source snapshot with an exact file manifest. A dirty snapshot is separate from a fresh Git clone. Keep `node_modules`, prepared helpers, build output and personal project data out of that source copy. Install the locked browser dependencies from the repository root:

```sh
npm ci --prefix editor
```

The committed Xcode project and generated `MetalShaders.swift` are sufficient inputs for app builds. XcodeGen is required only when regenerating `native/Reel.xcodeproj` after changing `native/project.yml`. `node native/scripts/build-metal-shaders.mjs` regenerates the committed Metal source from `editor/web/engine/compositor.js`; review its diff before building.

The Xcode bundle phase generates `reel-core.js` and `arya-music.js`, copies the reviewed root `THIRD_PARTY_NOTICES.md` and vendor licenses, and prepares a fresh Mac persistence helper. iOS bundles omit that desktop helper. Native package tests generate their own shared-core/music bundles under `native/build/generated`; they do not need a copied build directory. Pass `NODE="$(command -v node)"` to Swift tests so Node installations outside the test helper's default search paths work.

Browser save/edit tests need a prepared persistence helper. From the repository root, run `npm run --prefix editor prepare:persistence` and `npm run --prefix editor check:persistence` before that suite. These steps use the Mac compiler tools and an ad hoc signature. Run them in your own checkout, not while another build is using it.

The website has no install step. Run `npm run build --prefix site` and `npm test --prefix site` with the same source snapshot. Plugin type checks separately require the Claude Code API declarations under `.claude/types` (run `/plugin-types` in a Claude Code session to write them) and an available TypeScript compiler; the repository does not provide a root npm lockfile for that environment.

A source-only dependency install, deterministic generator comparison or site test does not establish a fresh Mac/iOS build. Keep both app-target builds, native package tests, exact bundled-resource notices, runtime, device and signed distribution results with the final source freeze.

## Verification

Run the browser and native checks before creating a release archive:

```sh
cd editor
npm test
npm run renderer:regressions
node scripts/figma-text-smoke.mjs
npm run golden
npm run processing:smoke
cd ..
NODE="$(command -v node)" swift test --package-path native/ReelKit
python3 native/scripts/test-release.py
```

The public repository's GitHub workflow runs on pushes to `main` and pull requests. Private mirrors can run it through manual dispatch. Repeatable local checks against the exact release source are the release gate. The workflow's ad hoc archive and any hosted result do not prove performance, permissions or device behavior. Keep local GPU comparisons and physical-device results with the release record.

## Archives

The release script rejects existing output directories and symbolic-link aliases. It builds a Release archive, checks the app signature and resources, and saves the app ZIP and `validation.json`.

```sh
# Local archive with a hardened ad hoc signature.
python3 native/scripts/release.py archive --output build/release-local

# Signed Mac archive. Use your own identity and team from Xcode.
python3 native/scripts/release.py archive --output build/release-signed \
  --identity 'Developer ID Application: Your Name (TEAMID)' --team TEAMID \
  --node-archives /absolute/path/to/local-node-archives \
  --runtime-entitlements /absolute/path/to/reviewed-v8-entitlements.plist

# iPhone/iPad device archive with the signed-in team's provisioning.
python3 native/scripts/release.py archive --platform ios \
  --output build/release-ios --team TEAMID --allow-provisioning
```

`--allow-provisioning` permits Xcode to update provisioning profiles. Use it only after selecting the intended team. The script does not create or import signing credentials.

Release Mac builds use App Sandbox with user-selected folders, security-scoped bookmarks and outgoing provider connections. They request no network listener. Debug builds remain unsandboxed for fixture automation. Signed Mac archives require both pinned official Node payloads, reviewed helper entitlements and successful signed startup probes. Ordinary unsigned builds do not contain those distribution payloads.

The archive validation receipt describes a signed candidate. It keeps publication readiness false and records notarization and fresh-install acceptance as unperformed. Signing does not establish those later gates.

## Notarization

A Developer ID signature is required for a downloadable Mac build. An ad hoc ZIP is only a local build. Create your own `notarytool` Keychain profile with Apple's credentials, then submit the signed archive:

```sh
python3 native/scripts/release.py notarize \
  --app build/release-signed/Arya.xcarchive/Products/Applications/Arya.app \
  --zip build/release-signed/Arya.zip --profile YOUR_PROFILE
```

The script waits for Apple's result, staples the ticket, validates the staple and checks Gatekeeper. It saves a separate `Arya-notarized.zip`. Complete fresh-install and current-source acceptance before delivering that candidate. Never put Apple passwords, API keys, Figma tokens or assistant keys in the repository or CI logs.

Apple documents the [outgoing networking entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.network.client) and [notarization requirements](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

# Arya distribution and installation

Arya is the new product name. Internal project filenames, the ReelKit module, existing project files, and the `reelfigma` and `reelagent` callback schemes remain compatibility names until the migration has been tested. Renaming a signed app after a build does not finish that migration.

The DMG builder is implemented in `native/scripts/package-arya-installer.py`. Its pure tests inject Apple tools and use disposable files. They test publication guards and packaging logic; they do not create a real disk image, sign code, or prove a fresh Mac installation.

## What the builder does

The builder accepts an existing app and creates a new private output directory outside that app. It rejects existing outputs, symbolic-link aliases, absolute or external bundle links, unsupported executable architectures, and a missing minimum macOS version. It reuses the existing release validator for bundled editor files, callback schemes, hardened runtime, signature integrity, and sandbox entitlements. It checks the exact release-validator and runtime-validator source hashes before executing those bytes and keeps both reviewed modules in memory. It captures the release validator's tool output so an error cannot print account details through inherited stderr. Either dependency changing requires a new source review and hash pin.

It copies the app without changing its signed contents, adds an Applications shortcut and installation instructions, then creates a compressed read-only DMG. It verifies the image, mounts it read-only, checks the app's bytes and permissions against the source, validates the mounted app, and checks the shortcut and instructions. It detaches only the device reported for its own mount point. It publishes the complete image last, alongside `SHA256SUMS` and `distribution.json`, without overwriting another file.

The mounted instructions identify the validated version, build, minimum macOS version and supported Mac architectures. The receipt records their SHA-256 alongside the manual update mechanism. Fresh installation, manual update and manual rollback acceptance remain unperformed in that receipt, including in official mode.

Rehearsal mode is the default. The filename, volume, instructions, and receipt state that it is a rehearsal. It accepts the existing hardened local signature but cannot use signing or notarization credentials. It is not an official download.

Official mode requires an `Arya.app` bundle with Arya bundle and display names. It requires a Developer ID app signature and a stapled app that passes Gatekeeper. The builder then signs the DMG with the supplied Developer ID identity, submits it through an existing notarytool Keychain profile, requires an Accepted result, staples the DMG, and verifies its signature, ticket, Gatekeeper result, and image integrity. The input-app staple check is this tool's distribution policy; Apple also supports notarizing the outermost distribution container. See [Apple's packaging documentation](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution) and [notarization documentation](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

Every receipt keeps `readyToPublish` false. The tool cannot prove current-source UI acceptance, a fresh Mac install, payment delivery, legal readiness, or the maintainers' release approval. A successful official packaging run produces a distribution candidate for those remaining checks.

An official candidate also needs the pinned universal Node bridge runtime. The release validator checks both helper binaries, their license hashes, minimum macOS versions, matching Developer ID signatures, approved V8 entitlements, and signed startup-probe receipts. The DMG receipt records the validated runtime version, manifest hash, and final signed helper hashes. It does not execute Node or rerun a startup probe while packaging.

## Commands

Run the pure tests without any Apple packaging processes:

```sh
python3 native/scripts/test-arya-installer.py
```

The following packaging commands run the filesystem and Apple-tool workflow. Read the scripts before running them.

```sh
# Inspect the existing release archive separately before choosing a candidate.
python3 native/scripts/package-arya-installer.py \
  --app /absolute/path/to/Arya.app --output build/arya-rehearsal-001

# This submits the image to Apple. Use the selected team's existing credentials.
python3 native/scripts/package-arya-installer.py --mode official \
  --app /absolute/path/to/Arya.app --output build/arya-official-001 \
  --identity 'Developer ID Application: Your Name (TEAMID)' \
  --profile YOUR_EXISTING_PROFILE
```

The builder does not create credentials, archive or compile the app, install into Applications, change Gatekeeper, launch the app, or upload anything to a website. Official mode contacts Apple's notary service. Keep Apple account credentials in Keychain. Keep all artifacts and reports under ignored `build/` folders.

Creating its input signed app is a separate release operation. The current archive script needs the two local, pinned official Node archives and a reviewed helper-entitlement file. It copies the runtime before signing the app and must pass both signed V8 startup probes. These commands are examples. They do not show that a candidate has been built:

```sh
python3 native/scripts/release.py archive --output build/arya-signed-001 \
  --identity 'Developer ID Application: Your Name (TEAMID)' --team TEAMID \
  --node-archives /absolute/path/to/local-node-archives \
  --runtime-entitlements /absolute/path/to/reviewed-v8-entitlements.plist

python3 native/scripts/release.py notarize \
  --app build/arya-signed-001/Arya.xcarchive/Products/Applications/Arya.app \
  --zip build/arya-signed-001/Arya.zip --profile YOUR_EXISTING_PROFILE
```

## Fresh Mac requirements

The native editor uses SwiftUI, ReelKit, JavaScriptCore, Metal, AVFoundation, Accelerate, Vision, and the bundled editor resources. Normal native editing and native exports do not require the local Node server, Chrome, Homebrew, ffmpeg, or an AI subscription. The current deployment target is macOS 14. A release must show the minimum macOS version and actual architecture list from its receipt, rather than assume it is universal. Apple Silicon and Intel need separate clean-machine acceptance, even when a universal binary contains both slices.

Production setup code now requires a signed bundled Node runtime for subscription assistance. Debug builds can fall back to installed Node.js 22 or newer when the bundled runtime is absent. `NativeAssistant.installAgentHelper(runtime:)` copies the companion into the user's existing Application Support directory and passes the validated bundled executable to its launcher. Official archive tooling prepares pinned Node.js 24.21.0 helpers for both Mac architectures, but a helper payload is not part of an ordinary unsigned Xcode build.

Claude Code and Codex still need separate installation through their official provider instructions. Assistant settings have official installation links, and the native sign-in action runs the provider's official command in Terminal. A user without the CLI must install it first. The app does not silently install a provider or a package manager. A sign-in button is not proof that the provider, runtime, or subscription is ready. Validate setup on a clean Mac after a signed runtime candidate exists.

The browser editor has a separate developer setup: Node.js 22 or newer, ffmpeg and ffprobe, and Chrome for headless rendering. whisper.cpp is optional for browser transcription. Native transcription uses Apple Speech and needs permission and supported recognition availability. iPhone and iPad cannot run desktop Node or provider CLIs locally; their subscription connection needs an explicitly configured HTTPS companion on another machine.

The bundled runtime contract uses `Contents/Helpers/node-arm64`, `Contents/Helpers/node-x86_64`, and `Contents/Resources/assistant/node-runtime.json`, with complete Node license files beside the manifest. Official upstream archive hashes, unsigned payload hashes, final signed hashes, and startup-probe receipts have separate meanings. Each release must check the real payload, nested signatures, V8 execution, notarization, and fresh-user subscription behavior. Contributions never include an AI subscription.

## Installation and update journey

The download page must show the release version, minimum macOS version, Apple Silicon or Intel compatibility, download size, checksum, and actual availability. Keep a free download available. Contributions are optional and start at $5. Keep those contributions separate from optional AI subscription costs.

For the Mac release, check the downloaded DMG's checksum against the official release page. Save projects and finish or stop assistant runs. If the companion is running in Terminal, press Control-C in that companion's window and wait for it to exit. Quit all running Arya copies. Open the DMG, drag Arya onto Applications, wait for Finder to finish, eject the image, and open the installed app from Applications. Check its version with Finder's Get Info. Explain the normal macOS first-launch prompt. A rejected Gatekeeper result must lead to support, never instructions to disable protection or remove quarantine. The DMG instructions are plain text so screen readers can read the full journey. A designed Finder window, icon positions, background artwork, and VoiceOver acceptance remain part of release QA.

Replacing the application must preserve project folders, exports, account credentials, preferences, and folder permissions. Projects live in user-selected folders. The updater must not write there unless the user opens a project and edits it. Back up projects before a project-format migration. Older builds should open a copy when testing rollback. Do not rename or migrate Application Support, Keychain service identifiers, bookmarks, callback schemes, or preferences without an explicit migration and a regression test. No automatic updater or migration is introduced by this builder.

Before a manual update, keep a complete backup of each project folder and its media. Retain the previous approved DMG and published checksum. Use Finder's Replace action for the existing `Arya.app` in Applications. An older `Reel.app` has a different filename and will remain beside it. Keep that copy closed, and verify which app version and location you open. The current Mac bundle identifier remains `app.reel.Reel`; each release must test that the signed candidate preserves access to existing preferences, Keychain entries and security-scoped bookmarks.

The companion is a separate Terminal process. Quitting Arya does not stop it. The app copies its companion scripts into `Reel/AgentBridge` under Application Support when the user starts the companion from Assistant settings. Stop the previous companion before replacing the app, then start it again from the installed version if needed. Keep provider CLI sign-in data and account connections in place.

To roll back, save work, stop the companion if running, and quit Arya. Verify the previous approved installer's published checksum, replace the Applications copy, eject the image and check the installed version. Open a separate copy of the backup made before the update. A project saved by a newer version may be incompatible with the older app. Replacing the app does not undo project edits or convert project formats. Start the companion from the restored app if needed. If the older app fails macOS verification or cannot read the copied project, stop and use support; keep both the backup and the newer project.

The release record must name the old and new versions, builds, artifact checksums and source fingerprints for an update test. Record the signing team, bundle identifier, entitlements and callback schemes for both apps. Test app replacement with a disposable project copy and compare its bytes before opening it. Then verify save/reopen, media access, native export, preferences, bookmarks and account connection status. Record status without copying tokens or credential values into reports. Repeat from the previous approved installer using the pre-update backup for rollback. These checks require actual installed apps and user state; the pure packaging fixtures cannot approve them.

Before uninstalling the Mac app, save work and finish or stop assistant runs. Stop a companion you started with Control-C in its Terminal window and wait for it to exit. Quit all Arya copies, then move the Applications copy to Trash in Finder. Project folders and their media stay in place. Clearing caches, preferences, account connections or companion support files remains a separate choice. The packaging receipt keeps uninstall acceptance pending; it does not remove an installed app.

On iPhone and iPad, deleting the app removes its local data, including projects created in Arya's Documents/Projects folder. Copy complete projects outside Arya's folder before deletion. Offloading keeps app documents but does not create a backup. See [Apple's storage guidance](https://support.apple.com/en-us/108429).

## Remaining release gates

- Verify the Arya app name, icon, copyright, about/help copy, and compatibility migration in current app builds.
- Build the current sources for both Mac architectures, verify bundled resources, and validate the signed Release app and its nested executables.
- Select and verify the intended Developer ID identity and existing notarytool profile. An earlier signed Reel build does not prove Arya readiness.
- Execute this reviewed builder and preserve the actual tool results. Test its failure cleanup, image mounting, staple, and Gatekeeper behavior on a real DMG.
- Download the exact candidate through the proposed delivery service on a clean Gatekeeper-enabled Mac. Verify its checksum, mounted instructions, drag installation, permissions, first launch, new project, media import, edit, save/reopen, and native export without Node installed.
- Exercise AI setup with no runtime or CLI installed, with a valid existing subscription, with expired authentication, and with a provider limit. Test iPad HTTPS companion setup separately.
- Test the manual update and rollback sequence above with the exact old and new artifacts. Separately uninstall only the app and reinstall. Preserve the versions, checksums and user-state results with the release record.
- Test keyboard navigation, VoiceOver, display scaling, dark/light appearance, small windows, offline launch, unavailable network, denied Speech permission, low storage, interrupted download, and corrupted DMG rejection.
- Reconcile the exact source commit, release receipt, checksum, CI results, UI acceptance, website download, support contact, and contribution delivery before publication.
- Finalize update signing and a verified updater design if automatic updates are added. The current release journey uses manual replacement in Applications.

The public Figma OAuth service is not hosted yet. The website must say which current connection methods work and must not present public Figma sign-in as ready.

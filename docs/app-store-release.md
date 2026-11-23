# Arya App Store release

Arya uses one App Store Connect record and bundle ID, `app.reel.ios`, for iPhone, iPad and the Mac App Store edition. The Mac App Store edition builds the UIKit editor with Mac Catalyst. The `Reel` Mac target remains the separate Developer ID edition, bundle ID `app.reel.Reel`, with its local CLI integrations.

## Arya Pro

Starting with 1.2.0, the App Store editions sell Arya Pro through StoreKit 2. Version 1.1.1 and earlier sold optional tips instead.

Free in App Store builds: all editing and export up to 1080p, with no watermark, ads or account. Arya Pro adds export above 1080p (4K and up to 8K), Apple ProRes 422, 422 HQ and 4444, and HDR10 (PQ) and HLG delivery. Audio-only exports are always free.

Products:

- `app.reel.ios.pro.monthly`: auto-renewable, one month, in the subscription group "Arya Pro".
- `app.reel.ios.pro.yearly`: auto-renewable, one year, with a one-week free trial, in the same group.
- `app.reel.ios.pro.lifetime`: non-consumable, one payment that never renews.

Family Sharing is off for all three. One purchase covers iPhone, iPad and the Mac App Store edition, because they share one App Store record. The App Store supplies localized names, descriptions and prices. Do not print a price on the website or in the README.

Early supporters keep Arya Pro at no charge. A production App Store install qualifies when its original app version is earlier than 1.2.0 (build 6 on iOS). TestFlight, sandbox and Xcode installs always see the free edition. The rule is `ProEarlySupporter` in `native/ReelKit/Sources/ReelKit/ProPurchases.swift`.

The Arya Pro screen opens from Settings, the welcome screen, the Deliver panel and the prompt after a completed export; no sheet opens automatically. It shows each plan's length and full price, Restore Purchases, and links to the Terms of Use and Privacy Policy, as Apple requires. Cancelled, pending, restricted and failed purchases leave editing and 1080p export available. Restore Purchases recovers subscriptions and the lifetime purchase on the same Apple Account.

The old tip products `app.reel.ios.support.small`, `app.reel.ios.support.medium` and `app.reel.ios.support.large` are retired from the app. Product IDs are permanent in App Store Connect, so do not reuse them.

The direct Mac download and the browser editors never enforce Arya Pro. They export everything at no charge and link to the website's optional tips.

The Developer ID Mac app and browser editors link to the website's support page for optional tips. Only the direct Mac target sets `ARYA_DIRECT_DISTRIBUTION`. App Store builds do not bundle a checkout link or the Terminal/Node companion. The website owns the Stripe checkout configuration.

Use `https://editwitharya.app/help/` as the App Store support URL and `https://editwitharya.app/privacy/` as the privacy URL.

## Build

Xcode Cloud builds the App Store editions. The Release workflow of the Arya Video Editor product archives `Reel iOS` for iOS and `Reel Mac App Store` for Mac Catalyst when a release tag starting with `v` (for example `v1.4.1`) is pushed. The tag must be `v` plus `MARKETING_VERSION` in `native/project.yml`, or `ci_post_clone.sh` stops the build. Direct Mac releases use the same tags, so each one also builds the App Store editions. Merges to `main` don't start it, which keeps the team inside Xcode Cloud's included hours. It uploads both to App Store Connect, where they appear in TestFlight with no tester groups added. The builds are App Store eligible, so the same build can go to external testers and App Review. Start a build of any branch by hand from Xcode (Integrate, then Manage Workflows) or App Store Connect. `native/ci_scripts/ci_post_clone.sh` installs Node and the locked editor packages. `native/ci_scripts/ci_post_xcodebuild.sh` runs `validate-app-store.py` on each signed export and fails the build if it does not pass or if an archive has no export. Xcode Cloud sets the build number. Don't also upload the same version from a local archive.

To build by hand instead, install the locked editor and website tip-service dependencies as described in CONTRIBUTING.md. Do not regenerate the Xcode project casually; keep the checked-in project and `native/project.yml` consistent.

Archive each App Store platform separately with automatic signing and the existing developer team:

```sh
xcodebuild -project native/Reel.xcodeproj -scheme 'Reel iOS' \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/archives/Arya-iOS.xcarchive archive

xcodebuild -project native/Reel.xcodeproj -scheme 'Reel Mac App Store' \
  -configuration Release -destination 'generic/platform=macOS,variant=Mac Catalyst' \
  -archivePath build/archives/Arya-Mac-App-Store.xcarchive archive
```

Validate each exported app with `python3 native/scripts/validate-app-store.py /path/to/Arya.app`. The validator checks the bundle identity, version, signature, sandbox and absence of test/checkout/desktop-helper payloads.

Use App Store Connect export options with `method=app-store-connect`. The existing Developer ID `release.py` and notarization process are for the direct Mac edition and must not export the App Store edition.

The Catalyst build uses the shared Swift backend and native Apple media frameworks. It does not package the desktop project-writer or Node helper. Its sandbox permits chosen files, saved security-scoped bookmarks and outgoing connections. It has no Terminal automation exception.

## Acceptance

Run the Arya Pro state-machine tests and the channel checks:

```sh
NODE="$(command -v node)" swift test --package-path native/ReelKit --filter ProPurchaseTests
python3 native/scripts/test-native-support-purchases.py
python3 native/scripts/test-support-channels.py
```

Use `native/StoreKit/AryaSupport.storekit` for local purchase tests. The configuration must never ship. Run StoreKitTest from an Xcode test target so its configuration stays outside the app. Release builds contain neither the test host nor StoreKitTest.

Verify the Arya Pro screen on an iPhone, iPad and Mac, including each plan, the yearly free trial, cancellation, pending approval, success, Restore Purchases, offline loading and purchase restrictions. Confirm that a free install exports 1080p and refuses 4K, ProRes and HDR with the Arya Pro message, and that an unlocked install exports them. Verify project reopen, MP4 import/playback and a completed export in the signed build. Mac exports must continue when another application receives focus.

In App Store Connect, create the "Arya Pro" subscription group with the monthly and yearly products and the yearly one-week free trial, and the lifetime non-consumable. They were first submitted with version 1.2.0 and are approved, so later versions need no attachment. For each release, confirm availability, upload the signed build and use review notes that explain the path to Arya Pro (on iPhone and iPad: Tools, then More, then Settings, then Arya Pro; on a wide iPad window Settings is in the toolbar) and the 1080p free limit. The notes should also say that **Continue with ChatGPT**, on the assistant's "Set up Arya" card or in Assistant settings, only connects the person's own ChatGPT plan to the assistant, and never unlocks Arya Pro. Apple review and distribution status are separate from local build success.

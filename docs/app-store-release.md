# Arya App Store release

Arya uses one App Store Connect record and bundle ID, `app.reel.ios`, for iPhone, iPad and the Mac App Store edition. The Mac App Store edition builds the UIKit editor with Mac Catalyst. The `Reel` Mac target remains the separate Developer ID edition, bundle ID `app.reel.Reel`, with its local CLI integrations.

## Payments and support

The App Store editions use StoreKit 2 consumables:

- `app.reel.ios.support.small`
- `app.reel.ios.support.medium`
- `app.reel.ios.support.large`

The App Store supplies localized names, descriptions and prices. Tips unlock nothing. Editing and export stay free. Settings, the welcome screen and a completed export provide optional support actions; no support sheet opens automatically. Cancelled, pending, restricted and failed purchases leave editing available.

The Developer ID Mac app and browser editors link to the website's support page. Only the direct Mac target sets `ARYA_DIRECT_DISTRIBUTION`. App Store builds do not bundle a checkout link or the Terminal/Node companion. The website owns the Stripe checkout configuration.

Use `https://editwitharya.app/help/` as the App Store support URL and `https://editwitharya.app/privacy/` as the privacy URL.

## Build

Install the locked editor and tip-service dependencies as described in CONTRIBUTING.md. Do not regenerate the Xcode project casually; keep the checked-in project and `native/project.yml` consistent.

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

Run the support state-machine tests and the channel checks:

```sh
NODE="$(command -v node)" swift test --package-path native/ReelKit --filter SupportPurchaseTests
python3 native/scripts/test-native-support-purchases.py
python3 native/scripts/test-support-channels.py
```

Use `native/StoreKit/AryaSupport.storekit` for local purchase tests. The configuration must never ship. Run StoreKitTest from an Xcode test target so its configuration stays outside the app. Release builds contain neither the test host nor StoreKitTest.

Verify the support sheet on an iPhone, iPad and Mac, including cancellation, pending approval, success, offline loading and purchase restrictions. Verify project reopen, MP4 import/playback and a completed export in the signed build. Mac exports must continue when another application receives focus.

In App Store Connect, attach the first tip products to the new version, provide review screenshots, confirm availability, upload the signed build and use review notes that explain Settings → Support Arya. Consumable tips have no restore entitlement. Apple review and distribution status are separate from local build success.

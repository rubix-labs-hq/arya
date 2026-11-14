#!/usr/bin/env python3
"""Source contracts for Arya Pro in App Store builds. No build, StoreKit session or network.
Purchase outcomes, the export rule and the gate are covered by ReelKit's ProPurchaseTests."""
import argparse
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
root = parser.parse_args().source_root.resolve()
native = root / 'native'
core = (native / 'ReelKit/Sources/ReelKit/ProPurchases.swift').read_text()
tests = (native / 'ReelKit/Tests/ReelKitTests/ProPurchaseTests.swift').read_text()
backend = (native / 'ReelKit/Sources/ReelKit/ReelBackend.swift').read_text()
support = (native / 'App/iOS/NativeSupport.swift').read_text()
app = (native / 'App/iOS/ReelIOSApp.swift').read_text()
welcome = (native / 'App/Shared/EditorView.swift').read_text()
settings = (native / 'App/Shared/NativeEditor/NativeEditorView.swift').read_text()
deliver = (native / 'App/Shared/NativeEditor/NativeDeliverPanel.swift').read_text()
mac_app = '\n'.join(p.read_text() for p in (native / 'App/macOS').rglob('*.swift'))
spec = (native / 'project.yml').read_text()
scheme = (native / 'Reel.xcodeproj/xcshareddata/xcschemes/Reel iOS.xcscheme').read_text()
mac_scheme = (native / 'Reel.xcodeproj/xcshareddata/xcschemes/Reel.xcscheme').read_text()
project = (native / 'Reel.xcodeproj/project.pbxproj').read_text()
privacy = (native / 'App/Shared/PrivacyInfo.xcprivacy').read_text()
config_path = native / 'StoreKit/AryaSupport.storekit'
config = json.loads(config_path.read_text())

checks = 0


def check(value, message):
    global checks
    assert value, message
    checks += 1


# Product identity and local review prices. App Store Connect product IDs are permanent.
check('productIDPrefix = "app.reel.ios.pro."' in core and 'case monthly, yearly, lifetime' in core, 'Three fixed Pro identifiers')
for plan in ['monthly', 'yearly', 'lifetime']:
    check(f'"app.reel.ios.pro.{plan}"' in tests, f'Tests pin app.reel.ios.pro.{plan}')
products = config['products']
check([(p['productID'], p['type'], p['displayPrice']) for p in products] == [('app.reel.ios.pro.lifetime', 'NonConsumable', '49.99')],
      'Lifetime is one non-consumable at the review price')
groups = config['subscriptionGroups']
check(len(groups) == 1 and groups[0]['name'] == 'Arya Pro', 'One subscription group')
subs = {s['productID']: s for s in groups[0]['subscriptions']}
check(set(subs) == {'app.reel.ios.pro.monthly', 'app.reel.ios.pro.yearly'}, 'Monthly and yearly subscriptions')
check(subs['app.reel.ios.pro.monthly']['recurringSubscriptionPeriod'] == 'P1M' and subs['app.reel.ios.pro.monthly']['displayPrice'] == '2.99', 'Monthly 2.99')
check(subs['app.reel.ios.pro.yearly']['recurringSubscriptionPeriod'] == 'P1Y' and subs['app.reel.ios.pro.yearly']['displayPrice'] == '19.99', 'Yearly 19.99')
check(subs['app.reel.ios.pro.yearly']['introductoryOffer'] == {'internalID': '5B7D2E23', 'paymentMode': 'free', 'subscriptionPeriod': 'P1W'},
      'Yearly has a one-week free trial')
check(subs['app.reel.ios.pro.monthly']['introductoryOffer'] is None, 'Monthly has no trial')
check(all(not s['adHocOffers'] and not s['codeOffers'] and not s['winbackOffers'] for s in subs.values()), 'No other offers')
check(all(not p['familyShareable'] for p in products + list(subs.values())), 'Family Sharing stays off')
check(all('review price only' in p['referenceName'] for p in products + list(subs.values())), 'Local prices are labelled as review-only')
check(not config.get('nonRenewingSubscriptions'), 'No non-renewing subscriptions')

# The local configuration never ships and is attached only to the App Store Run actions.
check(not str(config_path.relative_to(native)).startswith('App/'), 'Config lives outside target source folders')
check('AryaSupport.storekit' not in project, 'Config is not a project or target file, so it is not bundled')
check('storeKitConfiguration: StoreKit/AryaSupport.storekit' in spec, 'XcodeGen spec keeps the scheme setting')
check('identifier = "../../StoreKit/AryaSupport.storekit"' in scheme, 'iOS Run action uses the local config')
check('StoreKitConfigurationFileReference' not in mac_scheme, 'Direct Mac scheme has no StoreKit config')
check(project.count('NativeSupport.swift in Sources') == 2, 'NativeSupport.swift builds in the iOS target only (one build file, one phase entry)')

# Prices and terms come from the App Store.
swift = core + support
check('product.displayPrice' in support, 'UI shows the localized displayPrice')
check(not re.search(r'\d+[.,]\d\d', swift), 'No hard-coded price in Swift sources')
check('priceFormatStyle' not in swift and 'NumberFormatter' not in swift, 'Arya does not format prices itself')
check('Renews automatically unless you cancel at least 24 hours before the period ends.' in core, 'Auto-renew terms')
check('Text(product.terms)' in support, 'Terms show next to the purchase button')
check('introductoryOffer' in support and 'isEligibleForIntroOffer' in support, 'Trial shows only to eligible people')
check('Button("Restore Purchases")' in support, 'Restore Purchases')
check('https://www.apple.com/legal/internet-services/itunes/dev/stdeula/' in support and 'https://editwitharya.app/privacy/' in support, 'Terms of Use and Privacy Policy links')
check('https://apps.apple.com/account/subscriptions' in support, 'Manage subscription link')

# StoreKit 2 correctness.
check('@Environment(\\.purchase) private var purchase' in support, 'SwiftUI scene purchase action')
check('try await action(product, options: [])' in support, 'Purchase uses the passed action')
check('case .verified(let transaction): self = .verified' in support and 'case .unverified(let transaction, _): self = .unverified' in support, 'Verification result is preserved')
check('finish: { await transaction.finish() }' in support and support.count('.finish()') == 1, 'Finish is wired once, through ProTransaction')
check('Transaction.updates' in support and 'Transaction.unfinished' in support, 'Listens for updates and sweeps unfinished transactions')
check('Transaction.currentEntitlements' in support and 'transaction.revocationDate == nil' in support, 'Access comes from current, unrevoked entitlements')
check('AppStore.sync()' in support, 'Restore syncs with the App Store')
check('AppStore.canMakePayments' in support, 'Respects purchase restrictions')
check('case .pending: return .pending' in support and 'case .userCancelled: return .userCancelled' in support, 'Pending and cancel are mapped')
check('@unknown default' in support, 'Future purchase results fail safely')
check('let first = handled.insert(transaction.id).inserted' in core, 'Each transaction is finished once')
check('guard !isBusy else { return false }' in core, 'Duplicate taps are refused')
check('app.environment == .production' in support, 'Early-supporter access needs a production App Store install')
launch = app.split('    init() {', 1)[1].split('\n    }', 1)[0] if '    init() {' in app else ''
check('NativeProStore.shared.start()' in launch, 'Listener and export rule start at app launch')
check('ProExportGate.shared.enforce(true)' in support, 'App Store builds enforce the export rule')

# The backend refuses gated exports on both export paths, not only the UI.
gate = 'guard ProExportGate.shared.allows(width: width, height: height, preset: preset, hdr: b["hdr"] as? String) else { throw APIError(ProExportRule.lockedMessage) }'
check(backend.count(gate) == 2, 'Native and WebCodecs export paths both check the gate')

# The direct-download Mac app never enforces the rule.
check('ProExportGate' not in mac_app and 'NativeProStore' not in mac_app, 'Direct Mac app has no Pro gate')
check('enforce(true)' not in core, 'ReelKit leaves the gate off by default')

# No server, receipt, account or tracking.
for forbidden in ['appStoreReceiptURL', 'URLSession', 'Keychain', 'SKPaymentQueue', 'SKReceipt', 'jwsRepresentation', 'appAccountToken']:
    check(forbidden not in swift, f'No {forbidden} in Pro code')
check('<key>NSPrivacyCollectedDataTypes</key>\n\t<array/>' in privacy and '<key>NSPrivacyTracking</key>\n\t<false/>' in privacy, 'Privacy manifest still collects nothing')

# Reachable from Settings, welcome, the web editor menu and Deliver.
check('case .support:' in app and 'NativeProView(store: .shared)' in app, 'Mobile sheet route shows Arya Pro')
check('Button("Arya Pro") { presentation.presentSheet(.support) }' in app, 'Web editor menu entry')
check('openSupport: { presentation.presentSheet(.support) }' in app and 'welcome.pro' in welcome, 'Welcome entry')
check('settings.pro' in settings and 'NativeProView(store: proStore)' in settings, 'Native Settings entry')
check(settings.index('#if os(iOS)\n            Button { supportVisible = true }') < settings.index('settings.pro'), 'Settings entry is iOS-only')
check('needsPro ? showPro() : export()' in deliver and 'ProExportRule.requiresPro(' in deliver, 'Deliver explains the lock and opens Arya Pro')
check('deliver.size.4k' in deliver, 'Deliver has a one-tap 4K size')

# No stale promises in App Store code.
for name, text in [('NativeSupport.swift', support), ('ReelIOSApp.swift', app), ('EditorView.swift', welcome),
                   ('NativeEditorView.swift', settings)]:
    check('unlocks nothing' not in text and 'Every feature stays free' not in text and 'Optional tips' not in text, f'{name} has no tip-era promise')

print(f'Arya Pro purchase contracts passed: {checks}', flush=True)

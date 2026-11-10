#!/usr/bin/env python3
"""Source contracts for optional iOS tips. No build, StoreKit session or network.
The purchase outcomes themselves are covered by ReelKit's SupportPurchaseTests."""
import argparse
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
root = parser.parse_args().source_root.resolve()
native = root / 'native'
core = (native / 'ReelKit/Sources/ReelKit/SupportPurchases.swift').read_text()
tests = (native / 'ReelKit/Tests/ReelKitTests/SupportPurchaseTests.swift').read_text()
support = (native / 'App/iOS/NativeSupport.swift').read_text()
app = (native / 'App/iOS/ReelIOSApp.swift').read_text()
welcome = (native / 'App/Shared/EditorView.swift').read_text()
settings = (native / 'App/Shared/NativeEditor/NativeEditorView.swift').read_text()
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


IDS = ['app.reel.ios.support.small', 'app.reel.ios.support.medium', 'app.reel.ios.support.large']
REVIEW_PRICES = ['4.99', '14.99', '29.99']

# Product identity and local review prices.
check('productIDPrefix = "app.reel.ios.support."' in core and 'case small, medium, large' in core, 'Three fixed tip identifiers')
check(all(f'"{i}"' in tests for i in IDS), 'Tests pin the exact App Store Connect identifiers')
products = config['products']
check([p['productID'] for p in products] == IDS, 'Local config lists the same three products in order')
check(all(p['type'] == 'Consumable' for p in products), 'Tips are consumables')
check([p['displayPrice'] for p in products] == REVIEW_PRICES, 'Local review prices only')
check(all('review price only' in p['referenceName'] for p in products), 'Local prices are labelled as review-only')
check(not config.get('subscriptionGroups') and not config.get('nonRenewingSubscriptions'), 'No subscriptions')

# The local configuration never ships and is attached only to the iOS Run action.
check(not str(config_path.relative_to(native)).startswith('App/'), 'Config lives outside target source folders')
check('AryaSupport.storekit' not in project, 'Config is not a project or target file, so it is not bundled')
check('storeKitConfiguration: StoreKit/AryaSupport.storekit' in spec, 'XcodeGen spec keeps the scheme setting')
check('identifier = "../../StoreKit/AryaSupport.storekit"' in scheme, 'iOS Run action uses the local config')
check('StoreKitConfigurationFileReference' not in mac_scheme, 'Mac scheme is unchanged')
check(project.count('NativeSupport.swift in Sources') == 2, 'NativeSupport.swift builds in the iOS target only (one build file, one phase entry)')

# Prices are always the App Store's localized string.
swift = core + support
check('product.displayPrice' in support and 'Text(product.displayPrice)' in support, 'UI shows localized displayPrice')
check(not re.search(r'\d+[.,]\d\d', swift), 'No hard-coded price in Swift sources')
check('priceFormatStyle' not in swift and 'NumberFormatter' not in swift, 'Arya does not format prices itself')

# StoreKit 2 correctness.
check('@Environment(\\.purchase) private var purchase' in support, 'SwiftUI scene purchase action')
check('try await action(product, options: [])' in support, 'Purchase uses the passed action')
check('case .verified(let transaction): self = .verified' in support and 'case .unverified(let transaction, _): self = .unverified' in support, 'Verification result is preserved')
check('await transaction.finish()' in support and support.count('.finish()') == 1, 'Finish is wired once, through SupportTransaction')
check('Transaction.updates' in support and 'Transaction.unfinished' in support, 'Listens for updates and sweeps unfinished transactions')
check('AppStore.canMakePayments' in support, 'Respects purchase restrictions')
check('case .pending: return .pending' in support and 'case .userCancelled: return .userCancelled' in support, 'Pending and cancel are mapped')
check('@unknown default' in support, 'Future purchase results fail safely')
check('guard handled.insert(transaction.id).inserted else {' in core, 'Each transaction is handled once')
check(re.search(r'case \.unverified:\s*\n\s*// Not thanked and not finished', core) is not None, 'Unverified purchase is not finished')
check('guard !isPurchasing else { return false }' in core, 'Duplicate taps are refused')
check('.disabled(!store.canPurchase)' in support, 'Buttons disable while a purchase runs')
launch = app.split('    init() {', 1)[1].split('\n    }', 1)[0] if '    init() {' in app else ''
check('NativeSupportStore.shared.start()' in launch, 'Listener starts at app launch')

# No server, receipt, account or tracking.
for forbidden in ['appStoreReceiptURL', 'URLSession', 'https://', 'http://', 'UserDefaults', 'Keychain', 'AppTransaction',
                  'SKPaymentQueue', 'SKReceipt', 'jwsRepresentation', 'appAccountToken', 'originalTransactionID']:
    check(forbidden not in swift, f'No {forbidden} in tip code')
check('<key>NSPrivacyCollectedDataTypes</key>\n\t<array/>' in privacy and '<key>NSPrivacyTracking</key>\n\t<false/>' in privacy, 'Privacy manifest still collects nothing')

# Reachable from iOS Settings, welcome and the web editor menu.
check('case newProject, assistantSettings, gettingStarted, support' in app and 'case .support:' in app, 'Mobile sheet route')
check('Button("Support Arya") { presentation.presentSheet(.support) }' in app, 'Web editor menu entry')
check('openSupport: { presentation.presentSheet(.support) }' in app and 'welcome.support' in welcome, 'Welcome entry')
settings_ios = settings.split('@State private var supportVisible = false', 1)
check(len(settings_ios) == 2 and 'settings.support' in settings and 'NativeSupportView(store: .shared)' in settings, 'Native Settings entry')
check(settings.index('#if os(iOS)\n            Button { supportVisible = true }') < settings.index('settings.support'), 'Settings entry is iOS-only')

# No feature gating: only the Support screen reads purchase state.
users = sorted(str(p.relative_to(root)) for p in native.rglob('*.swift')
               if '.build' not in p.parts and re.search(r'\bNativeSupportStore\b|\bSupportPurchaseController\b', p.read_text()))
check(users == ['native/App/iOS/NativeSupport.swift', 'native/App/iOS/ReelIOSApp.swift',
                'native/ReelKit/Sources/ReelKit/SupportPurchases.swift',
                'native/ReelKit/Tests/ReelKitTests/SupportPurchaseTests.swift'], f'Unexpected tip state users: {users}')
for name, text in [('ReelIOSApp.swift', app), ('NativeEditorView.swift', settings), ('EditorView.swift', welcome)]:
    check('thanked' not in text and 'SupportTier' not in text, f'{name} never branches on a tip')

print(f'Support purchase contracts passed: {checks}', flush=True)

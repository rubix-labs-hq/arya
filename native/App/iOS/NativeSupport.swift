import ReelKit
import StoreKit
import SwiftUI
import UIKit

// BEGIN PRO STOREKIT
/// StoreKit 2 for Arya Pro. StoreKit checks each signed transaction on the device. Arya has no
/// purchase server, sends no receipts anywhere and keeps no purchase history.
@MainActor
final class StoreKitProClient: ProStoreClient {
    private var loaded: [String: Product] = [:]

    var canMakePayments: Bool { AppStore.canMakePayments }

    func products(for ids: [String]) async throws -> [ProProduct] {
        let products: [Product]
        do { products = try await Product.products(for: ids) } catch { throw Self.storeError(error) }
        loaded = [:]
        var result: [ProProduct] = []
        for product in products {
            guard let plan = ProPlan(productID: product.id),
                  product.type == (plan == .lifetime ? .nonConsumable : .autoRenewable) else { continue }
            loaded[product.id] = product
            var trial: String?
            if let subscription = product.subscription, let offer = subscription.introductoryOffer,
               offer.paymentMode == .freeTrial, await subscription.isEligibleForIntroOffer {
                trial = Self.describe(offer.period, singular: true)
            }
            result.append(ProProduct(plan: plan, displayName: product.displayName, displayPrice: product.displayPrice,
                                     period: product.subscription.map { Self.describe($0.subscriptionPeriod, singular: false) },
                                     freeTrial: trial,
                                     price: product.price,
                                     priceFormat: product.priceFormatStyle,
                                     renewalMonths: product.subscription.flatMap { Self.renewalMonths($0.subscriptionPeriod) }))
        }
        return result
    }

    nonisolated static func renewalMonths(_ period: Product.SubscriptionPeriod) -> Int? {
        switch period.unit {
        case .month: return period.value
        case .year: return period.value * 12
        case .day, .week: return nil
        @unknown default: return nil
        }
    }

    /// "month" and "year" for a renewal period; "1 week" or "7 days" for a trial.
    nonisolated static func describe(_ period: Product.SubscriptionPeriod, singular: Bool) -> String {
        let unit: String
        switch period.unit {
        case .day: unit = "day"
        case .week: unit = "week"
        case .month: unit = "month"
        case .year: unit = "year"
        @unknown default: unit = "period"
        }
        if !singular && period.value == 1 { return unit }
        return "\(period.value) \(unit)\(period.value == 1 ? "" : "s")"
    }

    /// Uses the scene's purchase action so the confirmation sheet appears over the window
    /// that shows the button, including on iPad with several windows.
    func purchase(_ id: String, using action: PurchaseAction) async throws -> ProPurchaseOutcome {
        guard let product = loaded[id] else { throw ProStoreError.productUnavailable }
        return try await purchase(product, using: action)
    }

    func purchase(_ product: Product, using action: PurchaseAction) async throws -> ProPurchaseOutcome {
        let result: Product.PurchaseResult
        do { result = try await action(product, options: []) } catch { throw Self.storeError(error) }
        switch result {
        case .success(let verification): return .init(verification)
        case .pending: return .pending
        case .userCancelled: return .userCancelled
        @unknown default: throw ProStoreError.failed
        }
    }

    func currentAccess() async -> ProAccess {
        await currentEntitlementSnapshot().access
    }

    func currentEntitlementSnapshot() async -> ProEntitlementSnapshot {
        var hasLifetime = false
        var bestSubscription: ProPlan?
        for await result in StoreKit.Transaction.currentEntitlements {
            guard case .verified(let transaction) = result, transaction.revocationDate == nil, !transaction.isUpgraded,
                  let plan = ProPlan(productID: transaction.productID) else { continue }
            if plan == .lifetime {
                hasLifetime = true
            } else if bestSubscription == nil || plan == .yearly {
                // currentEntitlements already drops lapsed subscriptions and keeps those in a
                // billing grace period, so no expiration check here.
                bestSubscription = plan
            }
        }
        let appStatus = await NativeProEarlySupport.check()
        let access: ProAccess
        if hasLifetime { access = .lifetime }
        else if let bestSubscription { access = .subscribed(bestSubscription) }
        else { access = appStatus.earlySupporter ? .earlySupporter : .free }
        return ProEntitlementSnapshot(
            access: access,
            hasActiveSubscription: bestSubscription != nil,
            isProductionAppStore: appStatus.isProduction
        )
    }

    /// Unfinished transactions and later updates. Both sources can repeat a transaction;
    /// the controller finishes each transaction ID once.
    func transactionUpdates() -> AsyncStream<ProTransactionUpdate> {
        AsyncStream { continuation in
            let updates = Task.detached {
                for await result in StoreKit.Transaction.updates { continuation.yield(.init(result)) }
            }
            let unfinished = Task.detached {
                for await result in StoreKit.Transaction.unfinished { continuation.yield(.init(result)) }
            }
            continuation.onTermination = { _ in updates.cancel(); unfinished.cancel() }
        }
    }

    func restore() async throws {
        do { try await AppStore.sync() } catch { throw Self.storeError(error) }
    }

    nonisolated static func storeError(_ error: Error) -> Error {
        if error is ProStoreError || error is CancellationError { return error }
        if let error = error as? StoreKitError {
            switch error {
            case .userCancelled: return ProStoreError.cancelled
            case .networkError: return ProStoreError.network
            case .notAvailableInStorefront: return ProStoreError.productUnavailable
            default: return ProStoreError.failed
            }
        }
        if let error = error as? Product.PurchaseError {
            switch error {
            case .purchaseNotAllowed: return ProStoreError.notAllowed
            case .productUnavailable: return ProStoreError.productUnavailable
            default: return ProStoreError.failed
            }
        }
        return ProStoreError.failed
    }
}

/// App Store installs from before Arya Pro keep it. Only a production App Store install
/// counts; TestFlight, sandbox and Xcode installs always see the free edition.
enum NativeProEarlySupport {
    static let key = "pro.earlySupporter"

    /// The signed AppTransaction decides. The stored answer is used only when StoreKit cannot
    /// answer at all, for example offline, so an early supporter keeps Pro without a network.
    static func check(defaults: UserDefaults = .standard) async -> (earlySupporter: Bool, isProduction: Bool) {
        guard let result = try? await AppTransaction.shared else { return (defaults.bool(forKey: key), false) }
        guard case .verified(let app) = result, app.environment == .production else {
            defaults.removeObject(forKey: key)
            return (false, false)
        }
        let early = ProEarlySupporter.qualifies(originalAppVersion: app.originalAppVersion)
        defaults.set(early, forKey: key)
        return (early, true)
    }

    static func qualifies(defaults: UserDefaults = .standard) async -> Bool {
        await check(defaults: defaults).earlySupporter
    }
}

struct PendingProPurchaseIntent: Equatable, Identifiable {
    let id = UUID()
    let plan: ProPlan
    let product: Product

    static func == (lhs: Self, rhs: Self) -> Bool { lhs.id == rhs.id }
}

extension ProTransaction {
    init(_ transaction: StoreKit.Transaction) {
        self.init(id: transaction.id, productID: transaction.productID,
                  revoked: transaction.revocationDate != nil,
                  finish: { await transaction.finish() })
    }
}

extension ProPurchaseOutcome {
    init(_ result: VerificationResult<StoreKit.Transaction>) {
        switch result {
        case .verified(let transaction): self = .verified(ProTransaction(transaction))
        case .unverified(let transaction, _): self = .unverified(ProTransaction(transaction))
        }
    }
}

extension ProTransactionUpdate {
    init(_ result: VerificationResult<StoreKit.Transaction>) {
        switch result {
        case .verified(let transaction): self = .verified(ProTransaction(transaction))
        case .unverified(let transaction, _): self = .unverified(ProTransaction(transaction))
        }
    }
}

/// One shared store for the app, so the launch listener, the export gate and every Pro
/// screen agree.
@MainActor
final class NativeProStore: ObservableObject {
    static let shared = NativeProStore()
    /// The last access read on this device. It lets a queued export resume at launch before
    /// the App Store answers; the first refresh then corrects it.
    static let activeKey = "pro.active"

    @Published private(set) var catalog: ProPurchaseController.Catalog = .notLoaded
    @Published private(set) var status: ProPurchaseController.Status = .idle
    @Published private(set) var access: ProAccess = .free
    /// True whenever an unrevoked subscription entitlement is active, even alongside Lifetime.
    @Published private(set) var hasActiveSubscription = false
    /// True only when StoreKit verified a production App Store install (never TestFlight/sandbox).
    @Published private(set) var isProductionAppStore = false
    /// True once the first StoreKit entitlement read has completed.
    @Published private(set) var entitlementsLoaded = false
    /// Product chosen from an App Store Promoted In-App Purchase intent.
    @Published private(set) var pendingIntent: PendingProPurchaseIntent?
    private let client = StoreKitProClient()
    private let controller: ProPurchaseController
    private var foreground: NSObjectProtocol?
    private var periodic: Task<Void, Never>?
    private var intentListener: Task<Void, Never>?
    private var storefrontListener: Task<Void, Never>?
    private var catalogAccess: ProAccess?

    private init() {
        controller = ProPurchaseController(client: client)
        controller.onChange = { [weak self] in
            guard let self else { return }
            self.catalog = self.controller.catalog
            self.status = self.controller.status
            self.access = self.controller.access
            self.hasActiveSubscription = self.controller.hasActiveSubscription
            self.isProductionAppStore = self.controller.isProductionAppStore
        }
        controller.onAccessChange = { access in
            ProExportGate.shared.setUnlocked(access.isPro)
            UserDefaults.standard.set(access.isPro, forKey: Self.activeKey)
        }
    }

    var isBusy: Bool { controller.isBusy }
    var canPurchase: Bool { controller.canPurchase }
    var canMakePayments: Bool { controller.canMakePayments }
    var isPro: Bool { access.isPro }

    /// Call once at launch. App Store builds enforce the export rule from here on. StoreKit
    /// delivers unfinished transactions only to a listener that is running then.
    func start() {
        ProExportGate.shared.enforce(true)
        ProExportGate.shared.setUnlocked(UserDefaults.standard.bool(forKey: Self.activeKey))
        controller.startListening()
        Task { await refreshAccess() }
        foreground = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                let hadCatalog = self.catalog != .notLoaded
                if hadCatalog { self.controller.invalidateCatalog() }
                await self.controller.refreshAccess()
                if hadCatalog { await self.reload() }
            }
        }
        // A subscription can lapse while Arya stays open, and StoreKit sends no transaction
        // for that, so read entitlements again every 15 minutes.
        periodic = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15 * 60))
                await self?.controller.refreshAccess()
            }
        }
        // Promoted in-app purchases tapped on the App Store arrive through PurchaseIntent.intents.
        intentListener = Task { [weak self] in
            for await intent in PurchaseIntent.intents {
                guard !Task.isCancelled else { return }
                if let plan = ProPlan(productID: intent.product.id) {
                    self?.pendingIntent = PendingProPurchaseIntent(plan: plan, product: intent.product)
                }
            }
        }
        // Refresh prices and trial eligibility if the user switches App Store storefront.
        storefrontListener = Task { [weak self] in
            for await _ in Storefront.updates {
                guard !Task.isCancelled else { return }
                await self?.reload()
            }
        }
    }

    func load() async {
        let current = access
        if case .ready = catalog, catalogAccess != current {
            await controller.reloadProducts()
        } else {
            await controller.loadProducts()
        }
        if case .ready = catalog { catalogAccess = current }
    }

    func reload() async {
        let current = access
        await controller.reloadProducts()
        if case .ready = catalog { catalogAccess = current }
    }

    func clearStatus() { controller.clearStatus() }
    func refreshAccess() async {
        await controller.refreshAccess()
        entitlementsLoaded = true
    }
    func claimPendingIntent(id: UUID) -> PendingProPurchaseIntent? {
        guard let intent = pendingIntent, intent.id == id else { return nil }
        pendingIntent = nil
        return intent
    }
    func restore() async { await controller.restore() }

    func buy(_ plan: ProPlan, with action: PurchaseAction) async {
        let client = self.client
        await controller.purchase(plan) { id in try await client.purchase(id, using: action) }
    }

    func buyIntent(_ intent: PendingProPurchaseIntent, with action: PurchaseAction) async {
        let client = self.client
        await controller.purchase(intent.plan, requireCatalog: false) { _ in
            try await client.purchase(intent.product, using: action)
        }
    }
}
// END PRO STOREKIT

// BEGIN PRO VIEW
/// The Arya Pro screen. Apple requires the plan, its length, the full renewal price,
/// Restore Purchases and links to the Terms of Use and Privacy Policy before purchase.
struct NativeProView: View {
    @ObservedObject var store: NativeProStore
    /// Why the screen opened, for example after choosing a 4K export.
    var reason: String? = nil
    /// Which Pro capability triggered this screen, highlighted in the comparison table.
    var highlight: ProFeature? = nil
    /// Optional continuation invoked when the user taps "Export now" right after unlocking Pro.
    var onUnlocked: (() -> Void)? = nil
    @Environment(\.purchase) private var purchase
    @State private var selected: ProPlan = .yearly
    @State private var checkingBeforePurchase = false
    @State private var viewActive = false

    static let termsURL = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!
    static let privacyURL = URL(string: "https://editwitharya.app/privacy/")!
    static let manageURL = URL(string: "https://apps.apple.com/account/subscriptions")!

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                header
                comparisonTable
                if store.access.isPro { activeCard }
                if store.status == .unlocked, let onUnlocked {
                    Button { onUnlocked() } label: {
                        Label("Export now", systemImage: "square.and.arrow.up")
                            .font(.headline)
                            .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(NativeEditorStyle.accent)
                    .foregroundStyle(NativeEditorStyle.accentInk)
                    .accessibilityIdentifier("pro.exportNow")
                }
                if store.access != .lifetime {
                    if store.entitlementsLoaded {
                        plans
                    } else {
                        ProgressView("Checking purchases…").frame(maxWidth: .infinity)
                    }
                }
                if let message = store.status.message {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(NativeEditorStyle.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("pro.status")
                }
                footer
            }
            .padding(16)
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(NativeEditorStyle.background)
        .tint(NativeEditorStyle.accent)
        .navigationTitle("Arya Pro")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if !store.entitlementsLoaded { await store.refreshAccess() }
            await store.reload()
            preferAvailablePlan()
        }
        .task(id: pendingIntentTrigger) { await handlePendingIntent() }
        .onChange(of: store.catalog) { _, _ in preferAvailablePlan() }
        .onChange(of: store.access) { _, _ in
            preferAvailablePlan()
            Task { await store.reload() }
        }
        .onAppear { viewActive = true }
        .onDisappear {
            viewActive = false
            store.clearStatus()
        }
    }

    private var pendingIntentTrigger: String {
        "\(store.pendingIntent?.id.uuidString ?? "none")|\(store.isBusy)"
    }

    private var isSubscribed: Bool {
        if case .subscribed = store.access { return true }
        return store.hasActiveSubscription
    }

    private func shouldOffer(_ plan: ProPlan) -> Bool {
        switch store.access {
        case .lifetime, .subscribed(.lifetime): return false
        case .subscribed(.yearly): return plan == .lifetime
        case .subscribed(.monthly): return plan != .monthly
        case .free, .earlySupporter: return true
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Arya Pro").font(.largeTitle.weight(.bold)).foregroundStyle(NativeEditorStyle.text)
            Text(reason ?? "Editing and 1080p export stay free, with no watermark, no ads and no account. Pro adds professional delivery across iPhone, iPad and Mac.")
                .font(.body).foregroundStyle(NativeEditorStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var comparisonTable: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text("Included")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(NativeEditorStyle.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("Free")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(NativeEditorStyle.muted)
                    .frame(width: 48, alignment: .center)
                Text("Pro")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(NativeEditorStyle.accent)
                    .frame(width: 48, alignment: .center)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            Rectangle().fill(NativeEditorStyle.line).frame(height: 1)
            comparisonRow("All editing, color, motion & audio", free: true, highlighted: false)
            comparisonRow("1080p export · no watermark or ads", free: true, highlighted: false)
            comparisonRow("4K to 8K video export", free: false, highlighted: highlight == .resolution)
            comparisonRow("Apple ProRes 422 / HQ / 4444", free: false, highlighted: highlight == .prores)
            comparisonRow("HDR10 (PQ) & HLG 10-bit", free: false, highlighted: highlight == .hdr)
            comparisonRow("iPhone, iPad & Mac included", free: false, highlighted: false)
        }
        .background(NativeEditorStyle.panel, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(NativeEditorStyle.line, lineWidth: 1) }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Free and Pro comparison")
    }

    private func comparisonRow(_ title: String, free: Bool, highlighted: Bool) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.footnote.weight(highlighted ? .semibold : .regular))
                .foregroundStyle(highlighted ? NativeEditorStyle.accent : NativeEditorStyle.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            Image(systemName: free ? "checkmark" : "minus")
                .font(.caption.weight(.semibold))
                .foregroundStyle(free ? NativeEditorStyle.muted : NativeEditorStyle.line)
                .frame(width: 48, alignment: .center)
                .accessibilityLabel(free ? "Included in Free" : "Not in Free")
            Image(systemName: "checkmark")
                .font(.caption.weight(.bold))
                .foregroundStyle(NativeEditorStyle.accent)
                .frame(width: 48, alignment: .center)
                .accessibilityLabel("Included in Pro")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .background(highlighted ? NativeEditorStyle.selectionFill : Color.clear)
        .accessibilityElement(children: .combine)
    }

    private var activeCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(store.access == .earlySupporter ? "Arya Pro is included" : "Arya Pro is active", systemImage: "checkmark.seal.fill")
                .font(.headline).foregroundStyle(NativeEditorStyle.success)
            Text(store.access == .earlySupporter
                 ? "You installed Arya before Pro existed, so Pro stays included. Thank you. Buying a plan is optional and funds development."
                 : store.access.summary)
                .font(.subheadline).foregroundStyle(NativeEditorStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
            if isSubscribed {
                Link("Manage subscription", destination: Self.manageURL)
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("pro.manage")
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(NativeEditorStyle.panelRaised, in: RoundedRectangle(cornerRadius: 14))
        .accessibilityIdentifier("pro.active")
    }

    @ViewBuilder private var plans: some View {
        switch store.catalog {
        case .notLoaded, .loading:
            ProgressView("Loading plans…").frame(maxWidth: .infinity)
        case .unavailable(let message):
            VStack(alignment: .leading, spacing: 8) {
                Text(message).foregroundStyle(NativeEditorStyle.muted)
                Button("Try Again") { Task { await store.load() } }
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("pro.retry")
            }
        case .ready(let allProducts):
            let offered = allProducts.filter { shouldOffer($0.plan) }
            if !offered.isEmpty {
                let savings = ProPricing.savingsPercent(
                    monthly: allProducts.first(where: { $0.plan == .monthly }),
                    yearly: allProducts.first(where: { $0.plan == .yearly })
                )
                if isSubscribed {
                    Text("Upgrade or switch")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(NativeEditorStyle.text)
                }
                VStack(spacing: 10) {
                    ForEach(offered, id: \.plan) { planRow($0, savingsPercent: savings) }
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Plans")
                if let product = offered.first(where: { $0.plan == selected }) {
                    if let trial = product.freeTrial, let period = product.period {
                        Text("No charge today. \(product.displayPrice)/\(period) after \(trial) unless you cancel.")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(NativeEditorStyle.text)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("pro.trialNote")
                    }
                    if isSubscribed && product.plan == .lifetime {
                        Text("Buying Lifetime does not cancel your subscription. Cancel it in Manage subscription.")
                            .font(.footnote)
                            .foregroundStyle(NativeEditorStyle.warning)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("pro.lifetimeUpgradeNote")
                    }
                    Button {
                        guard !checkingBeforePurchase else { return }
                        let chosenPlan = product.plan
                        checkingBeforePurchase = true
                        Task {
                            defer { checkingBeforePurchase = false }
                            await store.refreshAccess()
                            guard viewActive, selected == chosenPlan, shouldOffer(chosenPlan) else { return }
                            await store.buy(chosenPlan, with: purchase)
                        }
                    } label: {
                        Group {
                            if checkingBeforePurchase || store.status == .purchasing(product.plan) { ProgressView().tint(NativeEditorStyle.accentInk) }
                            else { Text(Self.ctaTitle(for: product)).font(.headline) }
                        }
                        .frame(maxWidth: .infinity, minHeight: 50)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(NativeEditorStyle.accent)
                    .foregroundStyle(NativeEditorStyle.accentInk)
                    .disabled(!store.canPurchase || checkingBeforePurchase)
                    .accessibilityIdentifier("pro.purchase")
                    Text(product.terms)
                        .font(.footnote).foregroundStyle(NativeEditorStyle.muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("pro.terms")
                    if !store.canMakePayments {
                        Text(ProMessage.notAllowed).font(.footnote).foregroundStyle(NativeEditorStyle.muted)
                    }
                }
            }
        }
    }

    private func planRow(_ product: ProProduct, savingsPercent: Int?) -> some View {
        let chosen = product.plan == selected
        let monthlyEq = product.plan == .yearly ? ProPricing.monthlyEquivalent(for: product) : nil
        return Button { selected = product.plan } label: {
            HStack(spacing: 12) {
                Image(systemName: chosen ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(chosen ? NativeEditorStyle.accent : NativeEditorStyle.muted)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(Self.title(product.plan)).font(.headline).foregroundStyle(NativeEditorStyle.text)
                        if product.plan == .yearly {
                            badge(savingsPercent.map { "Save \($0)%" } ?? "Best value")
                        }
                    }
                    if let trial = product.freeTrial {
                        Text("\(trial) free").font(.subheadline).foregroundStyle(NativeEditorStyle.accent)
                    } else if product.plan == .lifetime {
                        Text("Pay once · never renews").font(.subheadline).foregroundStyle(NativeEditorStyle.muted)
                    }
                    if let monthlyEq {
                        Text("\(monthlyEq)/mo, billed yearly")
                            .font(.caption)
                            .foregroundStyle(NativeEditorStyle.muted)
                    }
                }
                Spacer(minLength: 8)
                Text(product.period.map { "\(product.displayPrice) / \($0)" } ?? product.displayPrice)
                    .font(.headline).monospacedDigit().foregroundStyle(NativeEditorStyle.text)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
            .background(chosen ? NativeEditorStyle.selectionFill : NativeEditorStyle.panel, in: RoundedRectangle(cornerRadius: 12))
            .overlay { RoundedRectangle(cornerRadius: 12).stroke(chosen ? NativeEditorStyle.accent : NativeEditorStyle.line, lineWidth: chosen ? 2 : 1) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(checkingBeforePurchase || store.isBusy)
        .accessibilityLabel("\(Self.title(product.plan)), \(product.period.map { "\(product.displayPrice) per \($0)" } ?? "\(product.displayPrice), one payment")\(product.freeTrial.map { ", \($0) free" } ?? "")")
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("pro.plan.\(product.plan.rawValue)")
    }

    static func ctaTitle(for product: ProProduct) -> String {
        if let trial = product.freeTrial { return "Start \(trial) free" }
        switch product.plan {
        case .yearly: return "Subscribe yearly"
        case .monthly: return "Subscribe monthly"
        case .lifetime: return "Buy Lifetime"
        }
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 7).padding(.vertical, 3)
            .foregroundStyle(NativeEditorStyle.accentInk)
            .background(NativeEditorStyle.accent, in: Capsule())
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 18) { footerLinks }
                VStack(alignment: .leading, spacing: 4) { footerLinks }
            }
            .font(.footnote.weight(.semibold))
            Text("Apple handles payment. Arya has no account system and keeps no purchase history. Pro works on every iPhone, iPad and Mac signed in to the same Apple Account.")
                .font(.footnote).foregroundStyle(NativeEditorStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder private var footerLinks: some View {
        Button("Restore Purchases") { Task { await store.restore() } }
            .frame(minHeight: 44)
            .disabled(store.status == .restoring)
            .accessibilityIdentifier("pro.restore")
        Link("Terms of Use", destination: Self.termsURL)
            .frame(minHeight: 44)
        Link("Privacy Policy", destination: Self.privacyURL)
            .frame(minHeight: 44)
    }

    static func title(_ plan: ProPlan) -> String {
        switch plan {
        case .monthly: return "Monthly"
        case .yearly: return "Yearly"
        case .lifetime: return "Lifetime"
        }
    }

    private func preferAvailablePlan() {
        guard case .ready(let products) = store.catalog else { return }
        let offered = products.filter { shouldOffer($0.plan) }
        guard !offered.contains(where: { $0.plan == selected }),
              let first = offered.first(where: { $0.plan == .yearly }) ?? offered.first else { return }
        selected = first.plan
    }

    private func handlePendingIntent() async {
        guard let pending = store.pendingIntent, !store.isBusy else { return }
        await store.refreshAccess()
        await store.load()
        guard !Task.isCancelled, !store.isBusy,
              let intent = store.claimPendingIntent(id: pending.id) else { return }
        guard shouldOffer(intent.plan) else { return }
        selected = intent.plan
        // If already subscribed and tapping Lifetime from the App Store, let the user read the
        // subscription-cancellation disclosure and tap Buy Lifetime explicitly instead of auto-charging.
        guard !(isSubscribed && intent.plan == .lifetime) else { return }
        await store.buyIntent(intent, with: purchase)
    }
}
// END PRO VIEW

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
                                     freeTrial: trial))
        }
        return result
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
        var best: ProAccess = .free
        for await result in StoreKit.Transaction.currentEntitlements {
            guard case .verified(let transaction) = result, transaction.revocationDate == nil, !transaction.isUpgraded,
                  let plan = ProPlan(productID: transaction.productID) else { continue }
            if plan == .lifetime { return .lifetime }
            if let expires = transaction.expirationDate, expires < Date() { continue }
            if best == .free || plan == .yearly { best = .subscribed(plan) }
        }
        if best != .free { return best }
        return await NativeProEarlySupport.qualifies() ? .earlySupporter : .free
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

    static func qualifies(defaults: UserDefaults = .standard) async -> Bool {
        if defaults.bool(forKey: key) { return true }
        guard let result = try? await AppTransaction.shared, case .verified(let app) = result,
              app.environment == .production else { return false }
        let early = ProEarlySupporter.qualifies(originalAppVersion: app.originalAppVersion)
        if early { defaults.set(true, forKey: key) }
        return early
    }
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
    private let client = StoreKitProClient()
    private let controller: ProPurchaseController
    private var foreground: NSObjectProtocol?

    private init() {
        controller = ProPurchaseController(client: client)
        controller.onChange = { [weak self] in
            guard let self else { return }
            self.catalog = self.controller.catalog
            self.status = self.controller.status
            self.access = self.controller.access
        }
        controller.onAccessChange = { access in
            ProExportGate.shared.setUnlocked(access.isPro)
            UserDefaults.standard.set(access.isPro, forKey: Self.activeKey)
        }
    }

    var canPurchase: Bool { controller.canPurchase }
    var canMakePayments: Bool { controller.canMakePayments }
    var isPro: Bool { access.isPro }

    /// Call once at launch. App Store builds enforce the export rule from here on. StoreKit
    /// delivers unfinished transactions only to a listener that is running then.
    func start() {
        ProExportGate.shared.enforce(true)
        ProExportGate.shared.setUnlocked(UserDefaults.standard.bool(forKey: Self.activeKey))
        controller.startListening()
        Task { await controller.refreshAccess() }
        foreground = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.controller.refreshAccess() }
        }
    }

    func load() async { await controller.loadProducts() }
    func clearStatus() { controller.clearStatus() }
    func restore() async { await controller.restore() }

    func buy(_ plan: ProPlan, with action: PurchaseAction) async {
        let client = self.client
        await controller.purchase(plan) { id in try await client.purchase(id, using: action) }
    }
}
// END PRO STOREKIT

// BEGIN PRO VIEW
/// The Arya Pro screen. Apple requires the plan, its length, the full renewal price,
/// Restore Purchases and links to the Terms of Use and Privacy Policy before purchase.
struct NativeProView: View {
    @ObservedObject var store: NativeProStore
    /// Why the screen opened, for example after choosing a 4K export.
    var reason: String?
    @Environment(\.purchase) private var purchase
    @State private var selected: ProPlan = .yearly

    static let termsURL = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!
    static let privacyURL = URL(string: "https://editwitharya.app/privacy/")!
    static let manageURL = URL(string: "https://apps.apple.com/account/subscriptions")!

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header
                VStack(alignment: .leading, spacing: 14) {
                    benefit("4k.tv", "Export in 4K and beyond", "Up to 8K, landscape or vertical.")
                    benefit("film.stack", "Apple ProRes", "422, 422 HQ and 4444 with transparency.")
                    benefit("sun.max", "HDR10 and HLG", "10-bit Rec. 2020 for HDR displays.")
                    benefit("heart", "Fund an independent editor", "Pro pays for new features and fixes.")
                }
                if store.access.isPro { activeCard }
                if store.access != .lifetime && !isSubscribed { plans }
                if let message = store.status.message {
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(NativeEditorStyle.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("pro.status")
                }
                footer
            }
            .padding(20)
            .frame(maxWidth: 560, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(NativeEditorStyle.background)
        .tint(NativeEditorStyle.accent)
        .navigationTitle("Arya Pro")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load(); preferAvailablePlan() }
        .onChange(of: store.catalog) { _, _ in preferAvailablePlan() }
        .onDisappear { store.clearStatus() }
    }

    private var isSubscribed: Bool { if case .subscribed = store.access { return true }; return false }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Arya Pro").font(.largeTitle.weight(.bold)).foregroundStyle(NativeEditorStyle.text)
            Text(reason ?? "Editing and 1080p export stay free, with no watermark and no ads. Pro adds delivery for professional work.")
                .font(.body).foregroundStyle(NativeEditorStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private func benefit(_ symbol: String, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(NativeEditorStyle.accent)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline).foregroundStyle(NativeEditorStyle.text)
                Text(detail).font(.subheadline).foregroundStyle(NativeEditorStyle.muted)
            }
        }
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
        case .ready(let products):
            VStack(spacing: 10) {
                ForEach(products, id: \.plan) { planRow($0) }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Plans")
            if let product = products.first(where: { $0.plan == selected }) {
                Button { Task { await store.buy(product.plan, with: purchase) } } label: {
                    Group {
                        if store.status == .purchasing(product.plan) { ProgressView().tint(NativeEditorStyle.accentInk) }
                        else { Text(product.freeTrial == nil ? "Continue" : "Start free trial").font(.headline) }
                    }
                    .frame(maxWidth: .infinity, minHeight: 50)
                }
                .buttonStyle(.borderedProminent)
                .tint(NativeEditorStyle.accent)
                .foregroundStyle(NativeEditorStyle.accentInk)
                .disabled(!store.canPurchase)
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

    private func planRow(_ product: ProProduct) -> some View {
        let chosen = product.plan == selected
        return Button { selected = product.plan } label: {
            HStack(spacing: 12) {
                Image(systemName: chosen ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(chosen ? NativeEditorStyle.accent : NativeEditorStyle.muted)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(Self.title(product.plan)).font(.headline).foregroundStyle(NativeEditorStyle.text)
                        if product.plan == .yearly { badge("Best value") }
                    }
                    if let trial = product.freeTrial {
                        Text("\(trial) free").font(.subheadline).foregroundStyle(NativeEditorStyle.accent)
                    } else if product.plan == .lifetime {
                        Text("Pay once").font(.subheadline).foregroundStyle(NativeEditorStyle.muted)
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
        .accessibilityLabel("\(Self.title(product.plan)), \(product.period.map { "\(product.displayPrice) per \($0)" } ?? "\(product.displayPrice), one payment")\(product.freeTrial.map { ", \($0) free" } ?? "")")
        .accessibilityAddTraits(chosen ? [.isButton, .isSelected] : .isButton)
        .accessibilityIdentifier("pro.plan.\(product.plan.rawValue)")
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
            HStack(spacing: 18) {
                Button("Restore Purchases") { Task { await store.restore() } }
                    .disabled(store.status == .restoring)
                    .accessibilityIdentifier("pro.restore")
                Link("Terms of Use", destination: Self.termsURL)
                Link("Privacy Policy", destination: Self.privacyURL)
            }
            .font(.footnote.weight(.semibold))
            .frame(minHeight: 44)
            Text("Apple handles payment. Arya has no account system and keeps no purchase history. Pro works on every iPhone, iPad and Mac signed in to the same Apple Account.")
                .font(.footnote).foregroundStyle(NativeEditorStyle.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    static func title(_ plan: ProPlan) -> String {
        switch plan {
        case .monthly: return "Monthly"
        case .yearly: return "Yearly"
        case .lifetime: return "Lifetime"
        }
    }

    private func preferAvailablePlan() {
        guard case .ready(let products) = store.catalog, !products.contains(where: { $0.plan == selected }),
              let first = products.first(where: { $0.plan == .yearly }) ?? products.first else { return }
        selected = first.plan
    }
}
// END PRO VIEW

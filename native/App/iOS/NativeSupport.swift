import ReelKit
import StoreKit
import SwiftUI

// BEGIN SUPPORT STOREKIT
/// StoreKit 2 for optional tips. StoreKit checks each signed transaction on the device.
/// Arya has no purchase server, sends no receipts anywhere and keeps no purchase history.
@MainActor
final class StoreKitSupportClient: SupportStoreClient {
    private var loaded: [String: Product] = [:]

    var canMakePayments: Bool { AppStore.canMakePayments }

    func products(for ids: [String]) async throws -> [SupportProduct] {
        let products: [Product]
        do { products = try await Product.products(for: ids) } catch { throw Self.storeError(error) }
        loaded = [:]
        var result: [SupportProduct] = []
        for product in products where product.type == .consumable {
            guard let tier = SupportTier(productID: product.id) else { continue }
            loaded[product.id] = product
            result.append(SupportProduct(tier: tier, displayName: product.displayName,
                                         summary: product.description, displayPrice: product.displayPrice))
        }
        return result
    }

    /// Uses the scene's purchase action so the confirmation sheet appears over the window
    /// that shows the button, including on iPad with several windows.
    func purchase(_ id: String, using action: PurchaseAction) async throws -> SupportPurchaseOutcome {
        guard let product = loaded[id] else { throw SupportStoreError.productUnavailable }
        let result: Product.PurchaseResult
        do { result = try await action(product, options: []) } catch { throw Self.storeError(error) }
        switch result {
        case .success(let verification): return .init(verification)
        case .pending: return .pending
        case .userCancelled: return .userCancelled
        @unknown default: throw SupportStoreError.failed
        }
    }

    /// Unfinished transactions and later updates. Both sources can repeat a transaction;
    /// the controller handles each transaction ID once.
    func transactionUpdates() -> AsyncStream<SupportTransactionUpdate> {
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

    nonisolated static func storeError(_ error: Error) -> Error {
        if error is SupportStoreError || error is CancellationError { return error }
        if let error = error as? StoreKitError {
            switch error {
            case .userCancelled: return SupportStoreError.cancelled
            case .networkError: return SupportStoreError.network
            case .notAvailableInStorefront: return SupportStoreError.productUnavailable
            default: return SupportStoreError.failed
            }
        }
        if let error = error as? Product.PurchaseError {
            switch error {
            case .purchaseNotAllowed: return SupportStoreError.notAllowed
            case .productUnavailable: return SupportStoreError.productUnavailable
            default: return SupportStoreError.failed
            }
        }
        return SupportStoreError.failed
    }
}

extension SupportTransaction {
    init(_ transaction: StoreKit.Transaction) {
        self.init(id: transaction.id, productID: transaction.productID,
                  revoked: transaction.revocationDate != nil,
                  finish: { await transaction.finish() })
    }
}

extension SupportPurchaseOutcome {
    init(_ result: VerificationResult<StoreKit.Transaction>) {
        switch result {
        case .verified(let transaction): self = .verified(SupportTransaction(transaction))
        case .unverified(let transaction, _): self = .unverified(SupportTransaction(transaction))
        }
    }
}

extension SupportTransactionUpdate {
    init(_ result: VerificationResult<StoreKit.Transaction>) {
        switch result {
        case .verified(let transaction): self = .verified(SupportTransaction(transaction))
        case .unverified(let transaction, _): self = .unverified(SupportTransaction(transaction))
        }
    }
}

/// One shared store for the app, so the launch listener and every Support screen agree.
@MainActor
final class NativeSupportStore: ObservableObject {
    static let shared = NativeSupportStore()

    @Published private(set) var catalog: SupportPurchaseController.Catalog = .notLoaded
    @Published private(set) var status: SupportPurchaseController.Status = .idle
    private let client = StoreKitSupportClient()
    private let controller: SupportPurchaseController

    private init() {
        controller = SupportPurchaseController(client: client)
        controller.onChange = { [weak self] in
            guard let self else { return }
            self.catalog = self.controller.catalog
            self.status = self.controller.status
        }
    }

    var canPurchase: Bool { controller.canPurchase }
    var canMakePayments: Bool { controller.canMakePayments }

    /// Call once at launch. StoreKit delivers unfinished transactions only to a listener that
    /// is running then.
    func start() { controller.startListening() }
    func load() async { await controller.loadProducts() }
    func clearStatus() { controller.clearStatus() }

    func buy(_ tier: SupportTier, with action: PurchaseAction) async {
        let client = self.client
        await controller.purchase(tier) { id in try await client.purchase(id, using: action) }
    }
}
// END SUPPORT STOREKIT

// BEGIN SUPPORT VIEW
struct NativeSupportView: View {
    @ObservedObject var store: NativeSupportStore
    @Environment(\.purchase) private var purchase

    var body: some View {
        Form {
            Section {
                Text("Arya is free. Editing, export and every feature stay free, with no account. A tip is optional, unlocks nothing and helps fund development.")
                    .fixedSize(horizontal: false, vertical: true)
            }
            Section("Tips") {
                switch store.catalog {
                case .notLoaded, .loading:
                    ProgressView("Loading tips…")
                case .unavailable(let message):
                    Text(message).foregroundStyle(.secondary)
                    Button("Try Again") { Task { await store.load() } }
                        .accessibilityIdentifier("support.retry")
                case .ready(let products):
                    ForEach(products, id: \.tier) { product in
                        tipButton(product)
                    }
                    if !store.canMakePayments {
                        Text(SupportMessage.notAllowed).font(.footnote).foregroundStyle(.secondary)
                    }
                }
            }
            if let message = store.status.message {
                Section {
                    Text(message)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("support.status")
                }
            }
            Section {
                Text("Apple handles payment. Arya has no account system and does not store your purchases. Tips are one-time and do not renew.")
                    .font(.footnote).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(NativeEditorStyle.accent)
        .navigationTitle("Support Arya")
        .task { await store.load() }
        .onDisappear { store.clearStatus() }
    }

    private func tipButton(_ product: SupportProduct) -> some View {
        let buying = store.status == .purchasing(product.tier)
        return Button {
            Task { await store.buy(product.tier, with: purchase) }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(product.displayName).foregroundStyle(NativeEditorStyle.text)
                    if !product.summary.isEmpty {
                        Text(product.summary).font(.footnote).foregroundStyle(NativeEditorStyle.muted)
                    }
                }
                Spacer(minLength: 8)
                if buying { ProgressView() } else { Text(product.displayPrice).monospacedDigit().foregroundStyle(NativeEditorStyle.accent) }
            }
            .foregroundStyle(.primary)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .disabled(!store.canPurchase)
        .accessibilityLabel("\(product.displayName), \(product.displayPrice)")
        .accessibilityHint("Optional tip. It unlocks nothing.")
        .accessibilityIdentifier("support.tip.\(product.tier.rawValue)")
    }
}
// END SUPPORT VIEW

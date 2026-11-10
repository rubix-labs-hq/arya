import Foundation

// BEGIN SUPPORT PURCHASES
/// Optional tips through Apple In-App Purchase. A tip unlocks nothing. Editing, export and
/// every other feature stay free, and no account is involved. This file holds only the
/// purchase state machine, so tests can drive every outcome through a fake store. StoreKit
/// itself lives in the iOS app target (`native/App/iOS/NativeSupport.swift`).
public enum SupportTier: String, CaseIterable, Sendable {
    case small, medium, large

    public static let productIDPrefix = "app.reel.ios.support."
    public var productID: String { Self.productIDPrefix + rawValue }

    public init?(productID: String) {
        guard productID.hasPrefix(Self.productIDPrefix) else { return nil }
        self.init(rawValue: String(productID.dropFirst(Self.productIDPrefix.count)))
    }
}

/// What the App Store returned for one tip. `displayPrice` is already localized for the
/// customer's storefront; Arya never formats or hard-codes a price.
public struct SupportProduct: Equatable, Sendable {
    public let tier: SupportTier
    public let displayName: String
    public let summary: String
    public let displayPrice: String

    public init(tier: SupportTier, displayName: String, summary: String, displayPrice: String) {
        self.tier = tier; self.displayName = displayName; self.summary = summary; self.displayPrice = displayPrice
    }
}

/// One App Store transaction. `finish` tells the App Store that Arya handled it.
public struct SupportTransaction: Sendable {
    public let id: UInt64
    public let productID: String
    public let revoked: Bool
    public let finish: @Sendable () async -> Void

    public init(id: UInt64, productID: String, revoked: Bool = false, finish: @escaping @Sendable () async -> Void) {
        self.id = id; self.productID = productID; self.revoked = revoked; self.finish = finish
    }
}

/// The result of one purchase sheet.
public enum SupportPurchaseOutcome: Sendable {
    case verified(SupportTransaction)
    case unverified(SupportTransaction)
    case pending
    case userCancelled
}

/// Transactions that arrive outside a purchase call: unfinished ones at launch, Ask to Buy
/// approvals, and refunds.
public enum SupportTransactionUpdate: Sendable {
    case verified(SupportTransaction)
    case unverified(SupportTransaction)
}

/// Store failures, already sorted into the cases Arya explains differently.
public enum SupportStoreError: Error, Equatable, Sendable {
    case cancelled, notAllowed, network, productUnavailable, failed
}

/// The App Store as the controller sees it. The iOS app provides a StoreKit 2 version;
/// tests provide a fake.
@MainActor
public protocol SupportStoreClient: AnyObject {
    var canMakePayments: Bool { get }
    func products(for ids: [String]) async throws -> [SupportProduct]
    func transactionUpdates() -> AsyncStream<SupportTransactionUpdate>
}

@MainActor
public final class SupportPurchaseController {
    public enum Catalog: Equatable {
        case notLoaded, loading
        case ready([SupportProduct])
        case unavailable(String)
    }

    public enum Status: Equatable {
        case idle
        case purchasing(SupportTier)
        case pending(SupportTier)
        case thanked(SupportTier)
        case cancelled
        case failed(String)

        public var message: String? {
            switch self {
            case .idle, .purchasing: return nil
            case .pending: return SupportMessage.pending
            case .thanked: return SupportMessage.thanked
            case .cancelled: return SupportMessage.cancelled
            case .failed(let message): return message
            }
        }
    }

    /// Starts one purchase for a product ID. The app passes a closure per call because the
    /// SwiftUI purchase action belongs to the scene that shows the button.
    public typealias Purchase = @MainActor (String) async throws -> SupportPurchaseOutcome

    public private(set) var catalog: Catalog = .notLoaded { didSet { onChange?() } }
    public private(set) var status: Status = .idle { didSet { onChange?() } }
    public var onChange: (() -> Void)?

    private let client: SupportStoreClient
    private var handled: Set<UInt64> = []
    private var listener: Task<Void, Never>?

    public init(client: SupportStoreClient) { self.client = client }

    public var isPurchasing: Bool {
        if case .purchasing = status { return true }
        return false
    }

    public var canMakePayments: Bool { client.canMakePayments }

    /// True when a tip button may start a purchase. Buttons stay disabled while any purchase
    /// is in progress, so a second tap cannot open a second sheet.
    public var canPurchase: Bool {
        guard client.canMakePayments, !isPurchasing, case .ready(let products) = catalog else { return false }
        return !products.isEmpty
    }

    public func loadProducts() async {
        switch catalog {
        case .loading, .ready: return
        case .notLoaded, .unavailable: break
        }
        catalog = .loading
        do {
            let products = try await client.products(for: SupportTier.allCases.map(\.productID))
            let byTier = Dictionary(products.map { ($0.tier, $0) }, uniquingKeysWith: { first, _ in first })
            let ordered = SupportTier.allCases.compactMap { byTier[$0] }
            catalog = ordered.isEmpty ? .unavailable(SupportMessage.noProducts) : .ready(ordered)
        } catch {
            catalog = .unavailable(SupportMessage.loadFailed)
        }
    }

    /// Returns false when the request was refused before any purchase sheet could appear.
    @discardableResult
    public func purchase(_ tier: SupportTier, using perform: Purchase) async -> Bool {
        guard !isPurchasing else { return false }
        guard client.canMakePayments else { status = .failed(SupportMessage.notAllowed); return false }
        guard case .ready(let products) = catalog, products.contains(where: { $0.tier == tier }) else {
            status = .failed(SupportMessage.productUnavailable); return false
        }
        status = .purchasing(tier)
        do {
            switch try await perform(tier.productID) {
            case .verified(let transaction):
                await accept(transaction, fromPurchase: true)
            case .unverified:
                // Not thanked and not finished. A transient verification failure is
                // delivered again at the next launch, and a valid one is then finished.
                status = .failed(SupportMessage.unverified)
            case .pending:
                status = .pending(tier)
            case .userCancelled:
                status = .cancelled
            }
        } catch let error as SupportStoreError {
            status = Self.status(for: error)
        } catch is CancellationError {
            status = .cancelled
        } catch {
            status = .failed(SupportMessage.failed)
        }
        return true
    }

    /// Listen for transactions that arrive outside a purchase call. Start this at launch.
    public func startListening() {
        guard listener == nil else { return }
        let updates = client.transactionUpdates()
        listener = Task { [weak self] in
            for await update in updates {
                guard let self, !Task.isCancelled else { return }
                await self.handle(update)
            }
        }
    }

    public func stopListening() {
        listener?.cancel(); listener = nil
    }

    public func handle(_ update: SupportTransactionUpdate) async {
        switch update {
        case .verified(let transaction): await accept(transaction, fromPurchase: false)
        case .unverified: break // Left unfinished and silent; see `purchase`.
        }
    }

    public func clearStatus() {
        guard !isPurchasing else { return }
        status = .idle
    }

    private func accept(_ transaction: SupportTransaction, fromPurchase: Bool) async {
        let tier = SupportTier(productID: transaction.productID)
        guard handled.insert(transaction.id).inserted else {
            // An unfinished/update stream can win the race with the purchase result.
            // Finish only once, but always let that result release the purchase UI.
            if fromPurchase {
                if !transaction.revoked, let tier { status = .thanked(tier) }
                else { status = .idle }
            }
            return
        }
        if !transaction.revoked, let tier {
            // A tip delivers only this thank-you, so record it before finishing.
            if fromPurchase || !isPurchasing { status = .thanked(tier) }
        } else if fromPurchase {
            status = .idle
        }
        await transaction.finish()
    }

    private static func status(for error: SupportStoreError) -> Status {
        switch error {
        case .cancelled: return .cancelled
        case .notAllowed: return .failed(SupportMessage.notAllowed)
        case .network: return .failed(SupportMessage.network)
        case .productUnavailable: return .failed(SupportMessage.productUnavailable)
        case .failed: return .failed(SupportMessage.failed)
        }
    }
}

public enum SupportMessage {
    public static let thanked = "Thank you for supporting Arya."
    public static let pending = "Your tip is waiting for approval. You can keep editing. Arya completes the tip if it is approved."
    public static let cancelled = "Purchase cancelled."
    public static let notAllowed = "Purchases are turned off on this device, for example in Screen Time."
    public static let network = "Arya could not reach the App Store. Check your connection and try again."
    public static let productUnavailable = "This tip is not available right now."
    public static let failed = "The App Store could not complete the purchase. Try again later."
    public static let unverified = "Apple could not verify this purchase, so Arya did not record it. If you were charged, you can request a refund at reportaproblem.apple.com."
    public static let noProducts = "Tips are not available right now. Everything in Arya stays free."
    public static let loadFailed = "Arya could not load tips from the App Store. Everything in Arya stays free."
}
// END SUPPORT PURCHASES

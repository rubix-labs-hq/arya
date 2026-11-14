import Foundation

// BEGIN ARYA PRO
/// Arya Pro through Apple In-App Purchase, for the App Store editions only. Editing and 1080p
/// export stay free. Pro adds exports above 1080p, Apple ProRes and HDR delivery. The direct
/// Mac download and the browser editors never enforce Pro.
///
/// This file holds only the rules and the purchase state machine, so tests can drive every
/// outcome through a fake store. StoreKit itself lives in the iOS app target
/// (`native/App/iOS/NativeSupport.swift`).
public enum ProPlan: String, CaseIterable, Sendable {
    case monthly, yearly, lifetime

    public static let productIDPrefix = "app.reel.ios.pro."
    public var productID: String { Self.productIDPrefix + rawValue }
    public var renews: Bool { self != .lifetime }

    public init?(productID: String) {
        guard productID.hasPrefix(Self.productIDPrefix) else { return nil }
        self.init(rawValue: String(productID.dropFirst(Self.productIDPrefix.count)))
    }
}

/// What the App Store returned for one plan. `displayPrice` is already localized for the
/// customer's storefront; Arya never formats or hard-codes a price.
public struct ProProduct: Equatable, Sendable {
    public let plan: ProPlan
    public let displayName: String
    public let displayPrice: String
    /// For example "month" or "year". Nil for Lifetime.
    public let period: String?
    /// For example "1 week". Set only when this customer is eligible for a free trial.
    public let freeTrial: String?

    public init(plan: ProPlan, displayName: String, displayPrice: String, period: String? = nil, freeTrial: String? = nil) {
        self.plan = plan; self.displayName = displayName; self.displayPrice = displayPrice
        self.period = period; self.freeTrial = freeTrial
    }

    /// The full price line Apple requires next to the purchase button.
    public var terms: String {
        guard let period else { return "\(displayPrice), one payment. Lifetime never renews." }
        let renewal = "\(displayPrice) per \(period). Renews automatically unless you cancel at least 24 hours before the period ends."
        guard let freeTrial else { return renewal }
        return "Free for \(freeTrial), then \(renewal)"
    }
}

/// Why this device has Pro.
public enum ProAccess: Equatable, Sendable {
    case free
    /// Installed from the App Store before Arya Pro existed, when every feature was free.
    case earlySupporter
    case subscribed(ProPlan)
    case lifetime

    public var isPro: Bool { self != .free }

    public var summary: String {
        switch self {
        case .free: return "Not active"
        case .earlySupporter: return "Included for early supporters"
        case .subscribed(let plan): return plan == .yearly ? "Active, yearly" : "Active, monthly"
        case .lifetime: return "Lifetime"
        }
    }
}

/// One App Store transaction. `finish` tells the App Store that Arya handled it.
public struct ProTransaction: Sendable {
    public let id: UInt64
    public let productID: String
    public let revoked: Bool
    public let finish: @Sendable () async -> Void

    public init(id: UInt64, productID: String, revoked: Bool = false, finish: @escaping @Sendable () async -> Void) {
        self.id = id; self.productID = productID; self.revoked = revoked; self.finish = finish
    }
}

public enum ProPurchaseOutcome: Sendable {
    case verified(ProTransaction)
    case unverified(ProTransaction)
    case pending
    case userCancelled
}

/// Transactions that arrive outside a purchase call: unfinished ones at launch, renewals,
/// Ask to Buy approvals, refunds and purchases made on another device.
public enum ProTransactionUpdate: Sendable {
    case verified(ProTransaction)
    case unverified(ProTransaction)
}

public enum ProStoreError: Error, Equatable, Sendable {
    case cancelled, notAllowed, network, productUnavailable, failed
}

/// The App Store as the controller sees it. The iOS app provides a StoreKit 2 version;
/// tests provide a fake.
@MainActor
public protocol ProStoreClient: AnyObject {
    var canMakePayments: Bool { get }
    func products(for ids: [String]) async throws -> [ProProduct]
    /// Reads the verified, unrevoked entitlements on this device.
    func currentAccess() async -> ProAccess
    func transactionUpdates() -> AsyncStream<ProTransactionUpdate>
    /// Asks the App Store to bring this device's purchases up to date. Shows a sign-in sheet when needed.
    func restore() async throws
}

@MainActor
public final class ProPurchaseController {
    public enum Catalog: Equatable {
        case notLoaded, loading
        case ready([ProProduct])
        case unavailable(String)
    }

    public enum Status: Equatable {
        case idle
        case purchasing(ProPlan)
        case restoring
        case pending(ProPlan)
        case unlocked
        case nothingToRestore
        case cancelled
        case failed(String)

        public var message: String? {
            switch self {
            case .idle, .purchasing, .restoring: return nil
            case .pending: return ProMessage.pending
            case .unlocked: return ProMessage.unlocked
            case .nothingToRestore: return ProMessage.nothingToRestore
            case .cancelled: return ProMessage.cancelled
            case .failed(let message): return message
            }
        }
    }

    public typealias Purchase = @MainActor (String) async throws -> ProPurchaseOutcome

    public private(set) var catalog: Catalog = .notLoaded { didSet { onChange?() } }
    public private(set) var status: Status = .idle { didSet { onChange?() } }
    public private(set) var access: ProAccess = .free { didSet { if access != oldValue { onChange?(); onAccessChange?(access) } } }
    public var onChange: (() -> Void)?
    /// Called whenever Pro turns on or off, so the export gate follows at once.
    public var onAccessChange: ((ProAccess) -> Void)?

    private let client: ProStoreClient
    private var handled: Set<UInt64> = []
    private var listener: Task<Void, Never>?

    public init(client: ProStoreClient) { self.client = client }

    public var isBusy: Bool {
        switch status {
        case .purchasing, .restoring: return true
        default: return false
        }
    }

    public var canMakePayments: Bool { client.canMakePayments }

    public var canPurchase: Bool {
        guard client.canMakePayments, !isBusy, case .ready(let products) = catalog else { return false }
        return !products.isEmpty
    }

    public func loadProducts() async {
        switch catalog {
        case .loading, .ready: return
        case .notLoaded, .unavailable: break
        }
        catalog = .loading
        do {
            let products = try await client.products(for: ProPlan.allCases.map(\.productID))
            let byPlan = Dictionary(products.map { ($0.plan, $0) }, uniquingKeysWith: { first, _ in first })
            let ordered = ProPlan.allCases.compactMap { byPlan[$0] }
            catalog = ordered.isEmpty ? .unavailable(ProMessage.noProducts) : .ready(ordered)
        } catch {
            catalog = .unavailable(ProMessage.loadFailed)
        }
    }

    /// Reads entitlements again. Call at launch and whenever the app returns to the foreground.
    public func refreshAccess() async {
        access = await client.currentAccess()
    }

    /// Returns false when the request was refused before any purchase sheet could appear.
    @discardableResult
    public func purchase(_ plan: ProPlan, using perform: Purchase) async -> Bool {
        guard !isBusy else { return false }
        guard client.canMakePayments else { status = .failed(ProMessage.notAllowed); return false }
        guard case .ready(let products) = catalog, products.contains(where: { $0.plan == plan }) else {
            status = .failed(ProMessage.productUnavailable); return false
        }
        status = .purchasing(plan)
        do {
            switch try await perform(plan.productID) {
            case .verified(let transaction):
                await accept(transaction, fromPurchase: true)
            case .unverified:
                // Not unlocked and not finished. A transient verification failure is
                // delivered again at the next launch, and a valid one is then finished.
                status = .failed(ProMessage.unverified)
            case .pending:
                status = .pending(plan)
            case .userCancelled:
                status = .cancelled
            }
        } catch let error as ProStoreError {
            status = Self.status(for: error)
        } catch is CancellationError {
            status = .cancelled
        } catch {
            status = .failed(ProMessage.failed)
        }
        return true
    }

    /// Restore Purchases. Apple requires this button for anything that can be restored.
    public func restore() async {
        guard !isBusy else { return }
        status = .restoring
        do {
            try await client.restore()
            await refreshAccess()
            status = access.isPro ? .unlocked : .nothingToRestore
        } catch let error as ProStoreError {
            status = Self.status(for: error)
        } catch is CancellationError {
            status = .cancelled
        } catch {
            status = .failed(ProMessage.failed)
        }
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

    public func handle(_ update: ProTransactionUpdate) async {
        switch update {
        case .verified(let transaction): await accept(transaction, fromPurchase: false)
        case .unverified: break // Left unfinished and silent; see `purchase`.
        }
    }

    public func clearStatus() {
        guard !isBusy else { return }
        status = .idle
    }

    private func accept(_ transaction: ProTransaction, fromPurchase: Bool) async {
        let first = handled.insert(transaction.id).inserted
        // Entitlements come from the App Store, never from this transaction alone, so a refund,
        // a lapsed renewal or another plan is read the same way.
        await refreshAccess()
        if first { await transaction.finish() }
        guard fromPurchase else { return }
        status = !transaction.revoked && access.isPro ? .unlocked : .idle
    }

    private static func status(for error: ProStoreError) -> Status {
        switch error {
        case .cancelled: return .cancelled
        case .notAllowed: return .failed(ProMessage.notAllowed)
        case .network: return .failed(ProMessage.network)
        case .productUnavailable: return .failed(ProMessage.productUnavailable)
        case .failed: return .failed(ProMessage.failed)
        }
    }
}

/// App Store installs from before Arya Pro keep Pro. Their copy of Arya promised that every
/// feature stays free, so that promise holds for them.
public enum ProEarlySupporter {
    /// The first App Store build that sells Pro. iOS reports the original build number
    /// (CFBundleVersion); macOS reports the original marketing version.
    public static let firstProBuild = 6
    public static let firstProVersion = "1.2.0"

    public static func qualifies(originalAppVersion: String) -> Bool {
        let value = originalAppVersion.trimmingCharacters(in: .whitespaces)
        if value.contains(".") {
            return compare(value, firstProVersion) == .orderedAscending
        }
        guard let build = Int(value) else { return false }
        return build < firstProBuild
    }

    static func compare(_ a: String, _ b: String) -> ComparisonResult {
        let left = a.split(separator: ".").map { Int($0) ?? 0 }, right = b.split(separator: ".").map { Int($0) ?? 0 }
        for index in 0..<max(left.count, right.count) {
            let l = index < left.count ? left[index] : 0, r = index < right.count ? right[index] : 0
            if l != r { return l < r ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }
}

/// What a free App Store edition may export. Everything else needs Pro.
public enum ProExportRule {
    public static let maximumFreeLongEdge = 1920
    public static let maximumFreeShortEdge = 1080

    /// True when this export needs Pro: a picture above 1080p in either orientation, any
    /// Apple ProRes preset, or HDR. Audio-only exports are always free.
    public static func requiresPro(width: Double, height: Double, preset: String, hdr: String?) -> Bool {
        if preset.hasPrefix("audio-") { return false }
        if preset.hasPrefix("prores-") { return true }
        if let hdr, !hdr.isEmpty, hdr != "sdr" { return true }
        let w = Int(width.rounded()), h = Int(height.rounded())
        return max(w, h) > maximumFreeLongEdge || min(w, h) > maximumFreeShortEdge
    }

    /// The largest even output width whose height (rounded the way Deliver rounds it) is also
    /// even and fits inside `longEdge` by `shortEdge` in either orientation. 1920 by 1080 gives
    /// the largest free size for any aspect ratio; 3840 by 2160 gives 4K.
    public static func fittedWidth(canvasWidth: Double, canvasHeight: Double, longEdge: Double, shortEdge: Double) -> Int? {
        guard canvasWidth.isFinite, canvasHeight.isFinite, canvasWidth > 0, canvasHeight > 0 else { return nil }
        let scale = min(longEdge / max(canvasWidth, canvasHeight), shortEdge / min(canvasWidth, canvasHeight))
        var width = Int((canvasWidth * scale / 2).rounded(.down)) * 2
        while width >= 2 {
            let height = Int((Double(width) * canvasHeight / canvasWidth).rounded())
            if height >= 2, height % 2 == 0, max(width, height) <= Int(longEdge), min(width, height) <= Int(shortEdge) { return width }
            width -= 2
        }
        return nil
    }
    public static let lockedMessage = "Exports above 1080p, Apple ProRes and HDR are part of Arya Pro. Choose 1080p or smaller, or get Arya Pro in Settings."
}

/// The export gate the backend consults. Only App Store editions turn enforcement on, so the
/// direct Mac download, the browser editors and tests export everything.
public final class ProExportGate: @unchecked Sendable {
    public static let shared = ProExportGate()

    private let lock = NSLock()
    private var enforced = false
    private var unlocked = false

    public init() {}

    public func enforce(_ value: Bool) { lock.lock(); enforced = value; lock.unlock() }
    public func setUnlocked(_ value: Bool) { lock.lock(); unlocked = value; lock.unlock() }

    /// True when this export may run on this device now.
    public func allows(width: Double, height: Double, preset: String, hdr: String?) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return !enforced || unlocked || !ProExportRule.requiresPro(width: width, height: height, preset: preset, hdr: hdr)
    }

}

public enum ProMessage {
    public static let unlocked = "Arya Pro is active. Thank you for supporting Arya."
    public static let pending = "Your purchase is waiting for approval. You can keep editing. Pro turns on if it is approved."
    public static let nothingToRestore = "No Arya Pro purchase was found for this Apple Account."
    public static let cancelled = "Purchase cancelled."
    public static let notAllowed = "Purchases are turned off on this device, for example in Screen Time."
    public static let network = "Arya could not reach the App Store. Check your connection and try again."
    public static let productUnavailable = "This plan is not available right now."
    public static let failed = "The App Store could not complete the purchase. Try again later."
    public static let unverified = "Apple could not verify this purchase, so Arya did not unlock Pro. If you were charged, you can request a refund at reportaproblem.apple.com."
    public static let noProducts = "Arya Pro is not available right now. Editing and 1080p export stay free."
    public static let loadFailed = "Arya could not load Arya Pro from the App Store. Editing and 1080p export stay free."
}
// END ARYA PRO

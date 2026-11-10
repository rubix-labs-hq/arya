import Foundation
import XCTest
@testable import ReelKit

/// Drives every tip outcome through a fake store. No StoreKit, network or sleeps.
@MainActor
final class SupportPurchaseTests: XCTestCase {
    private actor FinishLog {
        private(set) var ids: [UInt64] = []
        func record(_ id: UInt64) { ids.append(id) }
    }

    private final class FakeStore: SupportStoreClient {
        var canMakePayments = true
        var requests: [[String]] = []
        var results: [Result<[SupportProduct], Error>] = []
        let updates: AsyncStream<SupportTransactionUpdate>
        let feed: AsyncStream<SupportTransactionUpdate>.Continuation

        init(_ results: [Result<[SupportProduct], Error>] = [.success(SupportPurchaseTests.catalog)]) {
            self.results = results
            (updates, feed) = AsyncStream.makeStream(of: SupportTransactionUpdate.self)
        }

        func products(for ids: [String]) async throws -> [SupportProduct] {
            requests.append(ids)
            return try (results.isEmpty ? .success([]) : results.removeFirst()).get()
        }

        func transactionUpdates() -> AsyncStream<SupportTransactionUpdate> { updates }
    }

    private struct Unexpected: Error {}

    // Prices come back localized from the store; the controller must pass them through.
    nonisolated static let catalog = [
        SupportProduct(tier: .large, displayName: "Large tip", summary: "Thanks a lot", displayPrice: "29,99 €"),
        SupportProduct(tier: .small, displayName: "Small tip", summary: "Thanks", displayPrice: "4,99 €"),
        SupportProduct(tier: .medium, displayName: "Medium tip", summary: "Thanks more", displayPrice: "14,99 €"),
    ]

    private func transaction(_ id: UInt64, _ tier: SupportTier, revoked: Bool = false, log: FinishLog,
                             finished: XCTestExpectation? = nil) -> SupportTransaction {
        transaction(id, productID: tier.productID, revoked: revoked, log: log, finished: finished)
    }

    private func transaction(_ id: UInt64, productID: String, revoked: Bool = false, log: FinishLog,
                             finished: XCTestExpectation? = nil) -> SupportTransaction {
        SupportTransaction(id: id, productID: productID, revoked: revoked) {
            await log.record(id)
            finished?.fulfill()
        }
    }

    private func loaded(_ given: FakeStore? = nil) async -> (SupportPurchaseController, FakeStore) {
        let store = given ?? FakeStore()
        let controller = SupportPurchaseController(client: store)
        await controller.loadProducts()
        return (controller, store)
    }

    func testProductIdentifiersMatchAppStoreConnect() {
        XCTAssertEqual(SupportTier.allCases.map(\.productID),
                       ["app.reel.ios.support.small", "app.reel.ios.support.medium", "app.reel.ios.support.large"])
        for tier in SupportTier.allCases { XCTAssertEqual(SupportTier(productID: tier.productID), tier) }
        XCTAssertNil(SupportTier(productID: "app.reel.ios.support.huge"))
        XCTAssertNil(SupportTier(productID: "small"))
    }

    func testLoadRequestsTheThreeTipsAndKeepsTierOrderAndStorePrices() async {
        let (controller, store) = await loaded()
        XCTAssertEqual(store.requests, [SupportTier.allCases.map(\.productID)])
        guard case .ready(let products) = controller.catalog else { return XCTFail("catalog not ready") }
        XCTAssertEqual(products.map(\.tier), [.small, .medium, .large])
        XCTAssertEqual(products.map(\.displayPrice), ["4,99 €", "14,99 €", "29,99 €"])
        XCTAssertTrue(controller.canPurchase)

        await controller.loadProducts()
        XCTAssertEqual(store.requests.count, 1, "A loaded catalog is not fetched again")
    }

    func testLoadFailureAndEmptyCatalogAreRecoverable() async {
        let store = FakeStore([.failure(Unexpected()), .success([]), .success(Self.catalog)])
        let controller = SupportPurchaseController(client: store)
        await controller.loadProducts()
        XCTAssertEqual(controller.catalog, .unavailable(SupportMessage.loadFailed))
        XCTAssertFalse(controller.canPurchase)
        await controller.loadProducts()
        XCTAssertEqual(controller.catalog, .unavailable(SupportMessage.noProducts))
        await controller.loadProducts()
        guard case .ready = controller.catalog else { return XCTFail("retry did not load") }
        XCTAssertEqual(store.requests.count, 3)
    }

    func testVerifiedPurchaseThanksAndFinishesOnce() async {
        let (controller, _) = await loaded()
        let log = FinishLog()
        var requested: [String] = []
        let started = await controller.purchase(.medium) { id in
            requested.append(id)
            return .verified(self.transaction(11, .medium, log: log))
        }
        XCTAssertTrue(started)
        XCTAssertEqual(requested, ["app.reel.ios.support.medium"])
        XCTAssertEqual(controller.status, .thanked(.medium))
        XCTAssertEqual(controller.status.message, SupportMessage.thanked)
        let finished = await log.ids
        XCTAssertEqual(finished, [11])
        XCTAssertTrue(controller.canPurchase, "Another tip may follow")

        // The same transaction later arriving through updates is not processed again.
        await controller.handle(.verified(transaction(11, .medium, log: log)))
        let afterDuplicate = await log.ids
        XCTAssertEqual(afterDuplicate, [11])
    }

    func testUpdateBeforePurchaseResultDoesNotLeaveButtonsDisabled() async {
        let (controller, _) = await loaded()
        let log = FinishLog()
        let tip = transaction(91, .small, log: log)
        await controller.purchase(.small) { _ in
            await controller.handle(.verified(tip))
            return .verified(tip)
        }
        XCTAssertEqual(controller.status, .thanked(.small))
        XCTAssertTrue(controller.canPurchase)
        let finished = await log.ids
        XCTAssertEqual(finished, [91])
    }

    func testUnverifiedPurchaseIsNeitherThankedNorFinished() async {
        let (controller, _) = await loaded()
        let log = FinishLog()
        await controller.purchase(.small) { _ in .unverified(self.transaction(12, .small, log: log)) }
        XCTAssertEqual(controller.status, .failed(SupportMessage.unverified))
        let finished = await log.ids
        XCTAssertEqual(finished, [])
    }

    func testPendingPurchaseCompletesThroughUpdates() async {
        let (controller, _) = await loaded()
        let log = FinishLog()
        await controller.purchase(.large) { _ in .pending }
        XCTAssertEqual(controller.status, .pending(.large))
        XCTAssertEqual(controller.status.message, SupportMessage.pending)
        XCTAssertTrue(controller.canPurchase, "Pending approval does not lock the buttons")
        let before = await log.ids
        XCTAssertEqual(before, [])

        await controller.handle(.verified(transaction(13, .large, log: log)))
        XCTAssertEqual(controller.status, .thanked(.large))
        let after = await log.ids
        XCTAssertEqual(after, [13])
    }

    func testUserCancellationIsQuietAndRetryable() async {
        let (controller, _) = await loaded()
        var calls = 0
        await controller.purchase(.small) { _ in calls += 1; return .userCancelled }
        XCTAssertEqual(controller.status, .cancelled)
        XCTAssertTrue(controller.canPurchase)
        await controller.purchase(.small) { _ in calls += 1; throw CancellationError() }
        XCTAssertEqual(controller.status, .cancelled)
        XCTAssertEqual(calls, 2)
        controller.clearStatus()
        XCTAssertEqual(controller.status, .idle)
    }

    func testStoreFailuresReleaseTheButtonsWithSpecificMessages() async {
        let (controller, _) = await loaded()
        let cases: [(Error, SupportPurchaseController.Status)] = [
            (SupportStoreError.cancelled, .cancelled),
            (SupportStoreError.notAllowed, .failed(SupportMessage.notAllowed)),
            (SupportStoreError.network, .failed(SupportMessage.network)),
            (SupportStoreError.productUnavailable, .failed(SupportMessage.productUnavailable)),
            (SupportStoreError.failed, .failed(SupportMessage.failed)),
            (Unexpected(), .failed(SupportMessage.failed)),
        ]
        for (error, expected) in cases {
            let started = await controller.purchase(.small) { _ in throw error }
            XCTAssertTrue(started)
            XCTAssertEqual(controller.status, expected, "\(error)")
            XCTAssertFalse(controller.isPurchasing)
            XCTAssertTrue(controller.canPurchase)
        }
    }

    func testDuplicateTapsStartOnlyOnePurchase() async throws {
        let (controller, _) = await loaded()
        let log = FinishLog()
        var calls = 0
        var gate: CheckedContinuation<SupportPurchaseOutcome, Error>?
        let entered = expectation(description: "purchase sheet requested")
        let first = Task {
            await controller.purchase(.small) { _ in
                calls += 1
                return try await withCheckedThrowingContinuation { continuation in
                    gate = continuation
                    entered.fulfill()
                }
            }
        }
        await fulfillment(of: [entered], timeout: 5)
        XCTAssertEqual(controller.status, .purchasing(.small))
        XCTAssertFalse(controller.canPurchase)

        for tier in SupportTier.allCases {
            let started = await controller.purchase(tier) { _ in calls += 1; return .userCancelled }
            XCTAssertFalse(started, "A tap during a purchase is ignored")
        }
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(controller.status, .purchasing(.small))

        // An Ask to Buy approval arriving now is finished, without hiding the active spinner.
        await controller.handle(.verified(transaction(20, .large, log: log)))
        XCTAssertEqual(controller.status, .purchasing(.small))

        try XCTUnwrap(gate).resume(returning: .verified(transaction(21, .small, log: log)))
        let started = await first.value
        XCTAssertTrue(started)
        XCTAssertEqual(controller.status, .thanked(.small))
        let finished = await log.ids
        XCTAssertEqual(finished, [20, 21])
    }

    func testPurchasesAreRefusedWithoutPaymentsOrCatalog() async {
        let store = FakeStore()
        let controller = SupportPurchaseController(client: store)
        var calls = 0
        let early = await controller.purchase(.small) { _ in calls += 1; return .userCancelled }
        XCTAssertFalse(early)
        XCTAssertEqual(controller.status, .failed(SupportMessage.productUnavailable))

        await controller.loadProducts()
        store.canMakePayments = false
        XCTAssertFalse(controller.canPurchase)
        let blocked = await controller.purchase(.small) { _ in calls += 1; return .userCancelled }
        XCTAssertFalse(blocked)
        XCTAssertEqual(controller.status, .failed(SupportMessage.notAllowed))
        XCTAssertEqual(calls, 0, "No purchase sheet without permission")
    }

    func testListenerFinishesLaunchTransactionsOnceInOrder() async {
        let (controller, store) = await loaded()
        let log = FinishLog()
        controller.startListening()
        controller.startListening() // A second start keeps the single listener.

        let first = expectation(description: "first finished")
        store.feed.yield(.verified(transaction(30, .small, log: log, finished: first)))
        await fulfillment(of: [first], timeout: 5)
        XCTAssertEqual(controller.status, .thanked(.small))

        // `Transaction.unfinished` and `Transaction.updates` can both deliver one transaction.
        let sentinel = expectation(description: "sentinel finished")
        store.feed.yield(.verified(transaction(30, .small, log: log)))
        store.feed.yield(.unverified(transaction(31, .medium, log: log)))
        store.feed.yield(.verified(transaction(32, .medium, log: log, finished: sentinel)))
        await fulfillment(of: [sentinel], timeout: 5)
        let finished = await log.ids
        XCTAssertEqual(finished, [30, 32], "Duplicate skipped, unverified left unfinished")
        XCTAssertEqual(controller.status, .thanked(.medium))
        controller.stopListening()
    }

    func testRefundsAndUnknownProductsAreFinishedWithoutThanks() async {
        let (controller, _) = await loaded()
        let log = FinishLog()
        await controller.handle(.verified(transaction(40, .small, revoked: true, log: log)))
        await controller.handle(.verified(transaction(41, productID: "app.reel.ios.support.retired", log: log)))
        XCTAssertEqual(controller.status, .idle)
        await controller.handle(.unverified(transaction(42, .small, log: log)))
        XCTAssertEqual(controller.status, .idle, "An unverified update stays silent")
        let finished = await log.ids
        XCTAssertEqual(finished, [40, 41])

        await controller.purchase(.medium) { _ in .verified(self.transaction(43, .medium, revoked: true, log: log)) }
        XCTAssertEqual(controller.status, .idle)
        let afterRevoked = await log.ids
        XCTAssertEqual(afterRevoked, [40, 41, 43])
    }

    func testStateChangesNotifyTheObserver() async {
        let store = FakeStore()
        let controller = SupportPurchaseController(client: store)
        var notifications = 0
        controller.onChange = { notifications += 1 }
        await controller.loadProducts() // loading, ready
        await controller.purchase(.small) { _ in .userCancelled } // purchasing, cancelled
        XCTAssertEqual(notifications, 4)
    }
}

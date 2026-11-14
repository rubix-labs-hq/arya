import Foundation
import XCTest
@testable import ReelKit

/// Drives every Arya Pro outcome through a fake store. No StoreKit, network or sleeps.
@MainActor
final class ProPurchaseTests: XCTestCase {
    private actor FinishLog {
        private(set) var ids: [UInt64] = []
        func record(_ id: UInt64) { ids.append(id) }
    }

    private final class FakeStore: ProStoreClient {
        var canMakePayments = true
        var requests: [[String]] = []
        var results: [Result<[ProProduct], Error>]
        var access: ProAccess = .free
        var accessReads = 0
        var restoreResult: Result<ProAccess, Error> = .success(.free)
        let updates: AsyncStream<ProTransactionUpdate>
        let feed: AsyncStream<ProTransactionUpdate>.Continuation

        init(_ results: [Result<[ProProduct], Error>] = [.success(ProPurchaseTests.catalog)]) {
            self.results = results
            (updates, feed) = AsyncStream.makeStream(of: ProTransactionUpdate.self)
        }

        func products(for ids: [String]) async throws -> [ProProduct] {
            requests.append(ids)
            return try (results.isEmpty ? .success([]) : results.removeFirst()).get()
        }

        func currentAccess() async -> ProAccess { accessReads += 1; return access }
        func transactionUpdates() -> AsyncStream<ProTransactionUpdate> { updates }
        func restore() async throws { access = try restoreResult.get() }
    }

    private struct Unexpected: Error {}

    // Prices come back localized from the store; the controller must pass them through.
    nonisolated static let catalog = [
        ProProduct(plan: .lifetime, displayName: "Arya Pro Lifetime", displayPrice: "54,99 €"),
        ProProduct(plan: .yearly, displayName: "Arya Pro Yearly", displayPrice: "21,99 €", period: "year", freeTrial: "1 week"),
        ProProduct(plan: .monthly, displayName: "Arya Pro Monthly", displayPrice: "3,49 €", period: "month"),
    ]

    private func transaction(_ id: UInt64, _ plan: ProPlan, revoked: Bool = false, log: FinishLog) -> ProTransaction {
        ProTransaction(id: id, productID: plan.productID, revoked: revoked) { await log.record(id) }
    }

    private func loaded(_ given: FakeStore? = nil) async -> (ProPurchaseController, FakeStore) {
        let store = given ?? FakeStore()
        let controller = ProPurchaseController(client: store)
        await controller.loadProducts()
        return (controller, store)
    }

    // MARK: Products

    func testProductIdentifiersMatchAppStoreConnect() {
        XCTAssertEqual(ProPlan.allCases.map(\.productID), ["app.reel.ios.pro.monthly", "app.reel.ios.pro.yearly", "app.reel.ios.pro.lifetime"])
        for plan in ProPlan.allCases { XCTAssertEqual(ProPlan(productID: plan.productID), plan) }
        XCTAssertNil(ProPlan(productID: "app.reel.ios.support.small"))
        XCTAssertNil(ProPlan(productID: "app.reel.ios.pro.weekly"))
        XCTAssertFalse(ProPlan.lifetime.renews)
    }

    func testLoadKeepsPlanOrderAndStorePrices() async {
        let (controller, store) = await loaded()
        XCTAssertEqual(store.requests, [ProPlan.allCases.map(\.productID)])
        guard case .ready(let products) = controller.catalog else { return XCTFail("catalog not ready") }
        XCTAssertEqual(products.map(\.plan), [.monthly, .yearly, .lifetime])
        XCTAssertEqual(products.map(\.displayPrice), ["3,49 €", "21,99 €", "54,99 €"])
        await controller.loadProducts()
        XCTAssertEqual(store.requests.count, 1, "A loaded catalog is not fetched again")
    }

    func testTermsStateTheFullRenewalPriceAndTrialOnlyWhenEligible() {
        XCTAssertEqual(Self.catalog[2].terms, "3,49 € per month. Renews automatically unless you cancel at least 24 hours before the period ends.")
        XCTAssertEqual(Self.catalog[1].terms, "Free for 1 week, then 21,99 € per year. Renews automatically unless you cancel at least 24 hours before the period ends.")
        XCTAssertEqual(Self.catalog[0].terms, "54,99 €, one payment. Lifetime never renews.")
    }

    func testEmptyOrFailedLoadSaysEditingStaysFreeAndCanRetry() async {
        let (empty, _) = await loaded(FakeStore([.success([])]))
        XCTAssertEqual(empty.catalog, .unavailable(ProMessage.noProducts))
        let store = FakeStore([.failure(Unexpected()), .success(Self.catalog)])
        let (failed, _) = await loaded(store)
        XCTAssertEqual(failed.catalog, .unavailable(ProMessage.loadFailed))
        XCTAssertFalse(failed.canPurchase)
        await failed.loadProducts()
        guard case .ready = failed.catalog else { return XCTFail("retry did not load") }
    }

    // MARK: Purchases

    func testVerifiedPurchaseUnlocksFromTheStoreEntitlementAndFinishesOnce() async {
        let (controller, store) = await loaded(), log = FinishLog()
        var gate: [ProAccess] = []
        controller.onAccessChange = { gate.append($0) }
        let purchase = transaction(7, .yearly, log: log)
        let started = await controller.purchase(.yearly) { id in
            XCTAssertEqual(id, "app.reel.ios.pro.yearly")
            store.access = .subscribed(.yearly)
            return .verified(purchase)
        }
        XCTAssertTrue(started)
        XCTAssertEqual(controller.status, .unlocked)
        XCTAssertEqual(controller.access, .subscribed(.yearly))
        XCTAssertEqual(gate, [.subscribed(.yearly)])
        await controller.handle(.verified(purchase))
        let finished = await log.ids
        XCTAssertEqual(finished, [7], "A transaction seen twice is finished once")
    }

    func testPurchaseThatTheStoreDoesNotEntitleDoesNotUnlock() async {
        let (controller, _) = await loaded(), log = FinishLog()
        await controller.purchase(.monthly) { _ in .verified(self.transaction(8, .monthly, log: log)) }
        XCTAssertEqual(controller.status, .idle)
        XCTAssertFalse(controller.access.isPro)
    }

    func testUnverifiedPendingCancelAndErrorsLeaveProOff() async {
        let (controller, _) = await loaded(), log = FinishLog()
        await controller.purchase(.yearly) { _ in .unverified(self.transaction(9, .yearly, log: log)) }
        XCTAssertEqual(controller.status, .failed(ProMessage.unverified))
        let unfinished = await log.ids
        XCTAssertEqual(unfinished, [], "An unverified purchase is never finished")
        await controller.purchase(.yearly) { _ in .pending }
        XCTAssertEqual(controller.status, .pending(.yearly))
        await controller.purchase(.yearly) { _ in .userCancelled }
        XCTAssertEqual(controller.status, .cancelled)
        await controller.purchase(.yearly) { _ in throw ProStoreError.network }
        XCTAssertEqual(controller.status, .failed(ProMessage.network))
        await controller.purchase(.yearly) { _ in throw CancellationError() }
        XCTAssertEqual(controller.status, .cancelled)
        await controller.purchase(.yearly) { _ in throw Unexpected() }
        XCTAssertEqual(controller.status, .failed(ProMessage.failed))
        XCTAssertFalse(controller.access.isPro)
    }

    func testPurchaseIsRefusedWhenRestrictedUnavailableOrAlreadyRunning() async {
        let store = FakeStore()
        store.canMakePayments = false
        let (restricted, _) = await loaded(store)
        let refused = await restricted.purchase(.yearly) { _ in XCTFail("no sheet"); return .pending }
        XCTAssertFalse(refused)
        XCTAssertEqual(restricted.status, .failed(ProMessage.notAllowed))

        let (controller, _) = await loaded(FakeStore([.success([Self.catalog[2]])]))
        let missing = await controller.purchase(.lifetime) { _ in XCTFail("no sheet"); return .pending }
        XCTAssertFalse(missing)
        XCTAssertEqual(controller.status, .failed(ProMessage.productUnavailable))

        var second: Bool?
        await controller.purchase(.monthly) { _ in
            second = await controller.purchase(.monthly) { _ in XCTFail("second sheet"); return .pending }
            return .userCancelled
        }
        XCTAssertEqual(second, false, "A second tap during a purchase is refused")
    }

    // MARK: Updates, refunds and restore

    func testUpdatesFollowTheStoreSoARefundTurnsProOff() async {
        let (controller, store) = await loaded(), log = FinishLog()
        store.access = .lifetime
        await controller.handle(.verified(transaction(10, .lifetime, log: log)))
        XCTAssertEqual(controller.access, .lifetime)
        XCTAssertEqual(controller.status, .idle, "A background update never shows a purchase message")
        store.access = .free
        await controller.handle(.verified(transaction(10, .lifetime, revoked: true, log: log)))
        XCTAssertEqual(controller.access, .free)
        await controller.handle(.unverified(transaction(11, .lifetime, log: log)))
        let finished = await log.ids
        XCTAssertEqual(finished, [10])
    }

    func testListenerAppliesUpdatesFromTheStream() async {
        let (controller, store) = await loaded(), log = FinishLog()
        let changed = expectation(description: "access changed")
        controller.onAccessChange = { if $0 == .subscribed(.monthly) { changed.fulfill() } }
        controller.startListening()
        store.access = .subscribed(.monthly)
        store.feed.yield(.verified(transaction(12, .monthly, log: log)))
        await fulfillment(of: [changed], timeout: 2)
        controller.stopListening()
    }

    func testRestoreReportsWhatTheStoreFound() async {
        let store = FakeStore()
        let (controller, _) = await loaded(store)
        await controller.restore()
        XCTAssertEqual(controller.status, .nothingToRestore)
        store.restoreResult = .success(.subscribed(.yearly))
        await controller.restore()
        XCTAssertEqual(controller.status, .unlocked)
        XCTAssertEqual(controller.access, .subscribed(.yearly))
        store.restoreResult = .failure(ProStoreError.network)
        await controller.restore()
        XCTAssertEqual(controller.status, .failed(ProMessage.network))
    }

    // MARK: Early supporters

    func testInstallsFromBeforeProKeepPro() {
        // iOS reports the original build number.
        for build in ["1", "3", "5"] { XCTAssertTrue(ProEarlySupporter.qualifies(originalAppVersion: build), build) }
        for build in ["6", "7", "12"] { XCTAssertFalse(ProEarlySupporter.qualifies(originalAppVersion: build), build) }
        // macOS reports the original marketing version.
        for version in ["1.0.5", "1.1.0", "1.1.1", "1.1"] { XCTAssertTrue(ProEarlySupporter.qualifies(originalAppVersion: version), version) }
        for version in ["1.2.0", "1.2", "1.2.1", "2.0"] { XCTAssertFalse(ProEarlySupporter.qualifies(originalAppVersion: version), version) }
        XCTAssertFalse(ProEarlySupporter.qualifies(originalAppVersion: ""))
        XCTAssertFalse(ProEarlySupporter.qualifies(originalAppVersion: "beta"))
    }

    // MARK: Export rule and gate

    func testOnlyExportsAbove1080pProResAndHDRNeedPro() {
        func pro(_ w: Double, _ h: Double, _ preset: String = "h264-high", _ hdr: String? = nil) -> Bool {
            ProExportRule.requiresPro(width: w, height: h, preset: preset, hdr: hdr)
        }
        XCTAssertFalse(pro(1920, 1080)); XCTAssertFalse(pro(1080, 1920)); XCTAssertFalse(pro(1080, 1080))
        XCTAssertFalse(pro(1440, 1080)); XCTAssertFalse(pro(1280, 720)); XCTAssertFalse(pro(1920.4, 1080.2))
        XCTAssertFalse(pro(1920, 1080, "hevc", "sdr")); XCTAssertFalse(pro(3840, 2160, "audio-wav"))
        XCTAssertTrue(pro(3840, 2160)); XCTAssertTrue(pro(2160, 3840)); XCTAssertTrue(pro(2560, 1440))
        XCTAssertTrue(pro(1922, 1080)); XCTAssertTrue(pro(1440, 1440)); XCTAssertTrue(pro(1080, 1922))
        XCTAssertTrue(pro(1280, 720, "prores-422")); XCTAssertTrue(pro(1280, 720, "prores-4444"))
        XCTAssertTrue(pro(1920, 1080, "hevc", "pq")); XCTAssertTrue(pro(1920, 1080, "hevc", "hlg"))
    }

    func testGateEnforcesOnlyWhenTurnedOnAndOpensForPro() {
        let gate = ProExportGate()
        XCTAssertTrue(gate.allows(width: 3840, height: 2160, preset: "prores-4444", hdr: "pq"), "Direct and browser builds never enforce")
        gate.enforce(true)
        XCTAssertFalse(gate.allows(width: 3840, height: 2160, preset: "h264-high", hdr: nil))
        XCTAssertTrue(gate.allows(width: 1920, height: 1080, preset: "h264-high", hdr: nil))
        gate.setUnlocked(true)
        XCTAssertTrue(gate.allows(width: 3840, height: 2160, preset: "prores-4444", hdr: "hlg"))
    }

    /// The Deliver "1080p" choice must never need Pro, and "4K" must fit UHD, on any canvas shape.
    func testFittedSizesStayFreeAt1080pAndFitUHDForEveryAspect() throws {
        let canvases: [(Double, Double)] = [(1920, 1080), (1080, 1920), (1080, 1080), (1080, 1350), (1440, 1080),
                                            (2560, 1080), (1080, 2560), (3840, 2160), (1280, 720), (4096, 2160), (1001, 999), (720, 1280)]
        for (cw, ch) in canvases {
            let free = try XCTUnwrap(ProExportRule.fittedWidth(canvasWidth: cw, canvasHeight: ch, longEdge: 1920, shortEdge: 1080))
            let freeHeight = (Double(free) * ch / cw).rounded()
            XCTAssertEqual(free % 2, 0); XCTAssertEqual(Int(freeHeight) % 2, 0, "\(cw)x\(ch)")
            XCTAssertFalse(ProExportRule.requiresPro(width: Double(free), height: freeHeight, preset: "h264-high", hdr: nil), "\(cw)x\(ch) -> \(free)x\(freeHeight)")
            let uhd = try XCTUnwrap(ProExportRule.fittedWidth(canvasWidth: cw, canvasHeight: ch, longEdge: 3840, shortEdge: 2160))
            let uhdHeight = (Double(uhd) * ch / cw).rounded()
            XCTAssertLessThanOrEqual(max(Double(uhd), uhdHeight), 3840); XCTAssertLessThanOrEqual(min(Double(uhd), uhdHeight), 2160)
            XCTAssertEqual(Int(uhdHeight) % 2, 0, "\(cw)x\(ch)")
        }
        XCTAssertEqual(ProExportRule.fittedWidth(canvasWidth: 1920, canvasHeight: 1080, longEdge: 3840, shortEdge: 2160), 3840)
        XCTAssertEqual(ProExportRule.fittedWidth(canvasWidth: 1080, canvasHeight: 1920, longEdge: 3840, shortEdge: 2160), 2160)
        XCTAssertEqual(ProExportRule.fittedWidth(canvasWidth: 1080, canvasHeight: 1080, longEdge: 1920, shortEdge: 1080), 1080)
        XCTAssertNil(ProExportRule.fittedWidth(canvasWidth: 0, canvasHeight: 1080, longEdge: 1920, shortEdge: 1080))
    }
}

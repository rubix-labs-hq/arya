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

    func testReloadProductsRefreshesEligibilityEvenWhenReady() async {
        let updated = [
            ProProduct(plan: .yearly, displayName: "Arya Pro Yearly", displayPrice: "21,99 €", period: "year", freeTrial: nil),
            ProProduct(plan: .monthly, displayName: "Arya Pro Monthly", displayPrice: "3,49 €", period: "month"),
            ProProduct(plan: .lifetime, displayName: "Arya Pro Lifetime", displayPrice: "54,99 €"),
        ]
        let store = FakeStore([.success(Self.catalog), .success(updated)])
        let (controller, _) = await loaded(store)
        guard case .ready(let first) = controller.catalog else { return XCTFail("catalog not ready") }
        XCTAssertEqual(first.first(where: { $0.plan == .yearly })?.freeTrial, "1 week")
        await controller.reloadProducts()
        XCTAssertEqual(store.requests.count, 2)
        guard case .ready(let refreshed) = controller.catalog else { return XCTFail("reloaded catalog not ready") }
        XCTAssertNil(refreshed.first(where: { $0.plan == .yearly })?.freeTrial)
    }

    func testSavingsPercentAndMonthlyEquivalentFromStorePrices() {
        let usdFormat = Decimal.FormatStyle.Currency(code: "USD", locale: Locale(identifier: "en_US"))
        let monthly = ProProduct(plan: .monthly, displayName: "Monthly", displayPrice: "$2.99", period: "month",
                                 price: Decimal(string: "2.99"), priceFormat: usdFormat, renewalMonths: 1)
        let yearly = ProProduct(plan: .yearly, displayName: "Yearly", displayPrice: "$19.99", period: "year", freeTrial: "1 week",
                                price: Decimal(string: "19.99"), priceFormat: usdFormat, renewalMonths: 12)
        XCTAssertEqual(ProPricing.savingsPercent(monthly: monthly, yearly: yearly), 44)
        XCTAssertEqual(ProPricing.monthlyEquivalent(for: yearly), "$1.67")
        XCTAssertNil(ProPricing.monthlyEquivalent(for: monthly))

        // Zero-decimal currency (JPY) rounds up cleanly without hardcoding decimals.
        let jpyFormat = Decimal.FormatStyle.Currency(code: "JPY", locale: Locale(identifier: "ja_JP"))
        let jpyMonthly = ProProduct(plan: .monthly, displayName: "Monthly", displayPrice: "¥450", period: "month",
                                    price: Decimal(450), priceFormat: jpyFormat, renewalMonths: 1)
        let jpyYearly = ProProduct(plan: .yearly, displayName: "Yearly", displayPrice: "¥3,000", period: "year",
                                   price: Decimal(3000), priceFormat: jpyFormat, renewalMonths: 12)
        XCTAssertEqual(ProPricing.savingsPercent(monthly: jpyMonthly, yearly: jpyYearly), 44)
        XCTAssertEqual(ProPricing.monthlyEquivalent(for: jpyYearly), "¥250")

        // Below 10% threshold, missing plan, or unexpected renewal months return nil.
        let smallSavings = ProProduct(plan: .yearly, displayName: "Yearly", displayPrice: "$34.99", period: "year",
                                      price: Decimal(string: "34.99"), priceFormat: usdFormat, renewalMonths: 12)
        XCTAssertNil(ProPricing.savingsPercent(monthly: monthly, yearly: smallSavings))
        XCTAssertNil(ProPricing.savingsPercent(monthly: nil, yearly: yearly))
        let oddPeriod = ProProduct(plan: .yearly, displayName: "Yearly", displayPrice: "$19.99", period: "year",
                                   price: Decimal(string: "19.99"), priceFormat: usdFormat, renewalMonths: 6)
        XCTAssertNil(ProPricing.savingsPercent(monthly: monthly, yearly: oddPeriod))
    }

    private final class SlowCatalogStore: ProStoreClient {
        var canMakePayments = true
        var catalogWaiters: [CheckedContinuation<[ProProduct], Error>] = []
        var requests = 0
        var maxAllowedRequests = 1
        var access: ProAccess = .free
        func products(for ids: [String]) async throws -> [ProProduct] {
            requests += 1
            guard requests <= maxAllowedRequests else { throw Unexpected() }
            return try await withCheckedThrowingContinuation { catalogWaiters.append($0) }
        }
        func currentAccess() async -> ProAccess { access }
        func transactionUpdates() -> AsyncStream<ProTransactionUpdate> { AsyncStream { _ in } }
        func restore() async throws {}
    }

    /// Cold-launch promoted purchase intents can call `loadProducts()` concurrently while the
    /// paywall's own load is already in flight, and overlapping `reloadProducts()` invalidations
    /// must coalesce into a single follow-up fetch publishing only the latest generation.
    func testConcurrentLoadWaitsForInFlightCatalogAndDirectPurchaseBypassesCatalog() async {
        let store = SlowCatalogStore()
        store.maxAllowedRequests = 2
        let controller = ProPurchaseController(client: store)
        var publishedReadyCounts: [Int] = []
        controller.onChange = {
            if case .ready(let products) = controller.catalog {
                publishedReadyCounts.append(products.count)
            }
        }
        let first = Task { await controller.loadProducts() }
        for _ in 0..<100 where store.catalogWaiters.isEmpty { await Task.yield() }
        XCTAssertEqual(store.catalogWaiters.count, 1)
        var secondStarted = false
        var secondFinished = false
        let second = Task { secondStarted = true; await controller.loadProducts(); secondFinished = true }
        for _ in 0..<100 where !secondStarted { await Task.yield() }
        await Task.yield()
        XCTAssertTrue(secondStarted)
        XCTAssertFalse(secondFinished, "Second caller must wait while first load is in flight")
        // Trigger two overlapping reloads while the first fetch is still pending; they must coalesce into one follow-up fetch.
        var reloadAEntered = false
        var reloadBEntered = false
        let reloadA = Task { reloadAEntered = true; await controller.reloadProducts() }
        let reloadB = Task { reloadBEntered = true; await controller.reloadProducts() }
        for _ in 0..<100 where !(reloadAEntered && reloadBEntered) { await Task.yield() }
        await Task.yield()
        XCTAssertTrue(reloadAEntered && reloadBEntered)
        // Stale first response must never be published because reloads invalidated it.
        store.catalogWaiters[0].resume(returning: [Self.catalog[2]])
        for _ in 0..<100 where store.catalogWaiters.count < 2 { await Task.yield() }
        XCTAssertEqual(store.catalogWaiters.count, 2, "Coalesced reload must start one follow-up fetch")
        XCTAssertEqual(publishedReadyCounts, [], "Stale first catalog must never be published")
        store.catalogWaiters[1].resume(returning: Self.catalog)
        await first.value
        await second.value
        await reloadA.value
        await reloadB.value
        XCTAssertTrue(secondFinished)
        XCTAssertEqual(store.requests, 2, "Concurrent loads and overlapping reloads coalesce into at most one follow-up fetch")
        XCTAssertEqual(publishedReadyCounts, [3], "Only the latest reload catalog is published")
        if case .ready(let products) = controller.catalog {
            XCTAssertEqual(products.count, 3)
        } else {
            XCTFail("Catalog should hold the latest reload result")
        }

        // Promoted purchase with StoreKit's Product can purchase through the verified flow even
        // before catalog loads, and an Ask-to-Buy pending approval resolves to unlocked even after
        // another paywall calls clearStatus().
        let freshStore = FakeStore([.success([])])
        let directController = ProPurchaseController(client: freshStore)
        let log = FinishLog()
        let started = await directController.purchase(.yearly, requireCatalog: false) { _ in .pending }
        XCTAssertTrue(started)
        XCTAssertEqual(directController.status, .pending(.yearly))
        directController.clearStatus()
        XCTAssertEqual(directController.status, .idle)
        freshStore.access = .subscribed(.yearly)
        await directController.handle(.verified(transaction(99, .yearly, log: log)))
        XCTAssertEqual(directController.status, .unlocked)
        let finished = await log.ids
        XCTAssertEqual(finished, [99])
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

    /// A launch can open the gate from the last stored answer. The first refresh must close it
    /// again even though the controller's own access never changed from free.
    func testEveryRefreshReportsAccessSoAStaleUnlockCloses() async {
        let store = FakeStore(), controller = ProPurchaseController(client: store)
        var gate: [ProAccess] = []
        controller.onAccessChange = { gate.append($0) }
        await controller.refreshAccess()
        await controller.refreshAccess()
        XCTAssertEqual(gate, [.free, .free])
    }

    /// Reads access in the order they are answered, not the order they were asked.
    private final class SlowReadStore: ProStoreClient {
        var canMakePayments = true
        var answers: [CheckedContinuation<ProAccess, Never>] = []
        func products(for ids: [String]) async throws -> [ProProduct] { ProPurchaseTests.catalog }
        func currentAccess() async -> ProAccess { await withCheckedContinuation { answers.append($0) } }
        func transactionUpdates() -> AsyncStream<ProTransactionUpdate> { AsyncStream { _ in } }
        func restore() async throws {}
    }

    func testAnOlderRefreshThatFinishesLateDoesNotRelockPro() async {
        let store = SlowReadStore(), controller = ProPurchaseController(client: store)
        var gate: [ProAccess] = []
        controller.onAccessChange = { gate.append($0) }
        // The foreground refresh starts first, then the purchase's refresh.
        let foreground = Task { await controller.refreshAccess() }
        while store.answers.count < 1 { await Task.yield() }
        let purchase = Task { await controller.refreshAccess() }
        while store.answers.count < 2 { await Task.yield() }
        // The purchase's read answers first with Pro; the stale foreground read answers last with free.
        store.answers[1].resume(returning: .subscribed(.yearly))
        await purchase.value
        store.answers[0].resume(returning: .free)
        await foreground.value
        XCTAssertEqual(controller.access, .subscribed(.yearly), "A stale read must not relock Pro")
        XCTAssertEqual(gate, [.subscribed(.yearly)])
    }

    /// Restore and purchase read `access` after their refresh, so a superseded refresh must not
    /// return until the newest read has landed.
    func testASupersededRefreshWaitsForTheNewestRead() async {
        let store = SlowReadStore(), controller = ProPurchaseController(client: store)
        var olderReturned = false
        let older = Task { await controller.refreshAccess(); olderReturned = true }
        while store.answers.count < 1 { await Task.yield() }
        let newer = Task { await controller.refreshAccess() }
        while store.answers.count < 2 { await Task.yield() }
        store.answers[0].resume(returning: .free)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertFalse(olderReturned, "The superseded refresh returned before the newest read")
        store.answers[1].resume(returning: .lifetime)
        await newer.value
        await older.value
        XCTAssertTrue(olderReturned)
        XCTAssertEqual(controller.access, .lifetime)
    }

    func testRequestedHDRMatchesTheRenderer() {
        XCTAssertEqual(ProExportRule.requestedHDR(["hdr": true]), "pq")
        XCTAssertEqual(ProExportRule.requestedHDR(["hdr": true, "transfer": "hlg"]), "hlg")
        XCTAssertEqual(ProExportRule.requestedHDR(["hdr": NSNumber(value: 1)]), "pq")
        XCTAssertEqual(ProExportRule.requestedHDR(["hdr": "hlg"]), "hlg")
        XCTAssertNil(ProExportRule.requestedHDR(["hdr": false]))
        XCTAssertNil(ProExportRule.requestedHDR(["hdr": "sdr"]))
        XCTAssertNil(ProExportRule.requestedHDR([:]))
    }

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
    /// Composition sizes are unbounded in the project, so stillWidth must not trap or spin on a free
    /// App Store build. Out-of-range sizes come back unchanged for /api/frame admission to refuse.
    func testStillWidthStaysFastAndSafeOnUnboundedCanvases() {
        let gate = ProExportGate()
        gate.enforce(true)
        let started = Date()
        XCTAssertEqual(gate.stillWidth(requested: 16, canvasWidth: 16, canvasHeight: 1e18), 16, "A tall canvas past admission goes back unchanged")
        XCTAssertEqual(gate.stillWidth(requested: 1920, canvasWidth: 16, canvasHeight: 1e18), 1920)
        let wide = gate.stillWidth(requested: 1_000_000, canvasWidth: 1e9, canvasHeight: 16)
        XCTAssertTrue(wide <= ProExportRule.maximumFreeLongEdge && gate.allows(width: Double(wide), height: Double(wide) * 16 / 1e9, preset: "png", hdr: nil))
        XCTAssertEqual(gate.stillWidth(requested: 1920, canvasWidth: .infinity, canvasHeight: 16), 1920)
        XCTAssertEqual(gate.stillWidth(requested: 1920, canvasWidth: 16, canvasHeight: .nan), 1920)
        XCTAssertNil(ProExportRule.fittedWidth(canvasWidth: 1e-306, canvasHeight: 3e-306, longEdge: 1920, shortEdge: 1080), "A tiny canvas has no finite fit")
        for huge in [1e306, 1e308] {
            let fit = ProExportRule.fittedWidth(canvasWidth: huge, canvasHeight: huge, longEdge: 1920, shortEdge: 1080)
            XCTAssertTrue(fit.map { $0 <= 1080 && !ProExportRule.requiresPro(width: Double($0), height: Double($0), preset: "h264-high", hdr: nil) } ?? true, "\(huge) square -> \(String(describing: fit))")
        }
        let tiny = gate.stillWidth(requested: 960, canvasWidth: 1e-306, canvasHeight: 3e-306)
        XCTAssertTrue(tiny > 1 && gate.allows(width: Double(tiny), height: Double(tiny) * 3e-306 / 1e-306, preset: "png", hdr: nil), "tiny canvas -> \(tiny)")
        XCTAssertLessThan(Date().timeIntervalSince(started), 1, "stillWidth spun on a huge canvas")
        XCTAssertEqual(gate.stillWidth(requested: 1080, canvasWidth: 1080, canvasHeight: 3840), 540, "A normal tall canvas still fits")
    }

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

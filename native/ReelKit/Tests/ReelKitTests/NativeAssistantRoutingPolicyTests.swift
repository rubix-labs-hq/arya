import Foundation
import XCTest
@testable import ReelKit

final class NativeAssistantRoutingPolicyTests: XCTestCase {
    private let now = 1_000_000.0
    private var providers: [[String: Any]] {
        ["claude-code", "codex"].map { ["id": $0, "installed": true, "authenticated": true, "available": true, "adapterSupported": true, "modelSelectionSupported": true, "billingMode": "subscription"] }
    }
    private func model(_ id: String = "exact-model", provider: String = "codex", fields: [String: Any] = [:]) -> [String: Any] {
        ["id": id, "provider": provider, "available": true, "listed": true, "hidden": false,
         "isDefault": true, "inputModalities": ["text", "image"], "reasoningEfforts": ["low", "high"]]
            .merging(fields) { _, replacement in replacement }
    }
    private func catalog(_ models: [[String: Any]], provider: String = "codex", fields: [String: Any] = [:]) -> [String: Any] {
        ["provider": provider, "source": ["kind": "provider-cli"], "complete": true, "checkedAt": now, "models": models].merging(fields) { _, replacement in replacement }
    }
    private func available(_ models: [[String: Any]], fields: [String: Any] = [:]) -> [[String: Any]] {
        NativeAssistantRoutingPolicy.availableModels(providers: providers, catalogs: [catalog(models, provider: models.first?["provider"] as? String ?? "codex", fields: fields)], verified: true, now: now)
    }
    private func readiness(model id: String = "exact-model", effort: String = "", bound: Bool = true, options: [[String: Any]]) -> String? {
        NativeAssistantRoutingPolicy.manualReadinessReason(provider: "codex", model: id, effort: effort, catalogBound: bound, availableModels: options)
    }

    func testVerifiedFreshAccountRetainsExactModels() {
        let options = available([model("one"), model("two")])
        XCTAssertEqual(options.compactMap { $0["id"] as? String }, ["one", "two"])
        XCTAssertTrue(NativeAssistantRoutingPolicy.availableModels(providers: providers, catalogs: [catalog([model()])], verified: false, now: now).isEmpty)
    }

    func testExpiredIncompleteAndFutureCatalogsAreNotReady() {
        let rejected: [[String: Any]] = [["checkedAt": now - 300_001], ["checkedAt": now + 1], ["checkedAt": -1.0], ["checkedAt": now - 0.5], ["checkedAt": Double.nan], ["checkedAt": Double.infinity], ["complete": false]]
        for fields in rejected {
            XCTAssertTrue(available([model()], fields: fields).isEmpty)
        }
    }

    func testHiddenUnavailableUnlistedAndRetiredModelsAreNotReady() {
        let models = [model("live"), model("hidden", fields: ["hidden": true]), model("unavailable", fields: ["available": false]),
                      model("unlisted", fields: ["listed": false]), model("retired", fields: ["retirementAt": now]),
                      model("upcoming", fields: ["retirementAt": now + 1])]
        XCTAssertEqual(available(models).compactMap { $0["id"] as? String }, ["live", "upcoming"])
    }

    func testUnavailableAccountCannotContributeCatalogModels() {
        let unavailable: [[String: Any]] = [["id": "codex", "installed": true, "authenticated": true, "available": false, "adapterSupported": true, "modelSelectionSupported": true, "billingMode": "subscription"]]
        XCTAssertTrue(NativeAssistantRoutingPolicy.availableModels(providers: unavailable, catalogs: [catalog([model()])], verified: true, now: now).isEmpty)
    }

    func testAdapterManagedCustomCatalogDoesNotEnterAutoOrAuthorizeManualSharing() {
        let custom: [[String: Any]] = [["id": "custom", "adapterManaged": true, "available": true, "adapterSupported": true, "modelSelectionSupported": true]]
        let options = NativeAssistantRoutingPolicy.availableModels(providers: custom, catalogs: [catalog([model(provider: "custom")], provider: "custom")], verified: true, now: now)
        XCTAssertTrue(options.isEmpty)
        XCTAssertTrue(NativeAssistantRoutingPolicy.eligibleAutoModels(options, agent: "").isEmpty)
        XCTAssertNotNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: "custom", model: "exact-model", effort: "", catalogBound: false, availableModels: options))
    }

    func testLegacyRawIDAndClaudeProviderDefaultDoNotRequireDiscoveryWithoutEffort() {
        XCTAssertNil(readiness(model: "deliberate-advanced-ID", bound: false, options: []))
        XCTAssertNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: "claude-code", model: "", effort: "", catalogBound: false, availableModels: []))
        XCTAssertNil(readiness(options: available([model()])))
    }

    func testCodexManualRequiresAnExplicitModelEvenWhenCatalogAdvertisesDefault() {
        for options in [[], available([model()])] {
            for bound in [false, true] {
                for effort in ["", "high"] {
                    let reason = readiness(model: "", effort: effort, bound: bound, options: options)
                    XCTAssertNotNil(reason)
                    XCTAssertTrue(reason?.contains("Choose an exact Codex model") == true)
                }
            }
        }
        XCTAssertNil(readiness(model: "deliberate-advanced-ID", bound: false, options: []))
        XCTAssertNil(readiness(options: available([model()])))
    }

    func testUnsupportedManualRecipientsStaySavedButCannotReportReady() {
        for provider in ["custom", "gemini-cli", "unknown"] {
            for id in ["", "exact-model"] {
                for bound in [false, true] {
                    for effort in ["", "high"] {
                        let options = [model(provider: provider)]
                        let reason = NativeAssistantRoutingPolicy.manualReadinessReason(provider: provider, model: id, effort: effort, catalogBound: bound, availableModels: options)
                        XCTAssertTrue(reason?.contains("Native AI sharing does not support this recipient") == true)
                    }
                }
            }
        }
        XCTAssertNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: "anthropic", model: "deliberate-API-model", effort: "", catalogBound: false, availableModels: []))
        XCTAssertNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: "claude-code", model: "", effort: "", catalogBound: false, availableModels: []))
    }

    func testBoundMissingRetiredAndExpiredModelsBlockReadyBeforeSend() {
        XCTAssertNotNil(readiness(options: []))
        XCTAssertNotNil(readiness(options: available([model(fields: ["retirementAt": now])])))
        XCTAssertNotNil(readiness(options: available([model()], fields: ["checkedAt": now - 300_001])))
        XCTAssertNotNil(readiness(options: available([model("different-exact-model")])))
    }

    func testWithdrawnEffortBlocksReadyEvenWhenExactModelRemainsAvailable() {
        let options = available([model(fields: ["reasoningEfforts": ["low"]])])
        XCTAssertNotNil(readiness(effort: "high", options: options))
        XCTAssertNil(readiness(effort: "low", options: options))
        XCTAssertNil(readiness(effort: "", options: options))
    }

    func testEffortOnRawIDStillRequiresItsFreshExactCatalogEntry() {
        XCTAssertNotNil(readiness(effort: "high", bound: false, options: []))
        XCTAssertNil(readiness(effort: "high", bound: false, options: available([model()])))
    }

    func testProviderDefaultEffortUsesOnlyTheCurrentDefaultModel() {
        let options = available([model(provider: "claude-code")])
        XCTAssertNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: "claude-code", model: "", effort: "high", catalogBound: false, availableModels: options))
        let noDefault = available([model(provider: "claude-code", fields: ["isDefault": false])])
        XCTAssertNotNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: "claude-code", model: "", effort: "high", catalogBound: false, availableModels: noDefault))
    }

    func testAutoRequiresImageCapabilityAndExcludesAdditionalCredits() {
        let models = [model("codex-image"), model("claude-image", provider: "claude-code"), model("text-only", fields: ["inputModalities": ["text"]]),
                      model("unknown-image", fields: ["inputModalities": []]), model("extra-credit", fields: ["additionalSpend": true])]
        XCTAssertEqual(NativeAssistantRoutingPolicy.eligibleAutoModels(models, agent: "").compactMap { $0["id"] as? String }, ["codex-image", "claude-image"])
        XCTAssertEqual(NativeAssistantRoutingPolicy.eligibleAutoModels(models, agent: "named-agent").compactMap { $0["id"] as? String }, ["claude-image"])
    }

    func testSavedPoolSurvivesNamedAgentFilteringAndUnavailableModels() {
        let saved: Set<String> = ["claude-code:claude-image", "codex:temporarily-unavailable:exact", "codex:codex-image"]
        let models = [model("claude-image", provider: "claude-code"), model("codex-image")]
        let active = NativeAssistantRoutingPolicy.eligibleAutoModels(models, agent: "named-agent")
        XCTAssertEqual(active.count, 1)
        let refs = NativeAssistantRoutingPolicy.savedModelReferences(keys: saved, defaultModels: active)
        XCTAssertEqual(refs, [.init(provider: "claude-code", model: "claude-image"), .init(provider: "codex", model: "codex-image"), .init(provider: "codex", model: "temporarily-unavailable:exact")])
        XCTAssertEqual(NativeAssistantRoutingPolicy.savedModelReferences(keys: saved, defaultModels: []), refs)
    }

    func testExplicitEmptyPoolStaysEmptyAndUnsetPoolUsesCurrentDefaults() {
        let options = [model()]
        XCTAssertTrue(NativeAssistantRoutingPolicy.savedModelReferences(keys: [], defaultModels: options).isEmpty)
        XCTAssertEqual(NativeAssistantRoutingPolicy.savedModelReferences(keys: nil, defaultModels: options), [.init(provider: "codex", model: "exact-model")])
        XCTAssertTrue(NativeAssistantRoutingPolicy.savedModelReferences(keys: ["invalid", "codex:", "custom:model"], defaultModels: options).isEmpty)
    }

    func testFreshnessBoundaryAndProviderSDKCatalogRemainAvailable() {
        XCTAssertEqual(available([model()], fields: ["checkedAt": now - 300_000]).count, 1)
        XCTAssertEqual(available([model()], fields: ["source": ["kind": "provider-sdk"]]).count, 1)
        for value in [Double.nan, Double.infinity, -1.0] {
            XCTAssertTrue(NativeAssistantRoutingPolicy.availableModels(providers: providers, catalogs: [catalog([model()])], verified: true, now: value).isEmpty)
        }
    }

    func testCatalogNeedsEveryPositiveSubscriptionProviderFact() {
        let current = providers.first { $0["id"] as? String == "codex" }!
        for key in ["installed", "authenticated", "available", "adapterSupported", "modelSelectionSupported"] {
            for value in [false, true] {
                var row = current
                if value { row.removeValue(forKey: key) } else { row[key] = false }
                XCTAssertTrue(NativeAssistantRoutingPolicy.availableModels(providers: [row], catalogs: [catalog([model()])], verified: true, now: now).isEmpty, key)
            }
        }
        let blockedAccounts: [[String: Any]] = [["billingMode": "api-key"], ["billingMode": "unknown"], ["rateLimited": true]]
        for fields in blockedAccounts {
            let row = current.merging(fields) { _, value in value }
            XCTAssertTrue(NativeAssistantRoutingPolicy.availableModels(providers: [row], catalogs: [catalog([model()])], verified: true, now: now).isEmpty)
        }
        var missingBilling = current
        missingBilling.removeValue(forKey: "billingMode")
        XCTAssertTrue(NativeAssistantRoutingPolicy.availableModels(providers: [missingBilling], catalogs: [catalog([model()])], verified: true, now: now).isEmpty)
    }

    func testUnverifiedSourcesAndMismatchedCatalogProvidersAreRejected() {
        let invalidCatalogs: [[String: Any]] = [["source": ["kind": "user-setting"]], ["source": [:]], ["provider": "claude-code"], ["provider": "unknown"]]
        for fields in invalidCatalogs {
            XCTAssertTrue(available([model()], fields: fields).isEmpty)
        }
        var missingSource = catalog([model()])
        missingSource.removeValue(forKey: "source")
        XCTAssertTrue(NativeAssistantRoutingPolicy.availableModels(providers: providers, catalogs: [missingSource], verified: true, now: now).isEmpty)
        XCTAssertTrue(available(Array(repeating: model(), count: 257)).isEmpty)
    }

    func testCatalogIDsAreExactListedAndDeduplicated() {
        let invalid = ["", "contains space", "newline\n", "-option", String(repeating: "a", count: 129)]
        let models = [model("exact:v1/variant[image]"), model("duplicate"), model("duplicate"), model("mismatch", provider: "claude-code")]
            + invalid.map { model($0) }
        XCTAssertEqual(available(models).compactMap { $0["id"] as? String }, ["exact:v1/variant[image]", "duplicate"])
        var unlisted = model()
        unlisted.removeValue(forKey: "listed")
        XCTAssertTrue(available([unlisted]).isEmpty)
        let duplicate = available([model("same", fields: ["available": false]), model("same")])
        XCTAssertTrue(duplicate.isEmpty)
    }

    func testFirstCatalogWinsWithoutRevivingItsUnavailableEntries() {
        let stale = catalog([model("stale")], fields: ["checkedAt": now - 300_001])
        let fresh = catalog([model("fresh")])
        let rejected = NativeAssistantRoutingPolicy.availableModels(providers: providers, catalogs: [stale, fresh], verified: true, now: now)
        XCTAssertTrue(rejected.isEmpty)
        let options = NativeAssistantRoutingPolicy.availableModels(providers: providers, catalogs: [fresh, stale], verified: true, now: now)
        XCTAssertEqual(options.compactMap { $0["id"] as? String }, ["fresh"])
    }

    func testGoogleCustomAndAPIModelsCannotEnterSubscriptionAuto() {
        for provider in ["gemini-cli", "custom", "anthropic", "unknown"] {
            let row: [String: Any] = ["id": provider, "installed": true, "authenticated": true, "available": true,
                                      "adapterSupported": true, "modelSelectionSupported": true, "billingMode": "subscription"]
            let models = [model(provider: provider)]
            XCTAssertTrue(NativeAssistantRoutingPolicy.availableModels(providers: [row], catalogs: [catalog(models, provider: provider)], verified: true, now: now).isEmpty)
            XCTAssertTrue(NativeAssistantRoutingPolicy.eligibleAutoModels(models, agent: "").isEmpty)
        }
    }

    func testAntigravityIsManualOnlyWithItsAuthenticatedCLICatalog() {
        let provider = "antigravity"
        let account: [[String: Any]] = [["id": provider, "installed": true, "authenticated": true, "available": true, "adapterSupported": true, "modelSelectionSupported": true, "billingMode": "subscription"]]
        let models = NativeAssistantRoutingPolicy.availableModels(providers: account, catalogs: [catalog([model("exact-google-model", provider: provider, fields: ["inputModalities": ["text"]])], provider: provider)], verified: true, now: now)
        XCTAssertEqual(models.compactMap { $0["id"] as? String }, ["exact-google-model"])
        XCTAssertTrue(NativeAssistantRoutingPolicy.eligibleAutoModels(models, agent: "").isEmpty)
        XCTAssertNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: provider, model: "exact-google-model", effort: "", catalogBound: true, availableModels: models))
        XCTAssertNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: provider, model: "", effort: "", catalogBound: false, availableModels: []))
        XCTAssertNotNil(NativeAssistantRoutingPolicy.manualReadinessReason(provider: "gemini-cli", model: "old-model", effort: "", catalogBound: false, availableModels: []))
    }

    func testNativePriorityChoicesUseTheHostProtocolValues() {
        XCTAssertEqual(NativeAssistantRoutingPolicy.priorities, ["balanced", "quick", "quality"])
        XCTAssertEqual(NativeAssistantRoutingPolicy.priorities.map { NativeAssistantRoutingPolicy.priorityLabel($0) }, ["Balanced", "Speed", "Quality"])
    }

    func testOnlyManualAnthropicUsesTheAPIPromptLimit() {
        XCTAssertEqual(NativeAssistantRoutingPolicy.inputCharacterLimit(provider: "anthropic", mode: "manual"), 32_000)
        XCTAssertEqual(NativeAssistantRoutingPolicy.inputCharacterLimit(provider: "anthropic", mode: "auto"), 128_000)
        for provider in ["claude-code", "codex", "custom"] {
            XCTAssertEqual(NativeAssistantRoutingPolicy.inputCharacterLimit(provider: provider, mode: "manual"), 128_000)
            XCTAssertEqual(NativeAssistantRoutingPolicy.inputCharacterLimit(provider: provider, mode: "auto"), 128_000)
        }
    }
}

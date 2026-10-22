import Foundation

/// Shared account policy without UI or credential access. Saved choices and current
/// dispatch eligibility are separate: a temporary account failure cannot erase a pool.
public enum NativeAssistantRoutingPolicy {
    public static let priorities = ["balanced", "quick", "quality"]
    public static func priorityLabel(_ value: String) -> String {
        value == "quick" ? "Speed" : value == "quality" ? "Quality" : "Balanced"
    }

    private static func validModelID(_ value: String) -> Bool {
        value.range(of: "^[a-zA-Z0-9][a-zA-Z0-9._:/@+\\[\\]-]{0,127}$", options: .regularExpression) == (value.startIndex..<value.endIndex)
    }

    public struct ModelReference: Equatable, Sendable {
        public let provider: String
        public let model: String
        public init(provider: String, model: String) { self.provider = provider; self.model = model }
    }

    public static func availableModels(providers: [[String: Any]], catalogs: [[String: Any]], verified: Bool,
                                       now: Double = Date().timeIntervalSince1970 * 1000) -> [[String: Any]] {
        guard verified, now.isFinite, now >= 0 else { return [] }
        var seenProviders = Set<String>()
        return catalogs.flatMap { catalog in
            // Google Gemini (beta) is Manual-only. Its fixed list comes from the CLI docs.
            guard let provider = catalog["provider"] as? String, ["claude-code", "codex", "gemini-cli"].contains(provider),
                  seenProviders.insert(provider).inserted,
                  catalog["complete"] as? Bool == true,
                  let source = catalog["source"] as? [String: Any],
                  (provider == "gemini-cli" ? ["provider-docs"] : ["provider-cli", "provider-sdk"]).contains(source["kind"] as? String ?? ""),
                  let checkedAt = catalog["checkedAt"] as? Double, checkedAt.isFinite,
                  checkedAt >= 0, checkedAt <= 9_007_199_254_740_991, checkedAt.rounded(.towardZero) == checkedAt,
                  checkedAt <= now, now - checkedAt <= 300_000,
                  let row = providers.first(where: { $0["id"] as? String == provider }),
                  row["installed"] as? Bool == true, row["authenticated"] as? Bool == true,
                  row["available"] as? Bool == true, row["adapterSupported"] as? Bool == true,
                  row["modelSelectionSupported"] as? Bool == true, row["rateLimited"] as? Bool != true,
                  row["billingMode"] as? String == "subscription",
                  let models = catalog["models"] as? [[String: Any]], models.count <= 256 else { return [[String: Any]]() }
            var seenModels = Set<String>()
            return models.filter { item in
                guard item["provider"] as? String == provider, let id = item["id"] as? String,
                      validModelID(id), seenModels.insert(id).inserted else { return false }
                return item["available"] as? Bool == true && item["hidden"] as? Bool != true
                    && item["listed"] as? Bool == true
                    && (item["retirementAt"] as? Double).map { $0 > now } != false
            }
        }
    }

    public static func eligibleAutoModels(_ models: [[String: Any]], agent: String) -> [[String: Any]] {
        models.filter { item in
            let provider = item["provider"] as? String ?? ""
            return ["claude-code", "codex"].contains(provider) && validModelID(item["id"] as? String ?? "")
                && item["additionalSpend"] as? Bool != true
                && (item["inputModalities"] as? [String] ?? []).contains("image")
                && (agent.isEmpty || provider == "claude-code")
        }
    }

    public static func savedModelReferences(keys: Set<String>?, defaultModels: [[String: Any]]) -> [ModelReference] {
        if let keys {
            return keys.sorted().compactMap { key in
                guard let separator = key.firstIndex(of: ":") else { return nil }
                let provider = String(key[..<separator]), model = String(key[key.index(after: separator)...])
                guard ["claude-code", "codex"].contains(provider), !model.isEmpty else { return nil }
                return ModelReference(provider: provider, model: model)
            }
        }
        return defaultModels.compactMap { item in
            guard let provider = item["provider"] as? String, let model = item["id"] as? String,
                  ["claude-code", "codex"].contains(provider), !model.isEmpty else { return nil }
            return ModelReference(provider: provider, model: model)
        }
    }

    public static func manualReadinessReason(provider: String, model: String, effort: String, catalogBound: Bool,
                                             availableModels: [[String: Any]]) -> String? {
        guard ["claude-code", "codex", "gemini-cli", "anthropic"].contains(provider) else {
            return "Native AI sharing does not support this recipient. Choose a supported provider in Assistant settings."
        }
        if provider == "codex" && model.isEmpty {
            return "Choose an exact Codex model in Assistant settings. Refresh account discovery if no model is listed."
        }
        // Deliberate raw IDs and the Claude and Gemini provider-default Manual choices do not require discovery.
        guard catalogBound || !effort.isEmpty else { return nil }
        guard let selected = availableModels.first(where: {
            $0["provider"] as? String == provider && (model.isEmpty ? $0["isDefault"] as? Bool == true : $0["id"] as? String == model)
        }) else { return "The selected model needs a fresh account check. Retry discovery or choose an available model." }
        guard effort.isEmpty || (selected["reasoningEfforts"] as? [String] ?? []).contains(effort) else {
            return "The selected reasoning effort is no longer available. Refresh models and choose an advertised effort or the provider default."
        }
        return nil
    }

    public static func inputCharacterLimit(provider: String, mode: String) -> Int {
        provider == "anthropic" && mode == "manual" ? 32_000 : 128_000
    }
}

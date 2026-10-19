import Foundation
import JavaScriptCore

/// The shared project core (editor/core/project.js and expr.js) running in JavaScriptCore.
/// `native/scripts/bundle-core.mjs` turns the ES modules into the one script this loads, so
/// every backend applies ops with the same code. Project and ops cross as JSON text.
///
/// Not thread-safe: use one instance from one isolation domain (ReelBackend's actor).
public final class ReelCore {
    public struct ScriptError: Error, LocalizedError {
        public let message: String
        public var errorDescription: String? { message }
    }

    /// The result of applying ops: the new project (JSON text) and the core's log and created ids.
    public struct OpsResult {
        public let project: String
        public let log: String
        public let created: String
    }

    private let context: JSContext
    private let bridge: JSValue

    /// Loads the bundled core script (reel-core.js).
    public convenience init(scriptURL: URL) throws {
        try self.init(source: String(contentsOf: scriptURL, encoding: .utf8), sourceURL: scriptURL)
    }

    public init(source: String, sourceURL: URL? = nil) throws {
        guard let context = JSContext() else { throw ScriptError(message: "JavaScriptCore is unavailable") }
        context.name = "ReelCore"
        context.evaluateScript(source, withSourceURL: sourceURL)
        if let exception = context.exception {
            throw ScriptError(message: "the core script failed to load: \(exception)")
        }
        guard let bridge = context.objectForKeyedSubscript("ReelCore")?.objectForKeyedSubscript("bridge"), bridge.isObject else {
            throw ScriptError(message: "the core script does not define ReelCore.bridge")
        }
        self.context = context
        self.bridge = bridge
    }

    private func call(_ name: String, _ args: [Any]) throws -> JSValue {
        context.exception = nil
        guard let result = bridge.invokeMethod(name, withArguments: args) else {
            throw ScriptError(message: "ReelCore.\(name) returned nothing")
        }
        if let exception = context.exception {
            context.exception = nil
            let message = exception.objectForKeyedSubscript("message")?.toString() ?? exception.toString() ?? "error"
            throw ScriptError(message: message)
        }
        return result
    }

    private func string(_ name: String, _ args: [Any]) throws -> String {
        try call(name, args).toString()
    }

    /// Parses a project file's text and migrates it to the current format.
    public func migrate(fileText: String) throws -> String { try string("migrateJSON", [fileText]) }

    public func validateRecoveryProject(_ text: String) throws { _ = try string("validateRecoveryProject", [text]) }

    public func applyOps(project: String, ops: String) throws -> OpsResult {
        let parts = try call("applyOpsParts", [project, ops]).toArray() as? [String] ?? []
        guard parts.count == 3 else { throw ScriptError(message: "applyOps returned an unexpected shape") }
        return OpsResult(project: parts[0], log: parts[1], created: parts[2])
    }

    /// The exact JSON text the ES modules would produce (used by the parity tests).
    public func applyOpsJSON(project: String, ops: String) throws -> String { try string("applyOpsJSON", [project, ops]) }

    public func newProject(name: String, options: String = "{}") throws -> String { try string("newProjectJSON", [name, options]) }
    public func outline(project: String) throws -> String { try string("outline", [project]) }
    public func duration(project: String) throws -> Double { try call("duration", [project]).toDouble() }
    public func opsDoc() throws -> String { try string("opsDocJSON", []) }
    /// The assistant's plain description of the open timeline, selection and playhead (editor/core/describe.js).
    public func describeFocus(project: String, options: String) throws -> String { try string("describeFocus", [project, options]) }
    /// Named clips in detail, or the layers at a time, for GET /api/describe.
    public func describeRequest(project: String, options: String) throws -> String { try string("describeRequest", [project, options]) }
    /// Suggested assistant requests for the selection or timeline, as JSON (editor/core/assistant-suggestions.js).
    public func assistantSuggestions(project: String, options: String) throws -> String { try string("assistantSuggestions", [project, options]) }
    /// What a preview step produces and where it lands, or {error}, as JSON (editor/core/assistant-steps.js).
    public func describeStep(project: String, step: String) throws -> String { try string("describeStep", [project, step]) }
    /// The file text the Node server writes for this project (two-space JSON, trailing newline).
    public func fileText(project: String) throws -> String { try string("fileText", [project]) }
    public func field(_ json: String, _ key: String) throws -> String { try string("field", [json, key]) }
    public func unknownSources(project: String, ops: String) throws -> [String] {
        (try JSON.parse(string("unknownSources", [project, ops])) as? [String]) ?? []
    }
    public func portableLibraryPlan(item: String, resources: String) throws -> String { try string("portableLibraryPlan", [item, resources]) }
    public func remapPortableLibraryItem(item: String, paths: String) throws -> String { try string("remapPortableLibraryItem", [item, paths]) }
    public func libraryLUTDependencies(project: String, operation: String) throws -> String { try string("libraryLUTDependencies", [project, operation]) }
    public func prependImport(ops: String, assets: String) throws -> String { try string("prependImport", [ops, assets]) }
    public func forget(project: String, paths: String) throws -> String { try string("forget", [project, paths]) }
    /// One asset record as JSON text, or nil when the project has no such asset.
    public func asset(project: String, src: String) throws -> String? {
        let text = try string("asset", [project, src])
        return text == "null" ? nil : text
    }
    public func mediaRestoreSource(project: String, src: String) throws -> String { try string("mediaRestoreSource", [project, src]) }
    public func mediaRestorePlan(project: String, src: String, asset: String, digest: String? = nil) throws -> String {
        try string("mediaRestorePlan", digest.map { [project, src, asset, $0] } ?? [project, src, asset])
    }
    public func assetKeys(project: String) throws -> [String] {
        (try JSON.parse(string("assetKeys", [project])) as? [String]) ?? []
    }
    public func exportInterchange(project: String, root: String, body: String) throws -> String { try string("exportInterchange", [project, root, body]) }
    public func importInterchange(text: String, format: String, root: String) throws -> String { try string("importInterchange", [text, format, root]) }
    public func transcriptCaptions(project: String, src: String, words: String, body: String) throws -> String { try string("transcriptCaptions", [project, src, words, body]) }
    public func clipSource(project: String, id: String) throws -> String { try string("clipSource", [project, id]) }
    public func framePlan(project: String, at: Double, comp: String? = nil) throws -> String { try string("framePlan", [project, at, comp ?? ""]) }
    public func transcriptDeleteOps(project: String, body: String) throws -> String { try string("transcriptDeleteOps", [project, body]) }
    public func proposeShorts(words: String, body: String) throws -> String { try string("proposeShorts", [words, body]) }
    public func buildShortsOps(project: String, body: String) throws -> String { try string("buildShortsOps", [project, body]) }
    public func audioPlan(project: String, from: Double = 0, to: Double? = nil) throws -> String { try string("audioPlan", [project, from, to ?? duration(project: project)]) }
    public func figmaAssets(nodes: String, options: String = "{}") throws -> String { try string("figmaAssets", [nodes, options]) }
    public func figmaImport(project: String, nodes: String, options: String = "{}") throws -> String { try string("figmaImport", [project, nodes, options]) }
    public func lookLUT(options: String) throws -> String { try string("lookLUT", [options]) }
}

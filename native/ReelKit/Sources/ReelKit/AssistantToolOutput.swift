import Foundation

/// The external assistant receives a projection; the backend and local editor keep diagnostics.
enum AssistantToolOutput {
    static let failureText = "The project request could not complete. Review the editor for details."

    /// Same receipt for every private outcome and unknown ID; no state, identity or result.
    static let unavailableJob: JSON = .object([("available", false), ("message", "This job is not available to the assistant.")])

    private struct Failure: Error, LocalizedError {
        var errorDescription: String? { AssistantToolOutput.failureText }
    }

    static func request(_ method: String, _ path: String, _ body: String?, using tool: Assistant.ToolHandler, diagnostics: Assistant.DiagnosticSink = { _ in }) async throws -> JSON {
        do {
            let value = try await tool(method, path, body)
            try Task.checkCancellation()
            return try project(value, path: path)
        } catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            // Host errors can contain filesystem diagnostics. Do not classify them by message text.
            await diagnostics(error)
            try Task.checkCancellation()
            throw Failure()
        }
    }

    static func frame(_ options: JSON, using still: Assistant.StillHandler, diagnostics: Assistant.DiagnosticSink = { _ in }) async throws -> Assistant.Image {
        do {
            let image = try await still(options)
            try Task.checkCancellation()
            return image
        } catch {
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            await diagnostics(error)
            try Task.checkCancellation()
            throw Failure()
        }
    }

    static func project(_ value: JSON, path: String) throws -> JSON {
        do {
            let route = URLComponents(string: path)?.path
            let receipt = route == "/api/import" ? try importReceipt(value) : value
            return try walk(receipt, insideJob: false, depth: 0, omitActivity: route == "/api/project")
        } catch { throw Failure() }
    }

    /// Import failures are native diagnostics, unlike user-authored project fields.
    /// Project only this endpoint's root failures array; leave asset/project data intact.
    private static func importReceipt(_ value: JSON) throws -> JSON {
        switch value {
        case .raw(let text): return try importReceipt(JSON(any: JSON.parse(text)))
        case .object(let pairs):
            return .object(try pairs.map { key, item in
                (key, key == "failures" ? try importFailures(item) : item)
            })
        default: return value
        }
    }

    private static func importFailures(_ value: JSON) throws -> JSON {
        switch value {
        case .raw(let text): return try importFailures(JSON(any: JSON.parse(text)))
        case .null: return value
        case .array(let items):
            return .array(try items.map { value in
                let record: JSON
                if case .raw(let text) = value { record = JSON(any: try JSON.parse(text)) }
                else { record = value }
                guard case .object(let pairs) = record else { throw Failure() }
                return .object(pairs.map { key, item in
                    (key, key.lowercased() == "error" && item != .null ? .string(failureText) : item)
                })
            })
        default: throw Failure()
        }
    }

    // Only a backend job record's top-level marker is authoritative. User-authored
    // project fields and caller spec.kind/assistantLocalOnly never establish provenance.
    private static func localOnlyJob(_ value: JSON) throws -> Bool {
        if case .raw(let text) = value { return try localOnlyJob(JSON(any: JSON.parse(text))) }
        guard case .object(let pairs) = value,
              Set(pairs.map(\.0)).isSuperset(of: ["id", "kind", "state"]) else { return false }
        return pairs.contains { $0.0 == "assistantLocalOnly" && $0.1 == .bool(true) }
    }

    private static let storageFields: Set<String> = [
        "diskbudget", "disklimit", "maximumdiskbytes", "reserveddiskbytes", "diskreserved",
        "mixanalysisdisklimit", "mixanalysisdiskreservations", "freespace", "freebytes",
        "availablediskspace", "systemfreesize",
    ]

    private static func walk(_ value: JSON, insideJob: Bool, depth: Int, omitActivity: Bool) throws -> JSON {
        guard depth <= 64 else { throw Failure() }
        switch value {
        case .raw(let text):
            return try walk(JSON(any: JSON.parse(text)), insideJob: insideJob, depth: depth, omitActivity: omitActivity)
        case .array(let items):
            return .array(try items.compactMap { item in
                if try localOnlyJob(item) { return nil }
                return try walk(item, insideJob: insideJob, depth: depth + 1, omitActivity: omitActivity)
            })
        case .object(let pairs):
            let keys = Set(pairs.map(\.0))
            let job = insideJob || keys.isSuperset(of: ["id", "kind", "state"])
            if try localOnlyJob(value) { return unavailableJob }
            var projected: [(String, JSON)] = []
            for (key, item) in pairs {
                let name = key.lowercased()
                if job, name == "assistantlocalonly" { continue }
                if depth == 0, omitActivity, name == "activity" { continue }
                // Project content is user-authored data, not a native diagnostic payload.
                if depth == 0, name == "project", !job { projected.append((key, item)); continue }
                if job || depth == 0, storageFields.contains(name) { continue }
                if job || depth == 0, name == "error" || name == "applyerror" {
                    // Cancellation is independent of storage. Other job diagnostics remain local.
                    projected.append((key, item == .null || item == .string("cancelled") ? item : .string(failureText)))
                } else {
                    projected.append((key, try walk(item, insideJob: job, depth: depth + 1, omitActivity: omitActivity)))
                }
            }
            return .object(projected)
        default: return value
        }
    }
}

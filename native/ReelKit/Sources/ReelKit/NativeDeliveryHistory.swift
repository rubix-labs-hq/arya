import CryptoKit
import Foundation

/// Project-relative completion receipts. Discovery never invents a completion claim.
/// Output access accepts only a project-bound ID and rechecks the file at the boundary.
public struct NativeDeliveryHistory {
    public struct SourceCohort: Codable, Sendable {
        let id: String
        let projectSHA256: String
        let sourcesSHA256: String
        let count: Int
    }
    private struct Receipt: Codable {
        let output: String
        let finished: Double
        let preset: String?
        let frames: Int?
        let acceptedVersion: Int?
        let acceptedGeneration: String?
        let acceptedProjectSHA256: String?
        let sourceCohortID: String?
        let sourceCohort: SourceCohort?
    }
    private struct Manifest: Codable { let version: Int; let entries: [Receipt] }
    private struct Failure: LocalizedError { let message: String; var errorDescription: String? { message } }
    private let folder: ProjectFolder
    private let sources: [String]
    private static let extensions: Set<String> = ["mp4", "mov", "webm", "gif", "wav", "m4a", "mp3", "flac", "ogg", "png", "jpg", "jpeg", "srt", "vtt", "otio", "fcpxml"]
    private static let maxEntries = 500, maxBytes = 1_048_576, maxScan = 2000

    public init(folder: ProjectFolder, sources: [String] = []) { self.folder = folder; self.sources = sources }
    private func failure(_ message: String) -> Failure { Failure(message: message) }
    private func id(_ output: String) -> String {
        SHA256.hash(data: Data((folder.root.path + "\0" + output).utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func path(_ output: String) throws -> URL {
        let parts = output.split(separator: "/", omittingEmptySubsequences: false)
        guard output.hasPrefix("renders/"), output.utf8.count <= 2048, !output.contains("\0"), !output.contains("\\"),
              parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else { throw failure("Invalid delivery output") }
        return try folder.output(output)
    }
    private func inspect(_ output: String, expectedFrames: Int? = nil) throws -> (url: URL, frames: Int?) {
        let url = try path(output)
        for source in sources {
            let src = source.hasPrefix("/") ? URL(fileURLWithPath: source).standardizedFileURL : folder.root.appendingPathComponent(source).standardizedFileURL
            let resolved = src.resolvingSymlinksInPath()
            guard resolved.path != url.path, !resolved.path.hasPrefix(url.path + "/") else { throw failure("Delivery contains source media referenced by the project") }
        }
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        if attributes[.type] as? FileAttributeType == .typeRegular {
            guard Self.extensions.contains(url.pathExtension.lowercased()), (attributes[.size] as? NSNumber)?.int64Value ?? 0 > 0 else { throw failure("Delivery file is empty or unsupported") }
            return (url, nil)
        }
        guard attributes[.type] as? FileAttributeType == .typeDirectory else { throw failure("Delivery is not a regular file or frame sequence") }
        let names = try FileManager.default.contentsOfDirectory(atPath: url.path)
        guard !names.isEmpty, names.count <= 100000 else { throw failure("Delivery folder is not a frame sequence") }
        for name in names {
            guard name.range(of: "^frame_[0-9]{5,}\\.png$", options: .regularExpression) != nil else { throw failure("Delivery folder is not a frame sequence") }
            let frame = try folder.output(url.appendingPathComponent(name).path)
            let attributes = try FileManager.default.attributesOfItem(atPath: frame.path)
            guard attributes[.type] as? FileAttributeType == .typeRegular, (attributes[.size] as? NSNumber)?.int64Value ?? 0 > 0 else { throw failure("Delivery sequence has an unavailable frame") }
        }
        if let expectedFrames, expectedFrames != names.count { throw failure("Delivery sequence has missing or extra frames") }
        return (url, names.count)
    }
    private func validate(_ cohort: SourceCohort) throws {
        func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
        guard matches(cohort.id, "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$"),
              matches(cohort.projectSHA256, "^[a-f0-9]{64}$"), matches(cohort.sourcesSHA256, "^[a-f0-9]{64}$"),
              cohort.count >= 0, cohort.count <= 10000 else { throw failure("Invalid export source cohort receipt") }
    }
    private func validateBinding(version: Int?, generation: String?, project: String?, sources: String?) throws {
        guard version.map({ $0 >= 0 && $0 <= 9_007_199_254_740_991 }) ?? true,
              generation.map({ $0.range(of: "^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$", options: .regularExpression) != nil }) ?? true,
              [project, sources].allSatisfy({ $0.map { $0.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil } ?? true }) else { throw failure("Invalid native export binding receipt") }
    }
    private func read() throws -> [Receipt] {
        let file = try folder.output(".reel/deliveries.json")
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
        guard attributes[.type] as? FileAttributeType == .typeRegular, (attributes[.size] as? NSNumber)?.intValue ?? Self.maxBytes + 1 <= Self.maxBytes else { throw failure("Delivery history is not a supported regular file") }
        let manifest = try JSONDecoder().decode(Manifest.self, from: Data(contentsOf: file))
        guard manifest.version == 1, manifest.entries.count <= Self.maxEntries else { throw failure("Delivery history format is unsupported") }
        var seen = Set<String>()
        for entry in manifest.entries {
            _ = try path(entry.output)
            if let cohort = entry.sourceCohort { try validate(cohort) }
            try validateBinding(version: entry.acceptedVersion, generation: entry.acceptedGeneration, project: entry.acceptedProjectSHA256, sources: entry.sourceCohortID)
            guard seen.insert(entry.output).inserted, entry.finished.isFinite, entry.finished >= 0, entry.frames.map({ $0 > 0 }) ?? true else { throw failure("Delivery history has an invalid receipt") }
        }
        return manifest.entries
    }
    public func record(output: String, preset: String?, finished: Double, expectedFrames: Int? = nil, acceptedVersion: Int? = nil, acceptedGeneration: String? = nil, acceptedProjectSHA256: String? = nil, sourceCohortID: String? = nil, sourceCohort: SourceCohort? = nil) throws {
        if let sourceCohort { try validate(sourceCohort) }
        try validateBinding(version: acceptedVersion, generation: acceptedGeneration, project: acceptedProjectSHA256, sources: sourceCohortID)
        guard finished.isFinite, finished >= 0 else { throw failure("Invalid delivery completion time") }
        let output = output.hasSuffix("/frame_%05d.png") ? String(output.dropLast("/frame_%05d.png".count)) : output
        let checked = try inspect(output, expectedFrames: expectedFrames)
        var receipts = try read().filter { $0.output != output }
        receipts.append(Receipt(output: output, finished: finished, preset: preset.map { String($0.prefix(80)) }, frames: checked.frames, acceptedVersion: acceptedVersion, acceptedGeneration: acceptedGeneration, acceptedProjectSHA256: acceptedProjectSHA256, sourceCohortID: sourceCohortID, sourceCohort: sourceCohort))
        let data = try JSONEncoder().encode(Manifest(version: 1, entries: Array(receipts.suffix(Self.maxEntries))))
        guard data.count <= Self.maxBytes else { throw failure("Delivery history is full") }
        let file = try folder.output(".reel/deliveries.json")
        try FileManager.default.createDirectory(at: folder.output(folder.dotDir.path), withIntermediateDirectories: true)
        // Atomic publish only of app-owned history; no project file or source is touched.
        try data.write(to: folder.output(file.path), options: .atomic)
    }
    public func list() -> JSON {
        var receipts: [Receipt] = [], warnings: [String] = []
        do { receipts = try read() }
        catch { warnings.append("Saved delivery history could not be read. Existing render files are shown without a completion receipt.") }
        var rows: [String: [String: Any]] = [:]
        func add(_ output: String, receipt: Receipt? = nil) {
            let inspected = try? inspect(output, expectedFrames: receipt?.frames)
            var row: [String: Any] = ["id": id(output), "output": output, "provenance": receipt == nil ? "existing" : "completed", "available": inspected != nil, "sequence": inspected?.frames != nil || receipt?.frames != nil]
            if let receipt { row["finished"] = receipt.finished; if let preset = receipt.preset { row["preset"] = preset }
                if let version = receipt.acceptedVersion { row["acceptedVersion"] = version }
                if let generation = receipt.acceptedGeneration { row["acceptedGeneration"] = generation }
                if let hash = receipt.acceptedProjectSHA256 { row["acceptedProjectSHA256"] = hash }
                if let cohort = receipt.sourceCohortID { row["sourceCohortID"] = cohort }
                if let cohort = receipt.sourceCohort { row["sourceCohort"] = ["id": cohort.id, "projectSHA256": cohort.projectSHA256, "sourcesSHA256": cohort.sourcesSHA256, "count": cohort.count] }
            }
            if inspected == nil { row["problem"] = "Missing, empty, changed sequence, source media, or unsafe output. Restore the original output or export again." }
            rows[output] = row
        }
        for receipt in receipts { add(receipt.output, receipt: receipt) }
        var scanned = 0
        func visit(_ directory: URL, depth: Int) {
            guard depth <= 4, let checked = try? folder.output(directory.path), let names = try? FileManager.default.contentsOfDirectory(atPath: checked.path) else { return }
            for name in names.sorted() {
                scanned += 1
                if scanned > Self.maxScan { warnings.append("Some render files were omitted because discovery reached its limit."); return }
                if name.hasPrefix(".") || name.contains(".part") || name.hasSuffix(".tmp") { continue }
                let file = directory.appendingPathComponent(name), output = folder.relative(file)
                if rows[output] != nil { continue }
                if (try? inspect(output)) != nil { add(output) }
                else if let safe = try? folder.output(file.path), let attributes = try? FileManager.default.attributesOfItem(atPath: safe.path), attributes[.type] as? FileAttributeType == .typeDirectory { visit(safe, depth: depth + 1) }
            }
        }
        visit(folder.rendersDir, depth: 0)
        let sorted = rows.values.sorted { lhs, rhs in
            let a = lhs["finished"] as? Double ?? 0, b = rhs["finished"] as? Double ?? 0
            return a != b ? a > b : (lhs["output"] as? String ?? "") < (rhs["output"] as? String ?? "")
        }
        return JSON(any: ["root": folder.root.path, "deliveries": sorted, "warnings": Array(Set(warnings)).sorted()])
    }
    public func resolve(id requestedID: String, root: String) throws -> URL {
        guard root == folder.root.path else { throw failure("The project changed. Refresh delivery history.") }
        let result = try JSON.parse(list().text) as? [String: Any] ?? [:]
        guard let row = (result["deliveries"] as? [[String: Any]])?.first(where: { $0["id"] as? String == requestedID }), row["available"] as? Bool == true,
              let output = row["output"] as? String else { throw failure("This delivery is unavailable. Restore the output or export again.") }
        return try inspect(output).url
    }
}

import Foundation
import Darwin
import CoreFoundation
import CryptoKit
import ReelKit

struct NativeLibraryCapture {
    let project: [String: Any]
    let selected: [String: Any]?
    let composition: String?
    let version: Int
    private let folder: String?
    private let snapshot: Data?

    init(project: [String: Any], selected: [String: Any]? = nil, composition: String? = nil, folder: String?, version: Int) {
        self.project = project; self.selected = selected; self.composition = composition
        self.folder = folder; self.version = version; snapshot = Self.data(project)
    }

    func matches(project: [String: Any], folder: String?, version: Int) -> Bool {
        guard self.folder == folder, self.version == version, let snapshot else { return false }
        return snapshot == Self.data(project)
    }

    func matchesSelection(selected: [String: Any]?, composition: String?) -> Bool {
        guard self.composition == composition, let expected = Self.data(self.selected ?? [:]), let current = Self.data(selected ?? [:]) else { return false }
        return expected == current
    }

    static func itemMatches(_ item: NativeLibraryItem, project: [String: Any]) -> Bool {
        guard let current = NativeLibrarySelection.items(in: project).first(where: { $0.id == item.id }), let expected = data(item.fields) else { return false }
        return expected == data(current.fields)
    }

    private static func data(_ fields: [String: Any]) -> Data? {
        try? NativeLibraryTransferJSON.data(fields)
    }
}

// A picker owns this immutable request from presentation through asynchronous
// read completion. A callback must never adopt a newer request's capture.
struct NativeLibraryImportRequest: Identifiable {
    let id = UUID()
    let capture: NativeLibraryCapture
    let contextID: UUID

    func owns(currentID: UUID?) -> Bool { id == currentID }

    func admits(currentID: UUID?, contextID: UUID, project: [String: Any], folder: String?, version: Int) -> Bool {
        guard owns(currentID: currentID), self.contextID == contextID else { return false }
        return capture.matches(project: project, folder: folder, version: version)
    }
}

// Each export keeps its own capture and item through asynchronous preparation.
struct NativeLibraryExportRequest: Identifiable {
    let id = UUID()
    let capture: NativeLibraryCapture
    let contextID: UUID
    let item: NativeLibraryItem

    func admits(currentID: UUID?, contextID: UUID, project: [String: Any], folder: String?, version: Int) -> Bool {
        guard id == currentID, self.contextID == contextID else { return false }
        return capture.matches(project: project, folder: folder, version: version)
            && NativeLibraryCapture.itemMatches(item, project: project)
    }
}

// The presenter's local binding can be dismissed before completion arrives.
// Reappearance must not start a second picker for the same request identity.
struct NativeLibraryImportPresentation {
    var isPresented = false
    private var started = false

    init() {}

    mutating func start() {
        guard !started else { return }
        started = true; isPresented = true
    }
}

// Same scalar-writing approach as ReelKit JSON.write/quote. Do not bridge Swift
// strings through NSString: Foundation can discard a leading U+FEFF there.
enum NativeLibraryTransferJSON {
    static func data(_ value: Any) throws -> Data {
        var text = ""
        try write(value, to: &text, depth: 0)
        return Data(text.utf8)
    }

    private static func write(_ value: Any, to text: inout String, depth: Int) throws {
        guard depth <= 128 else { throw NativeLibraryTransferError.invalid("The JSON data is too deeply nested.") }
        if let string = value as? String { quote(string, into: &text) }
        else if value is NSNull { text += "null" }
        else if let number = value as? NSNumber {
            if CFGetTypeID(number) == CFBooleanGetTypeID() { text += number.boolValue ? "true" : "false" }
            else {
                let n = number.doubleValue
                guard n.isFinite else { throw NativeLibraryTransferError.invalid("The JSON data contains a non-finite number.") }
                text += n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
            }
        } else if let values = value as? [Any] {
            text += "["
            for (index, child) in values.enumerated() {
                if index > 0 { text += "," }
                try write(child, to: &text, depth: depth + 1)
            }
            text += "]"
        } else if let fields = value as? [String: Any] {
            text += "{"
            for (index, key) in fields.keys.sorted(by: { $0.utf8.lexicographicallyPrecedes($1.utf8) }).enumerated() {
                if index > 0 { text += "," }
                quote(key, into: &text); text += ":"
                try write(fields[key]!, to: &text, depth: depth + 1)
            }
            text += "}"
        } else { throw NativeLibraryTransferError.invalid("The component contains unsupported JSON data.") }
    }

    private static func quote(_ value: String, into text: inout String) {
        text += "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": text += "\\\""
            case "\\": text += "\\\\"
            case "\n": text += "\\n"
            case "\r": text += "\\r"
            case "\t": text += "\\t"
            case "\u{2028}": text += "\\u2028"
            case "\u{2029}": text += "\\u2029"
            default:
                if scalar.value < 0x20 { text += String(format: "\\u%04x", scalar.value) }
                else { text.unicodeScalars.append(scalar) }
            }
        }
        text += "\""
    }
}

enum NativeLibraryTransferError: LocalizedError {
    case invalid(String)
    var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}

struct NativeLibraryTransferPackage {
    let item: NativeLibraryItem
    let sourceProject: String
    let sourceProjectVersion: Int
    let exportedAt: String
    let itemSHA256: String
    let packageSHA256: String
    let receipts: [[String: Any]]
    let resources: [String: Any]

    var sourceItem: String { item.id }

    func registrationItem() -> [String: Any] {
        var fields = item.fields
        fields.removeValue(forKey: "id") // Let the shared core allocate a collision-safe ID.
        let receipt: [String: Any] = ["sourceItemID": item.id, "sourceProjectName": sourceProject,
            "sourceProjectVersion": sourceProjectVersion, "exportedAt": exportedAt,
            "itemSHA256": itemSHA256, "packageSHA256": packageSHA256]
        fields["provenance"] = ["format": "arya-component", "version": 1, "imports": receipts + [receipt]]
        return fields
    }

    func confirms(_ item: NativeLibraryItem, resourcePaths: [String: String] = [:]) -> Bool {
        var saved = item.fields
        saved.removeValue(forKey: "id")
        var expected = registrationItem()
        if !resourcePaths.isEmpty { expected["body"] = NativeLibraryTransfer.remapBody(self.item.body, paths: resourcePaths) }
        // These are the shared core's two registration normalizations. The receipt
        // still hashes the untouched source itemJSON, including its original name.
        expected["name"] = NativeLibraryTransfer.trim(self.item.name)
        if expected["description"] == nil { expected["description"] = "" }
        guard let savedBytes = try? NativeLibraryTransferJSON.data(saved),
              let expectedBytes = try? NativeLibraryTransferJSON.data(expected) else { return false }
        return savedBytes == expectedBytes
    }
}

struct NativeLibraryTransferPreview: Identifiable {
    let id = UUID()
    let package: NativeLibraryTransferPackage
    let capture: NativeLibraryCapture
    let contextID: UUID
}

enum NativeLibraryTransfer {
    static let itemLimit = 2 * 1024 * 1024
    static let packageLimit = 8 * 1024 * 1024
    static let receiptLimit = 32
    // ECMAScript String.trim used by the shared core. Foundation additionally
    // trims U+0085 and may omit U+FEFF, so its general whitespace set is unsuitable.
    private static let coreWhitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    static func trim(_ text: String) -> String { text.trimmingCharacters(in: coreWhitespace) }

    static func exportReason(_ item: NativeLibraryItem) -> String? {
        do {
            try rejectUnsupportedUnicode(item.fields)
            try inspect(item, allowLUT: true)
            if try history(item).count >= receiptLimit { return "This component has reached the 32-import history limit. It cannot be transferred again while retaining its provenance." }
            return nil
        } catch { return error.localizedDescription }
    }

    static func exportPackage(_ item: NativeLibraryItem, project: [String: Any], version: Int, resources: [String: Any] = [:]) throws -> Data {
        if let reason = exportReason(item) { throw NativeLibraryTransferError.invalid(reason) }
        try validateResources(resources, item: item)
        let bytes = try jsonData(item.fields)
        guard bytes.count <= itemLimit, let text = String(data: bytes, encoding: .utf8) else { throw NativeLibraryTransferError.invalid("The component JSON must be no larger than 2 MB.") }
        let name = project["name"] as? String ?? "Untitled"
        try rejectUnsupportedUnicode(name)
        guard !trim(name).isEmpty, name.utf16.count <= 512, version >= 0, version <= 9_007_199_254_740_991 else { throw NativeLibraryTransferError.invalid("The source project identity is unavailable or too long.") }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var envelope: [String: Any] = ["format": "arya-component", "version": resources.isEmpty ? 1 : 2, "itemJSON": text, "itemSHA256": digest(bytes),
            "origin": ["projectName": name, "projectVersion": version, "exportedAt": formatter.string(from: Date())]]
        if !resources.isEmpty { envelope["resources"] = resources }
        let data = try jsonData(envelope)
        guard data.count <= packageLimit else { throw NativeLibraryTransferError.invalid("The component package must be no larger than 8 MB.") }
        return data
    }

    static func readPackageData(_ url: URL) throws -> Data {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { throw NativeLibraryTransferError.invalid("Choose an accessible regular JSON component file.") }
        let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true); defer { try? file.close() }
        var before = Darwin.stat(), after = Darwin.stat(), named = Darwin.stat()
        guard fstat(descriptor, &before) == 0, before.st_mode & S_IFMT == S_IFREG, before.st_size > 0, before.st_size <= packageLimit else {
            throw NativeLibraryTransferError.invalid("Choose a regular JSON component file no larger than 8 MB.")
        }
        var bytes = Data()
        while let chunk = try file.read(upToCount: min(64 * 1024, packageLimit - bytes.count + 1)), !chunk.isEmpty {
            bytes.append(chunk)
            guard bytes.count <= packageLimit else { throw NativeLibraryTransferError.invalid("The component package must be no larger than 8 MB.") }
        }
        guard fstat(descriptor, &after) == 0, lstat(url.path, &named) == 0,
              before.st_dev == after.st_dev, before.st_ino == after.st_ino, before.st_size == after.st_size,
              before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec, before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
              before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec, before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec,
              named.st_dev == after.st_dev, named.st_ino == after.st_ino, named.st_mode & S_IFMT == S_IFREG,
              bytes.count == before.st_size else { throw NativeLibraryTransferError.invalid("The selected package changed while it was read. Select it again.") }
        return bytes
    }

    static func decode(_ data: Data) throws -> NativeLibraryTransferPackage {
        guard !data.isEmpty, data.count <= packageLimit else { throw NativeLibraryTransferError.invalid("Choose an Arya component JSON package no larger than 8 MB.") }
        try requireUTF8JSON(data)
        try rejectUnsupportedUnicodeTokens(data)
        guard !data.isEmpty, data.count <= packageLimit, let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NativeLibraryTransferError.invalid("Choose an Arya component JSON package no larger than 8 MB.") }
        try keys(envelope, allowed: ["format", "version", "itemJSON", "itemSHA256", "origin", "resources"])
        guard envelope["format"] as? String == "arya-component", let packageVersion = integer(envelope["version"]), [1, 2].contains(packageVersion),
              let text = envelope["itemJSON"] as? String, let bytes = text.data(using: .utf8), bytes.count <= itemLimit,
              let expected = envelope["itemSHA256"] as? String, validDigest(expected), digest(bytes) == expected,
              let origin = envelope["origin"] as? [String: Any] else { throw NativeLibraryTransferError.invalid("The package format or item digest is invalid. Its component data may have changed.") }
        try requireUTF8JSON(bytes)
        try rejectUnsupportedUnicodeTokens(bytes)
        guard let fields = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw NativeLibraryTransferError.invalid("The component item JSON must be an object.") }
        try keys(origin, allowed: ["projectName", "projectVersion", "exportedAt"])
        guard let name = origin["projectName"] as? String, !trim(name).isEmpty, name.utf16.count <= 512,
              let version = integer(origin["projectVersion"]), let exportedAt = origin["exportedAt"] as? String, validDate(exportedAt) else { throw NativeLibraryTransferError.invalid("The package source project or export date is invalid.") }
        let item = NativeLibraryItem(fields: fields)
        guard packageVersion == 2 || envelope["resources"] == nil else { throw NativeLibraryTransferError.invalid("Version 1 packages cannot contain resource files.") }
        let resources = envelope["resources"] as? [String: Any] ?? [:]
        if packageVersion == 2, !(envelope["resources"] is [String: Any]) { throw NativeLibraryTransferError.invalid("Version 2 packages need a LUT resource map.") }
        try inspect(item, allowLUT: packageVersion == 2)
        try validateResources(resources, item: item)
        let receipts = try history(item)
        guard receipts.count < receiptLimit else { throw NativeLibraryTransferError.invalid("This component already has 32 import receipts. Importing it again would exceed the provenance limit.") }
        return NativeLibraryTransferPackage(item: item, sourceProject: name, sourceProjectVersion: version, exportedAt: exportedAt, itemSHA256: expected, packageSHA256: digest(data), receipts: receipts, resources: resources)
    }

    static func filename(_ name: String) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: " -_"))
        let cleaned = name.unicodeScalars.map { allowed.contains($0) ? String($0) : "_" }.joined()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String((cleaned.isEmpty ? "Component" : cleaned).prefix(80)) + ".arya-component"
    }

    private static func inspect(_ item: NativeLibraryItem, allowLUT: Bool = false) throws {
        try keys(item.fields, allowed: ["id", "name", "description", "category", "body", "provenance"])
        guard validID(item.id), item.category != nil, let name = item.fields["name"] as? String,
              !trim(name).isEmpty, name.utf16.count <= 120,
              item.fields["body"] is [String: Any],
              item.fields["description"] == nil || (item.fields["description"] as? String).map({ $0.utf16.count <= 2000 }) == true else { throw NativeLibraryTransferError.invalid("The component identity, name or body is invalid.") }
        if let assets = item.body["assets"] {
            guard let map = assets as? [String: Any], map.isEmpty else { throw NativeLibraryTransferError.invalid("Media files are not bundled in LUT component packages. Transfer those files separately.") }
        }
        var paths = Set<String>(), count = 0
        try scan(item.fields, depth: 0, count: &count, paths: &paths, findPaths: false)
        count = 0
        try scan(item.body, depth: 0, count: &count, paths: &paths, findPaths: true)
        let luts = lutPaths(item.body)
        guard paths.isEmpty || allowLUT && paths == luts else { throw NativeLibraryTransferError.invalid("Component packages support LUT files only. Media files must be transferred separately.") }
        let resources = item.body["resources"] as? [String: Any] ?? [:]
        guard luts.count <= 32, item.body["resources"] == nil || item.body["resources"] is [String: Any], Set(resources.keys) == luts else {
            throw NativeLibraryTransferError.invalid("The component LUT dependency receipts are incomplete.")
        }
        for path in luts {
            try requireLUTPath(path)
            guard let receipt = resources[path] as? [String: Any] else { throw NativeLibraryTransferError.invalid("Invalid component LUT receipt.") }
            try keys(receipt, allowed: ["type", "size", "sourceHash"])
            guard receipt["type"] as? String == "lut", let size = integer(receipt["size"]), (2...256).contains(size),
                  let hash = receipt["sourceHash"] as? String, validDigest(hash) else { throw NativeLibraryTransferError.invalid("Invalid component LUT receipt.") }
        }
    }

    private static func lutPaths(_ value: Any) -> Set<String> {
        var result = Set<String>()
        if let fields = value as? [String: Any] {
            for (key, child) in fields {
                if key == "lut", let path = child as? String, !path.isEmpty { result.insert(path) }
                result.formUnion(lutPaths(child))
            }
        } else if let values = value as? [Any] { for child in values { result.formUnion(lutPaths(child)) } }
        return result
    }

    private static func requireLUTPath(_ path: String) throws {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.isEmpty, path.utf16.count <= 1024, !path.contains("\\"), !path.contains(":"),
              !path.unicodeScalars.contains(where: { $0.value < 0x20 }),
              (path as NSString).pathExtension.lowercased() == "cube", parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw NativeLibraryTransferError.invalid("LUT dependencies must be confined relative CUBE paths.")
        }
    }

    private static func validateResources(_ resources: [String: Any], item: NativeLibraryItem) throws {
        try inspect(item, allowLUT: true)
        let luts = lutPaths(item.body)
        guard Set(resources.keys) == luts else { throw NativeLibraryTransferError.invalid("Include exactly the component's referenced LUT files.") }
        let receipts = item.body["resources"] as? [String: Any] ?? [:]
        var total = 0
        for path in luts {
            guard let fields = resources[path] as? [String: Any], let receipt = receipts[path] as? [String: Any] else { throw NativeLibraryTransferError.invalid("A packaged LUT is missing.") }
            try keys(fields, allowed: ["type", "size", "sourceHash", "text"])
            guard fields["type"] as? String == "lut", let text = fields["text"] as? String,
                  let size = integer(fields["size"]), integer(receipt["size"]) == size,
                  let hash = fields["sourceHash"] as? String, hash == receipt["sourceHash"] as? String else { throw NativeLibraryTransferError.invalid("A packaged LUT receipt is inconsistent.") }
            let data = Data(text.utf8); total += data.count
            guard !data.isEmpty, data.count <= 2 * 1024 * 1024, total <= 4 * 1024 * 1024,
                  !text.hasPrefix("\u{FEFF}"), !text.contains("\0"), digest(data) == hash,
                  let inspection = try JSONSerialization.jsonObject(with: Data(ReelLUTInspection.inspect(text: text).text.utf8)) as? [String: Any],
                  integer(inspection["size"]) == size else { throw NativeLibraryTransferError.invalid("A packaged LUT is corrupt, too large or has the wrong grid.") }
        }
    }

    static func remapBody(_ value: Any, paths: [String: String]) -> Any {
        if var fields = value as? [String: Any] {
            for (key, child) in fields {
                if key == "lut", let path = child as? String, let mapped = paths[path] { fields[key] = mapped }
                else if key == "resources", let resources = child as? [String: Any] {
                    var mapped: [String: Any] = [:]
                    for (path, receipt) in resources { mapped[paths[path] ?? path] = receipt }
                    fields[key] = mapped
                } else { fields[key] = remapBody(child, paths: paths) }
            }
            return fields
        }
        if let values = value as? [Any] { return values.map { remapBody($0, paths: paths) } }
        return value
    }

    private static func scan(_ value: Any, depth: Int, count: inout Int, paths: inout Set<String>, findPaths: Bool) throws {
        count += 1
        guard depth <= 40, count <= 100_000 else { throw NativeLibraryTransferError.invalid("The component is too large or deeply nested.") }
        if let fields = value as? [String: Any] {
            for (key, value) in fields {
                guard !["__proto__", "constructor", "prototype"].contains(key) else { throw NativeLibraryTransferError.invalid("The component contains an unsafe field.") }
                if findPaths, ["src", "lut"].contains(key), let path = value as? String, !path.isEmpty { paths.insert(path) }
                try scan(value, depth: depth + 1, count: &count, paths: &paths, findPaths: findPaths)
            }
        } else if let values = value as? [Any] {
            for value in values { try scan(value, depth: depth + 1, count: &count, paths: &paths, findPaths: findPaths) }
        }
    }

    private static func history(_ item: NativeLibraryItem) throws -> [[String: Any]] {
        guard let value = item.fields["provenance"] else { return [] }
        guard let provenance = value as? [String: Any] else { throw NativeLibraryTransferError.invalid("The existing provenance is invalid.") }
        try keys(provenance, allowed: ["format", "version", "imports"])
        guard provenance["format"] as? String == "arya-component", integer(provenance["version"]) == 1,
              let receipts = provenance["imports"] as? [[String: Any]], !receipts.isEmpty, receipts.count <= receiptLimit else { throw NativeLibraryTransferError.invalid("The existing provenance history must contain 1 to 32 imports.") }
        for receipt in receipts {
            try keys(receipt, allowed: ["sourceItemID", "sourceProjectName", "sourceProjectVersion", "exportedAt", "itemSHA256", "packageSHA256"])
            guard let id = receipt["sourceItemID"] as? String, validID(id), let name = receipt["sourceProjectName"] as? String,
                  !trim(name).isEmpty, name.utf16.count <= 512, integer(receipt["sourceProjectVersion"]) != nil, validDate(receipt["exportedAt"]),
                  let itemHash = receipt["itemSHA256"] as? String, validDigest(itemHash), let packageHash = receipt["packageSHA256"] as? String, validDigest(packageHash) else { throw NativeLibraryTransferError.invalid("An existing provenance receipt is invalid.") }
        }
        return receipts
    }

    private static func keys(_ fields: [String: Any], allowed: Set<String>) throws {
        guard Set(fields.keys).isSubset(of: allowed) else { throw NativeLibraryTransferError.invalid("The package contains unsupported fields.") }
    }
    private static func validID(_ value: String) -> Bool { value.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil }
    private static func validDigest(_ value: String) -> Bool { value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil }
    private static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
              number.doubleValue >= 0, number.doubleValue <= 9_007_199_254_740_991, number.doubleValue.rounded() == number.doubleValue else { return nil }
        return number.intValue
    }
    private static func validDate(_ value: Any?) -> Bool {
        guard let text = value as? String, text.utf16.count <= 40,
              text.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,3})?Z$", options: .regularExpression) != nil else { return false }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text) else { return false }
        let canonical = ISO8601DateFormatter().string(from: date)
        return canonical.prefix(19) == text.prefix(19) // Reject invalid dates that Foundation normalizes.
    }
    private static func jsonData(_ fields: [String: Any]) throws -> Data {
        try NativeLibraryTransferJSON.data(fields)
    }
    private static let unsupportedUnicode = "This component contains a string or field name starting with U+FEFF, which is not supported for transfer. The original component is unchanged."

    private static func requireUTF8JSON(_ data: Data) throws {
        guard !data.contains(0), String(data: data, encoding: .utf8) != nil else { throw NativeLibraryTransferError.invalid("Component packages must use UTF-8 JSON. UTF-16, UTF-32 and raw NUL bytes are not supported.") }
    }

    private static func rejectUnsupportedUnicode(_ value: Any, depth: Int = 0) throws {
        guard depth <= 40 else { throw NativeLibraryTransferError.invalid("The component is too deeply nested.") }
        if let text = value as? String {
            guard text.unicodeScalars.first?.value != 0xFEFF else { throw NativeLibraryTransferError.invalid(unsupportedUnicode) }
        } else if let values = value as? [Any] {
            for value in values { try rejectUnsupportedUnicode(value, depth: depth + 1) }
        } else if let fields = value as? [String: Any] {
            for (key, value) in fields {
                try rejectUnsupportedUnicode(key, depth: depth + 1)
                try rejectUnsupportedUnicode(value, depth: depth + 1)
            }
        }
    }

    // Inspect quoted token prefixes before Foundation sees them. itemJSON is
    // scanned again after its envelope string is decoded; escaped JSON content
    // must not be mistaken for the envelope's own token boundaries.
    private static func rejectUnsupportedUnicodeTokens(_ data: Data) throws {
        let bytes = Array(data)
        var index = 0
        while index < bytes.count {
            guard bytes[index] == 0x22 else { index += 1; continue }
            index += 1
            let literal = bytes[index...].starts(with: [0xEF, 0xBB, 0xBF])
            let escaped = index + 6 <= bytes.count && bytes[index] == 0x5C && bytes[index + 1] == 0x75
                && Array(bytes[(index + 2)..<(index + 6)]).map { $0 | 0x20 } == [0x66, 0x65, 0x66, 0x66]
            guard !literal, !escaped else { throw NativeLibraryTransferError.invalid(unsupportedUnicode) }
            while index < bytes.count {
                if bytes[index] == 0x5C {
                    if index + 1 < bytes.count, bytes[index + 1] == 0x75 {
                        guard let unit = unicodeEscape(bytes, at: index) else { throw NativeLibraryTransferError.invalid("The component JSON contains an invalid Unicode escape.") }
                        if (0xD800...0xDBFF).contains(unit) {
                            guard let low = unicodeEscape(bytes, at: index + 6), (0xDC00...0xDFFF).contains(low) else { throw NativeLibraryTransferError.invalid("The component JSON contains an unpaired Unicode surrogate.") }
                            index += 12
                        } else {
                            guard !(0xDC00...0xDFFF).contains(unit) else { throw NativeLibraryTransferError.invalid("The component JSON contains an unpaired Unicode surrogate.") }
                            index += 6
                        }
                    } else { index += 2 }
                }
                else if bytes[index] == 0x22 { index += 1; break }
                else { index += 1 }
            }
        }
    }
    private static func unicodeEscape(_ bytes: [UInt8], at index: Int) -> UInt16? {
        guard index + 6 <= bytes.count, bytes[index] == 0x5C, bytes[index + 1] == 0x75 else { return nil }
        var value: UInt16 = 0
        for byte in bytes[(index + 2)..<(index + 6)] {
            let digit: UInt8
            switch byte {
            case 0x30...0x39: digit = byte - 0x30
            case 0x41...0x46: digit = byte - 0x41 + 10
            case 0x61...0x66: digit = byte - 0x61 + 10
            default: return nil
            }
            value = value * 16 + UInt16(digit)
        }
        return value
    }
    private static func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
}

enum NativeLibraryCategory: String, CaseIterable, Identifiable {
    case title, composition, effect, transition, motion
    var id: String { rawValue }
    var name: String {
        switch self {
        case .title: return "Titles"
        case .composition: return "Compositions"
        case .effect: return "Effects"
        case .transition: return "Transitions"
        case .motion: return "Motion"
        }
    }
    var icon: String {
        switch self {
        case .title: return "textformat"
        case .composition: return "square.stack"
        case .effect: return "slider.horizontal.3"
        case .transition: return "rectangle.on.rectangle"
        case .motion: return "diamond"
        }
    }
    var placesObject: Bool { self == .title || self == .composition }
}

struct NativeLibraryItem: Identifiable {
    let fields: [String: Any]
    var id: String { fields["id"] as? String ?? "" }
    var name: String { fields["name"] as? String ?? "Saved component" }
    var description: String { fields["description"] as? String ?? "" }
    var category: NativeLibraryCategory? { (fields["category"] as? String).flatMap(NativeLibraryCategory.init) }
    var body: [String: Any] { fields["body"] as? [String: Any] ?? [:] }
    var placesObject: Bool {
        category?.placesObject == true || category == .effect && (body["composition"] is String || (body["clip"] as? [String: Any])?["kind"] as? String == "comp")
    }
    var isCompositionTransition: Bool {
        category == .transition && (body["composition"] is String || (body["clip"] as? [String: Any])?["kind"] as? String == "comp")
    }
    var transitionCompositionDuration: Double? { isCompositionTransition ? compositionDetails.duration : nil }
    var detail: String {
        let settings = body["settings"] as? [String: Any] ?? [:]
        switch category {
        case .title, .composition:
            let clip = body["clip"] as? [String: Any] ?? [:]
            if clip["kind"] as? String == "title" {
                let title = clip["title"] as? [String: Any] ?? [:]
                let font = title["font"] as? String ?? "Native title"
                let text = title["text"] as? String ?? ""
                return text.isEmpty ? font : "\(font) · \(text)"
            }
            let count = compositionDetails.count
            return "Editable composition · \(count) \(count == 1 ? "layer" : "layers")"
        case .effect:
            if placesObject {
                let info = compositionDetails
                return "Editable effect composition · \(info.count) \(info.count == 1 ? "layer" : "layers") · \(info.duration.formatted(.number.precision(.fractionLength(0...2)))) s"
            }
            var parts = (settings["effects"] as? [[String: Any]] ?? []).compactMap { $0["type"] as? String }
            let nodes = settings["nodes"] as? [String: Any] ?? [:]
            let count = (nodes["list"] as? [[String: Any]] ?? []).filter { !["source", "output"].contains($0["type"] as? String ?? "") }.count
            if count > 0 { parts.append("\(count) \(count == 1 ? "node" : "nodes")") }
            if !(settings["grade"] as? [String: Any] ?? [:]).isEmpty { parts.append("Color grade") }
            return parts.isEmpty ? "Editable visual effect" : parts.joined(separator: " · ")
        case .transition:
            if isCompositionTransition {
                let info = compositionDetails
                return "Editable overlay transition · \(info.count) \(info.count == 1 ? "layer" : "layers") · \(info.duration.formatted(.number.precision(.fractionLength(0...2)))) s"
            }
            let transition = settings["transitionIn"] as? [String: Any] ?? [:]
            let name = transition["type"] as? String ?? "Visual transition"
            let duration = (transition["dur"] as? NSNumber)?.doubleValue ?? 0
            return duration > 0 ? "\(name) · \(duration.formatted(.number.precision(.fractionLength(0...2)))) s" : name
        case .motion:
            let anim = settings["anim"] as? [String: Any] ?? [:]
            return "Editable keyframes · " + anim.keys.sorted().joined(separator: ", ")
        case nil: return "Unsupported component type"
        }
    }

    private var compositionDetails: (count: Int, duration: Double) {
        let clip = body["clip"] as? [String: Any] ?? [:]
        let comps = body["comps"] as? [String: Any] ?? [:]
        let rootID = body["composition"] as? String ?? clip["comp"] as? String
        let root = rootID.flatMap { comps[$0] as? [String: Any] } ?? [:]
        let clips = (root["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
        let end = clips.map { (($0["start"] as? NSNumber)?.doubleValue ?? 0) + (($0["dur"] as? NSNumber)?.doubleValue ?? 0) }.max() ?? 0
        let duration = (clip["dur"] as? NSNumber)?.doubleValue ?? (root["duration"] as? NSNumber)?.doubleValue ?? (end > 0 ? end : 5)
        return (clips.count, duration)
    }
}

enum NativeLibrarySelection {
    static let visualKinds = Set(["video", "image", "title", "shape", "color", "comp", "adjustment", "multicam"])

    static func items(in project: [String: Any]) -> [NativeLibraryItem] {
        let library = project["library"] as? [String: Any] ?? [:]
        guard (library["version"] as? NSNumber)?.intValue == 1 else { return [] }
        return (library["items"] as? [[String: Any]] ?? []).map(NativeLibraryItem.init).filter { !$0.id.isEmpty && $0.category != nil }
    }

    static func source(category: NativeLibraryCategory, project: [String: Any], selected: [String: Any]?, composition: String?, asComposition: Bool = false) -> [String: String]? {
        let comps = project["comps"] as? [String: Any] ?? [:]
        let selectedComp = selected?["kind"] as? String == "comp" ? selected?["comp"] as? String : nil
        let root = selectedComp ?? composition
        if category == .composition {
            guard let root, comps[root] is [String: Any] else { return nil }
            if selectedComp != nil, let id = selected?["id"] as? String { return ["clip": id] }
            return ["composition": root]
        }
        if category == .title {
            if let selected, selected["kind"] as? String == "title", let id = selected["id"] as? String { return ["clip": id] }
            if let root, containsTitle(root, comps: comps, visited: []) {
                if selectedComp != nil, let id = selected?["id"] as? String { return ["clip": id] }
                return ["composition": root]
            }
            return nil
        }
        if category == .transition {
            if let selected, selected["transitionIn"] is [String: Any], visualKinds.contains(selected["kind"] as? String ?? ""), let id = selected["id"] as? String { return ["clip": id] }
            guard let root, comps[root] is [String: Any] else { return nil }
            if selectedComp != nil, let id = selected?["id"] as? String { return ["clip": id] }
            return ["composition": root]
        }
        if category == .effect {
            if !asComposition, let selected, let id = selected["id"] as? String, visualKinds.contains(selected["kind"] as? String ?? ""),
               !(selected["effects"] as? [[String: Any]] ?? []).isEmpty || selected["nodes"] is [String: Any] || !(selected["grade"] as? [String: Any] ?? [:]).isEmpty { return ["clip": id] }
            guard let root, comps[root] is [String: Any] else { return nil }
            if selectedComp != nil, let id = selected?["id"] as? String { return ["clip": id, "type": "composition"] }
            return ["composition": root]
        }
        guard let selected, let id = selected["id"] as? String else { return nil }
        let kind = selected["kind"] as? String ?? ""
        switch category {
        case .effect:
            guard visualKinds.contains(kind), !(selected["effects"] as? [[String: Any]] ?? []).isEmpty || selected["nodes"] is [String: Any] || !(selected["grade"] as? [String: Any] ?? [:]).isEmpty else { return nil }
        case .motion:
            let animation = selected["anim"] as? [String: Any] ?? [:]
            guard !animation.isEmpty, !animation.keys.contains(where: { $0.hasPrefix("mask.") || $0.hasPrefix("node.") }) else { return nil }
        default: return nil
        }
        return ["clip": id]
    }

    static func saveReason(_ category: NativeLibraryCategory) -> String {
        switch category {
        case .title: return "Select a title layer or a composition containing titles."
        case .composition: return "Open a composition or select a composition clip."
        case .effect: return "Select a layer with effects, nodes or a grade, or open or select an effect composition."
        case .transition: return "Select a clip with an incoming transition, or open or select an authored composition."
        case .motion: return "Select a layer with editable keyframes. Save mask or node animation in an effect or composition."
        }
    }

    static func applyReason(item: NativeLibraryItem, selected: [String: Any]?, tracks: [[String: Any]], fps: Double) -> String? {
        guard let category = item.category else { return "This component type is unsupported." }
        if item.placesObject {
            return tracks.contains { $0["kind"] as? String == "video" && $0["locked"] as? Bool != true } ? nil : "Add or unlock a video track to place this component."
        }
        guard let selected, let id = selected["id"] as? String else { return "Select a compatible layer to apply this component." }
        guard let track = tracks.first(where: { ($0["clips"] as? [[String: Any]] ?? []).contains { $0["id"] as? String == id } }) else { return "Select a layer in the open composition." }
        if track["locked"] as? Bool == true { return "Unlock the selected layer's track first." }
        let kind = selected["kind"] as? String ?? ""
        let settings = item.body["settings"] as? [String: Any] ?? [:]
        if category == .motion {
            let anim = settings["anim"] as? [String: Any] ?? [:]
            guard !anim.isEmpty else { return "This motion component has no keyframes." }
            let existing = selected["anim"] as? [String: Any] ?? [:]
            let expressions = selected["expr"] as? [String: Any] ?? [:]
            let conflicts = anim.keys.filter { existing[$0] != nil || expressions[$0] != nil }.sorted()
            if !conflicts.isEmpty { return "The selected layer already animates \(conflicts.joined(separator: ", "))." }
            if anim.keys.contains(where: { !motionProperty($0, fits: kind) }) { return "This motion uses properties unavailable on the selected layer." }
            return nil
        }
        guard visualKinds.contains(kind) else { return "Select a visual layer for this \(category.rawValue)." }
        if category == .transition {
            if selected["transitionIn"] != nil { return "The selected clip already has an incoming transition." }
            let start = (selected["start"] as? NSNumber)?.doubleValue ?? 0
            let previous = (track["clips"] as? [[String: Any]] ?? []).first { clip in
                guard clip["id"] as? String != id, visualKinds.contains(clip["kind"] as? String ?? "") else { return false }
                let end = ((clip["start"] as? NSNumber)?.doubleValue ?? 0) + ((clip["dur"] as? NSNumber)?.doubleValue ?? 0)
                return abs(end - start) < 0.0001
            }
            guard let previous else { return "Select a clip directly after another visual clip on its track." }
            if let duration = item.transitionCompositionDuration {
                let before = (previous["dur"] as? NSNumber)?.doubleValue ?? 0
                let after = (selected["dur"] as? NSNumber)?.doubleValue ?? 0
                if duration / 2 > min(before, after) + 0.0001 { return "Shorten the transition's source clip or composition to fit both sides of this cut." }
            }
        }
        return nil
    }

    private static func motionProperty(_ property: String, fits kind: String) -> Bool {
        if ["title.size", "title.tracking", "title.lineHeight"].contains(property) { return kind == "title" }
        if ["shape.width", "shape.height", "shape.radius", "shape.innerRadius", "shape.stroke.width", "shape.trim.start", "shape.trim.end", "shape.trim.offset"].contains(property) { return kind == "shape" }
        if property.hasPrefix("mask.") || property.hasPrefix("node.") { return false }
        if ["volume", "pan"].contains(property) { return ["audio", "video", "comp", "multicam"].contains(kind) }
        return ["x", "y", "scale", "scaleX", "scaleY", "rotation", "opacity", "anchorX", "anchorY", "blur"].contains(property) && (visualKinds.contains(kind) || kind == "null")
    }

    private static func containsTitle(_ id: String, comps: [String: Any], visited: Set<String>) -> Bool {
        guard !visited.contains(id), let comp = comps[id] as? [String: Any] else { return false }
        let clips = (comp["tracks"] as? [[String: Any]] ?? []).flatMap { $0["clips"] as? [[String: Any]] ?? [] }
        return clips.contains { clip in
            if clip["kind"] as? String == "title" { return true }
            guard clip["kind"] as? String == "comp", let nested = clip["comp"] as? String else { return false }
            return containsTitle(nested, comps: comps, visited: visited.union([id]))
        }
    }
}

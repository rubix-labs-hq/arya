import Darwin
import Foundation

/// An address for review. Offers never carry credentials or authorize a connection.
public struct CompanionPairingOffer: Equatable, Sendable {
    public static let maximumLinkBytes = 4_096
    public static let maximumEndpointBytes = 2_048
    public let endpoint: String

    public enum Failure: Error, LocalizedError, Equatable {
        case invalidLink, invalidEndpoint
        public var errorDescription: String? {
            switch self {
            case .invalidLink: return "This companion link is invalid. Use an endpoint-only reelcompanion offer with version 1, or enter the trusted owner's HTTPS address manually."
            case .invalidEndpoint: return "Use a reachable HTTPS root address with no credentials, query, fragment or loopback host. Confirm the full address with the person running the companion."
            }
        }
    }

    public init(endpoint: String) throws {
        guard !endpoint.isEmpty, endpoint.utf8.count <= Self.maximumEndpointBytes,
              endpoint.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
              endpoint.rangeOfCharacter(from: .controlCharacters) == nil,
              let rawHost = Self.rawEndpointHost(endpoint), Self.isReachableHostSyntax(rawHost),
              let url = URL(string: endpoint), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "https", parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.percentEncodedPath.isEmpty || parts.percentEncodedPath == "/",
              parts.port.map({ (1...65_535).contains($0) }) ?? true,
              let host = parts.host, Self.isReachableHostSyntax(host) else { throw Failure.invalidEndpoint }
        self.endpoint = try AssistantSharingScope.canonicalCompanion(url)
    }

    public init(link: URL) throws {
        guard link.absoluteString.utf8.count <= Self.maximumLinkBytes,
              let parts = URLComponents(url: link, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "reelcompanion", parts.percentEncodedHost == "offer",
              parts.percentEncodedPath.isEmpty, parts.user == nil, parts.password == nil,
              parts.port == nil, parts.fragment == nil,
              let items = parts.queryItems, items.count == 2,
              items.filter({ $0.name == "version" }).count == 1,
              items.filter({ $0.name == "endpoint" }).count == 1,
              items.first(where: { $0.name == "version" })?.value == "1",
              let endpoint = items.first(where: { $0.name == "endpoint" })?.value else { throw Failure.invalidLink }
        try self.init(endpoint: endpoint)
    }

    public var link: URL {
        var parts = URLComponents()
        parts.scheme = "reelcompanion"; parts.host = "offer"
        parts.queryItems = [URLQueryItem(name: "version", value: "1"), URLQueryItem(name: "endpoint", value: endpoint)]
        // Only validated bounded ASCII host syntax and URL query encoding reach this builder.
        return parts.url!
    }

    /// Check original text before Foundation can normalize numeric or encoded host forms.
    private static func rawEndpointHost(_ endpoint: String) -> String? {
        guard endpoint.unicodeScalars.allSatisfy({ $0.value < 128 }), endpoint.prefix(8).lowercased() == "https://" else { return nil }
        var authority = String(endpoint.dropFirst(8))
        if authority.hasSuffix("/") { authority.removeLast() }
        guard !authority.isEmpty, !authority.contains("/"), !authority.contains("\\"),
              !authority.contains("@"), !authority.contains("%"), !authority.contains("?"), !authority.contains("#") else { return nil }
        if authority.hasPrefix("[") {
            guard let closing = authority.firstIndex(of: "]") else { return nil }
            let host = String(authority[...closing])
            let suffix = String(authority[authority.index(after: closing)...])
            guard host.dropFirst().dropLast().contains(":"),
                  suffix.isEmpty || suffix.hasPrefix(":") && validRawPort(String(suffix.dropFirst())) else { return nil }
            return host
        }
        guard !authority.contains("["), !authority.contains("]") else { return nil }
        let fields = authority.split(separator: ":", omittingEmptySubsequences: false)
        guard (1...2).contains(fields.count), !fields[0].isEmpty,
              fields.count == 1 || validRawPort(String(fields[1])) else { return nil }
        return String(fields[0])
    }

    private static func validRawPort(_ port: String) -> Bool {
        guard !port.isEmpty, port.utf8.count <= 5, !port.hasPrefix("0"),
              port.utf8.allSatisfy({ (48...57).contains($0) }), let value = Int(port) else { return false }
        return (1...65_535).contains(value)
    }

    private static func isStrictIPv4Syntax(_ host: String) -> Bool {
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        return octets.count == 4 && octets.allSatisfy { octet in
            guard !octet.isEmpty, octet.utf8.count <= 3, octet == "0" || octet.first != "0",
                  octet.utf8.allSatisfy({ (48...57).contains($0) }), let value = Int(octet) else { return false }
            return value <= 255
        }
    }

    private static func isReachableHostSyntax(_ original: String) -> Bool {
        var host = original.lowercased()
        if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        guard !host.isEmpty, !host.contains("%"), host != "localhost", !host.hasPrefix("localhost."), !host.hasSuffix(".localhost") else { return false }
        var v4 = in_addr()
        if isStrictIPv4Syntax(host), host.withCString({ inet_pton(AF_INET, $0, &v4) }) == 1 {
            let address = UInt32(bigEndian: v4.s_addr)
            return address >> 24 != 0 && address >> 24 != 127
        }
        var numericAlias = in_addr()
        if host.withCString({ inet_aton($0, &numericAlias) }) != 0 { return false }
        if host.contains(":"), host.contains(".") {
            guard let tail = host.split(separator: ":").last, isStrictIPv4Syntax(String(tail)) else { return false }
        }
        var v6 = in6_addr()
        if host.withCString({ inet_pton(AF_INET6, $0, &v6) }) == 1 {
            let bytes = withUnsafeBytes(of: v6) { Array($0) }
            let zeroPrefix = bytes.prefix(15).allSatisfy { $0 == 0 }
            if zeroPrefix && (bytes[15] == 0 || bytes[15] == 1) { return false }
            if bytes.prefix(10).allSatisfy({ $0 == 0 }), bytes[10] == 255, bytes[11] == 255 {
                return bytes[12] != 0 && bytes[12] != 127
            }
            if bytes.prefix(12).allSatisfy({ $0 == 0 }), bytes[12] == 127 { return false }
            return true
        }
        // Reject ambiguous numeric aliases instead of treating them as DNS names.
        if host.hasSuffix(".") {
            host.removeLast()
            if host.withCString({ inet_aton($0, &numericAlias) }) != 0 { return false }
        }
        guard host != "localhost", !host.hasSuffix(".localhost") else { return false }
        guard !host.contains(":"), !host.hasPrefix("0x"),
              !host.allSatisfy({ $0.isNumber || $0 == "." }), host.utf8.count <= 253 else { return false }
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-.")
        guard host.unicodeScalars.allSatisfy({ $0.value < 128 && allowed.contains($0) }) else { return false }
        return host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
            !label.isEmpty && label.utf8.count <= 63 && label.first != "-" && label.last != "-"
        }
    }
}

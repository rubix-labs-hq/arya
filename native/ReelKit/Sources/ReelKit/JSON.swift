import Foundation

/// A JSON value that keeps object keys in order and can embed text that is already JSON
/// (the project, which the JavaScript core serializes) without parsing it again.
public indirect enum JSON: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSON])
    case object([(String, JSON)])
    /// Text that is already valid JSON, written out as is.
    case raw(String)

    public static func == (lhs: JSON, rhs: JSON) -> Bool { lhs.text == rhs.text }

    /// Compact JSON text.
    public var text: String {
        var out = ""
        write(to: &out)
        return out
    }

    private func write(to out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .number(let n): out += JSON.format(n)
        case .string(let s): JSON.quote(s, into: &out)
        case .raw(let r): out += r
        case .array(let items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                item.write(to: &out)
            }
            out += "]"
        case .object(let pairs):
            out += "{"
            for (i, (key, value)) in pairs.enumerated() {
                if i > 0 { out += "," }
                JSON.quote(key, into: &out)
                out += ":"
                value.write(to: &out)
            }
            out += "}"
        }
    }

    /// Numbers the way JavaScript prints them: integers without a fraction, others shortest.
    static func format(_ n: Double) -> String {
        guard n.isFinite else { return "null" }
        if n == n.rounded(), abs(n) < 1e15 { return String(Int64(n)) }
        return "\(n)"
    }

    static func quote(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }

    /// Converts a JSONSerialization result (or any NSDictionary/NSArray tree) to JSON.
    public init(any value: Any?) {
        switch value {
        case nil, is NSNull: self = .null
        case let json as JSON: self = json
        case let s as String: self = .string(s)
        case let n as NSNumber:
            self = CFGetTypeID(n) == CFBooleanGetTypeID() ? .bool(n.boolValue) : .number(n.doubleValue)
        case let a as [Any]: self = .array(a.map { JSON(any: $0) })
        case let d as [String: Any]: self = .object(d.keys.sorted().map { ($0, JSON(any: d[$0])) })
        default: self = .string(String(describing: value!))
        }
    }

    /// Parses JSON text into Foundation objects (dictionaries, arrays, NSNumber, String, NSNull).
    public static func parse(_ text: String) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
    }

    /// An object from pairs, dropping keys whose value is nil (like `undefined` in JavaScript).
    public static func compact(_ pairs: [(String, JSON?)]) -> JSON {
        .object(pairs.compactMap { key, value in value.map { (key, $0) } })
    }
}

extension JSON: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral, ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
    public init(integerLiteral value: Int) { self = .number(Double(value)) }
    public init(floatLiteral value: Double) { self = .number(value) }
    public init(booleanLiteral value: Bool) { self = .bool(value) }
    public init(arrayLiteral elements: JSON...) { self = .array(elements) }
    public init(nilLiteral: ()) { self = .null }
}

extension JSON {
    public static func int(_ n: Int) -> JSON { .number(Double(n)) }
    public static func num(_ n: Double?) -> JSON? { n.map { .number($0) } }
    public static func str(_ s: String?) -> JSON? { s.map { .string($0) } }
}

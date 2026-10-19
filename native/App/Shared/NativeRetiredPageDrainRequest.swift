import CoreFoundation
import Foundation

/// A retired bridge session may acknowledge cleanup only. The session replaces
/// its error with a closed-project error before sending it to its retained backend.
struct NativeRetiredPageDrainRequest {
    let session: String
    let jobID: String
    static func parse(_ message: [String: Any]) -> NativeRetiredPageDrainRequest? {
        guard message["type"] as? String == "request", (message["method"] as? String)?.uppercased() == "POST",
              message["path"] as? String == "/api/export/finish",
              let session = message["session"] as? String, !session.isEmpty, session.utf8.count <= 128 else { return nil }
        let fields: [String: Any]
        if let text = message["body"] as? String {
            guard text.utf8.count <= 4096, let data = text.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data), let value = object as? [String: Any] else { return nil }
            fields = value
        } else if let value = message["body"] as? [String: Any] { fields = value }
        else { return nil }
        guard Set(fields.keys).isSubset(of: ["id", "drained", "error"]),
              let id = fields["id"] as? String, !id.isEmpty, id.utf8.count <= 128,
              let drained = fields["drained"] as? NSNumber, CFGetTypeID(drained) == CFBooleanGetTypeID(), drained.boolValue else { return nil }
        if let value = fields["error"] {
            guard let text = value as? String, text.utf8.count <= 2048 else { return nil }
        }
        return NativeRetiredPageDrainRequest(session: session, jobID: id)
    }
}

#!/usr/bin/env python3
"""Execute the native batch dispatch method with delayed task scheduling."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
model = (root / 'native/App/Shared/NativeEditor/NativeEditorModel.swift').read_text()
start = model.index('    func editBatch(')
begin = model.index('{', start)
end, depth = begin + 1, 1
while depth:
    depth += (model[end] == '{') - (model[end] == '}')
    end += 1
method = model[start:end]
haptics = model.split('// BEGIN HAPTIC POLICY\n', 1)[1].split('// END HAPTIC POLICY', 1)[0]
source = '''import Foundation
''' + haptics + '''
struct ReelBackend { struct APIError: Error { init(_ text: String) {} } }
struct NativeProject { let fields: [String: Any] }
@MainActor final class Model {
    var folder: URL? = URL(fileURLWithPath: "/source")
    var composition: String? = "nested"
    var version = 7
    var generation = UUID()
    var project: NativeProject?
    var haptics: [NativeHapticKind?] = []
    func emitHaptic(_ kind: NativeHapticKind?) { haptics.append(kind) }
    var pending: [@MainActor () async throws -> Void] = []
    var requests: [[String: Any]] = []
    func perform(_ action: @escaping @MainActor () async throws -> Void) { pending.append(action) }
    func call(_ path: String, _ body: [String: Any]) async throws -> [String: Any] { requests.append(body); return [:] }
''' + method + '''
}
@main struct Check {
    @MainActor static func main() async throws {
        let model = Model()
        model.editBatch([["op":"move","id":"a"], ["op":"move","id":"b"]], summary: "Move selected", expectedVersion: 7)
        try await model.pending.removeFirst()()
        precondition(model.requests.count == 1)
        let body = model.requests[0]
        precondition(body["expectedVersion"] as? Int == 7 && body["summary"] as? String == "Move selected")
        let operations = body["ops"] as! [[String: Any]]
        precondition(operations.count == 2 && operations.allSatisfy { $0["comp"] as? String == "nested" })
        for axis in 0..<3 {
            model.requests = []; model.folder = URL(fileURLWithPath: "/source"); model.composition = "nested"; model.version = 7
            model.editBatch([["op":"move","id":"a"]], expectedVersion: 7)
            if axis == 0 { model.folder = URL(fileURLWithPath: "/replacement") }
            if axis == 1 { model.composition = "other" }
            if axis == 2 { model.version = 8 }
            do { try await model.pending.removeFirst()(); fatalError("Stale edit dispatched") } catch { }
            precondition(model.requests.isEmpty)
        }
        model.editBatch([])
        precondition(model.pending.isEmpty)
        precondition(model.haptics.isEmpty)
        print("Passed captured composition/version dispatch and three delayed stale-state rejections.")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='reel-source-dispatch-') as temporary:
    folder = Path(temporary)
    swift = folder / 'main.swift'
    swift.write_text(source)
    binary = folder / 'check'
    subprocess.run(['swiftc', '-parse-as-library', '-module-cache-path', str(folder / 'cache'), str(swift), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True)

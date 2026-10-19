#!/usr/bin/env python3
"""Run the production session dispatcher with suspended provider handlers."""
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
source = (root / 'native/App/Shared/EditorSession.swift').read_text()
start = source.index('    func request(method:')
begin = source.index('{', start)
end, depth = begin + 1, 1
while depth:
    depth += (source[end] == '{') - (source[end] == '}')
    end += 1
method = source[start:end]
swift = '''import Foundation
@MainActor class Provider {
    var delay: (() async -> Void)?
    var chat: [JSON] = []
    var claude: JSON { .object([]) }
    var chatHistoryStatus: JSON { .object([]) }
    var configured = true
    var snapshot: JSON { .object([]) }
    func handle(method: String, path: String, body: String?) async throws -> JSON? { await delay?(); return nil }
}
@MainActor final class ReelBackend {
    struct APIError: Error { init(_ text: String) {} }
    var calls = 0
    var delay: (() async -> Void)?
    func handle(method: String, path: String, body: String?) async throws -> JSON { calls += 1; await delay?(); return .object([]) }
}
@MainActor final class Session {
    var backend: ReelBackend?
    let assistant = Provider(), figma = Provider()
''' + method + '''
}
@main struct Check {
    @MainActor static func main() async throws {
        for phase in 0..<2 {
            let session = Session(), original = ReelBackend(), replacement = ReelBackend()
            session.backend = original
            if phase == 0 { session.assistant.delay = { session.backend = replacement } }
            else { session.figma.delay = { session.backend = replacement } }
            do { _ = try await session.request(method:"POST",path:"/api/ops",body:"{}"); fatalError("A changed backend accepted dispatch") } catch is CancellationError { }
            precondition(original.calls == 0 && replacement.calls == 0)
        }
        let session = Session(), original = ReelBackend(), replacement = ReelBackend()
        session.backend = original
        original.delay = { session.backend = replacement }
        do { _ = try await session.request(method:"GET",path:"/api/project",body:nil); fatalError("An old backend result was published") } catch is CancellationError { }
        precondition(original.calls == 1 && replacement.calls == 0)
        session.backend = replacement
        _ = try await session.request(method:"POST",path:"/api/ops",body:"{}")
        precondition(replacement.calls == 1)
        print("Passed suspended assistant/Figma dispatch guards, old-result rejection and normal dispatch.")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='reel-session-dispatch-') as temporary:
    folder = Path(temporary)
    input = folder / 'main.swift'
    input.write_text(swift)
    binary = folder / 'check'
    subprocess.run(['swiftc','-parse-as-library','-module-cache-path',str(folder/'cache'),str(root/'native/ReelKit/Sources/ReelKit/JSON.swift'),str(input),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)

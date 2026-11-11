#!/usr/bin/env python3
"""Execute the app's model-refresh method against a delayed account switch."""
import argparse
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument('--negative-control', action='store_true')
args = parser.parse_args()
source = (args.source_root / 'native/App/Shared/NativeAssistant.swift').read_text()
start = source.index('    func refreshModels() async {', source.index('final class NativeChatGPTAccount'))
end = source.index('\n    func signIn(', start)
method = source[start:end]
if args.negative_control:
    opening = method.index('        defer {')
    closing = method.index('\n        do {', opening)
    method = method[:opening] + '        defer { loadingModels = false }' + method[closing:]

harness = '''import Foundation
struct Model: Equatable { let name: String }
struct Status { var identity: String?; var planUsage = true }
enum NativeChatGPT { static let supported = true }
@MainActor final class Service {
    var calls = 0
    var pending: [CheckedContinuation<[Model], Error>] = []
    func models() async throws -> [Model] {
        calls += 1
        return try await withCheckedThrowingContinuation { pending.append($0) }
    }
    func resolve(_ value: String) { pending.removeFirst().resume(returning: [Model(name: value)]) }
}
@MainActor final class Account {
    let service = Service()
    var status = Status(identity: "first")
    var models: [Model] = []
    var modelsError: String?
    var loadingModels = false
METHOD
}
@main struct Test {
    @MainActor static func wait(_ condition: () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(2)
        while !condition() && Date() < deadline { try? await Task.sleep(nanoseconds: 1_000_000) }
        return condition()
    }
    @MainActor static func main() async {
        let account = Account()
        let initial = Task { await account.refreshModels() }
        guard await wait({ account.service.calls == 1 }) else { fatalError("first request did not start") }
        account.status.identity = "second"
        account.models = []
        await account.refreshModels() // same path used by sync() while the first request waits
        account.service.resolve("stale")
        await initial.value
        guard await wait({ account.service.calls == 2 }) else {
            print("FAIL: account switch never loaded the current model list")
            exit(1)
        }
        guard account.models.isEmpty else { fatalError("stale model list was published") }
        account.service.resolve("current")
        guard await wait({ account.models == [Model(name: "current")] && !account.loadingModels }) else {
            fatalError("current model list was not published")
        }
        let signOut = Account()
        let pending = Task { await signOut.refreshModels() }
        guard await wait({ signOut.service.calls == 1 }) else { fatalError("signout setup failed") }
        signOut.status = Status(identity: nil, planUsage: false)
        signOut.service.resolve("signed-out")
        await pending.value
        try? await Task.sleep(nanoseconds: 20_000_000)
        guard signOut.models.isEmpty && signOut.service.calls == 1 && !signOut.loadingModels else {
            fatalError("signout published models or restarted a request")
        }
        print("PASS: current account reloads after an in-flight switch; stale results and signed-out retries are rejected")
    }
}
'''.replace('METHOD', method)
with tempfile.TemporaryDirectory(prefix='arya-chatgpt-model-refresh-') as temporary:
    root = Path(temporary)
    script, executable = root / 'Test.swift', root / 'test'
    script.write_text(harness)
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library', str(script), '-o', str(executable)], check=True)
    result = subprocess.run([str(executable)], check=False)
    if args.negative_control:
        if result.returncode != 1:
            raise SystemExit('Negative control did not reproduce the missing-model failure')
        print('PASS: negative control reproduced the missing-model failure')
    elif result.returncode:
        raise SystemExit(result.returncode)

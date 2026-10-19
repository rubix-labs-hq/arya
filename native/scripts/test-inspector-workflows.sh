#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NATIVE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/reel-inspector-workflows.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
printf 'import Foundation\n' > "$TEST_DIR/NativeInspectorWorkflow.swift"
awk '/^\/\/ BEGIN INSPECTOR WORKFLOW/ { copy = 1; next } /^\/\/ END INSPECTOR WORKFLOW/ { copy = 0 } copy' \
    "$NATIVE_DIR/App/Shared/NativeEditor/NativeInspector.swift" >> "$TEST_DIR/NativeInspectorWorkflow.swift"
cp "$SCRIPT_DIR/inspector-workflow-tests.swift" "$TEST_DIR/main.swift"
swiftc -module-cache-path "$TEST_DIR/module-cache" "$TEST_DIR/NativeInspectorWorkflow.swift" "$TEST_DIR/main.swift" -o "$TEST_DIR/inspector-workflow-tests"
"$TEST_DIR/inspector-workflow-tests" "$TEST_DIR/plans.json"
node "$SCRIPT_DIR/inspector-workflow-core-tests.mjs" "$TEST_DIR/plans.json"
python3 - "$NATIVE_DIR" "$TEST_DIR" <<'PY'
from pathlib import Path
import subprocess
import sys

native, scratch = map(Path, sys.argv[1:])
editor = native / "App/Shared/NativeEditor"
kit = native / "ReelKit/Sources/ReelKit"
model = (editor / "NativeEditorModel.swift").read_text()
inspector = (editor / "NativeInspector.swift").read_text()
project = (editor / "NativeProject.swift").read_text()
tests = (native / "scripts/inspector-workflow-tests.swift").read_text()

def block(source, marker):
    start = source.index(marker)
    end = source.index("{", start) + 1
    depth = 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]

# Keep the production capture, file identity, queue and results controller method.
# The fixture records dispatch and supplies project projections without SwiftUI.
workflow = inspector.split("// BEGIN INSPECTOR WORKFLOW\n")[1].split("// END INSPECTOR WORKFLOW")[0]
adapters = "\n".join(block(inspector, marker) for marker in [
    "private func NativeInspectorFile(", "extension NativeInspectorWorkflow.Capture {", "enum NativeInspectorNavigation {"]) + "\n"
projections = project[project.index("struct NativeProject {"):project.index("enum NativeProcessingRequests {")]
controller_tests = tests.split("// BEGIN INSPECTOR CONTROLLER CHECKS\n")[1].split("// END INSPECTOR CONTROLLER CHECKS")[0]
source = "import Foundation\nimport Darwin\n" + (kit / "JSON.swift").read_text() + "\n" + projections
source += "\n" + block(project, "extension Dictionary where Key == String, Value == Any")
source += "\n" + workflow + "\n" + block(model, "struct NativeSourceFileIdentity:")
source += r'''
enum ReelBackend {
    struct APIError: LocalizedError {
        let message: String
        init(_ message: String) { self.message = message }
        var errorDescription: String? { message }
    }
}
@MainActor final class SessionFixture { var error: String? }
@MainActor final class NativeEditorModel {
    struct Call { let path: String; let body: [String: Any] }
    var project: NativeProject?
    var folder: URL?
    var composition: String?
    var version = 4
    var selectedID: String? = "c1"
    var generation = UUID()
    var status = ""
    var session: SessionFixture? = SessionFixture()
    var calls: [Call] = []
    var callError: Error?
    var tracks: [NativeTrack] { project?.tracks(in: composition) ?? [] }
    func mediaURL(_ source: String) throws -> URL { folder!.appendingPathComponent(source) }
    func call(_ path: String, _ body: [String: Any]?) async throws -> [String: Any] {
        calls.append(.init(path: path, body: body ?? [:]))
        if let callError { throw callError }
        return [:]
    }
'''
source += block(model, "    func perform(") + "\n}\n" + adapters
source += r'''
@MainActor final class ResultsAdapter {
    let model: NativeEditorModel
    let capture: NativeInspectorWorkflow.Capture
    var selected: Set<Int> = [0]
    var error = ""
    var results = NativeInspectorWorkflow.Results(events: [.init(id: 0, source: 4, end: nil, label: "Scene")], total: 1, truncated: false)
    init(_ model: NativeEditorModel, _ capture: NativeInspectorWorkflow.Capture) { self.model = model; self.capture = capture }
'''
source += block(inspector, "    private func apply(split: Bool)").replace("private func apply", "func apply")
source += "\n}\n" + controller_tests
swift = scratch / "InspectorControllerChecks.swift"
swift.write_text(source)
binary = scratch / "inspector-controller-checks"
subprocess.run(["swiftc", "-parse-as-library", "-module-cache-path", str(scratch / "module-cache"), str(swift), "-o", str(binary)], check=True)
subprocess.run([str(binary), str(scratch)], check=True)
PY

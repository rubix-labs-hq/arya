#!/usr/bin/env python3
"""Run the app's helper installer, then import its installed companion in Node."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[2])
root = parser.parse_args().source_root.resolve()
controller = (root / "native/App/Shared/NativeAssistant.swift").read_text()


def block(marker):
    start = controller.index(marker)
    end = controller.index("{", start) + 1
    depth = 1
    while depth:
        depth += (controller[end] == "{") - (controller[end] == "}")
        end += 1
    return controller[start:end]


node = os.environ.get("NODE") or shutil.which("node")
if not node:
    raise SystemExit("Node.js is required to verify installed companion startup")

with tempfile.TemporaryDirectory(prefix="arya-agent-helper-") as directory:
    scratch = Path(directory)
    swift = scratch / "main.swift"
    # The fixtures supply only the project-folder and session dependencies. The copy
    # loop and runtime-launcher substitution are the app's actual Swift methods.
    swift.write_text('''import Foundation
struct ProjectFolder {
    let root: URL
    func output(_ path: String) throws -> URL {
        path.hasPrefix("/") ? URL(fileURLWithPath: path) : root.appendingPathComponent(path)
    }
}
enum AgentBridge { enum Failure: Error { case unavailable } }
struct Editor { let root: URL }
struct Session { let editor: Editor }
final class Controller {
    let session: Session? = Session(editor: Editor(root: URL(fileURLWithPath: CommandLine.arguments[1])))
    func prepareAgentDirectory() throws -> (ProjectFolder, URL) {
        let folder = ProjectFolder(root: URL(fileURLWithPath: CommandLine.arguments[2]))
        let directory = try folder.output("Reel/AgentBridge")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return (folder, directory)
    }
''' + block("    private static func shellLiteral(") + "\n" +
                     block("    private func installAgentHelper(") + '''
    func install() throws { _ = try installAgentHelper(runtime: URL(fileURLWithPath: CommandLine.arguments[3])) }
}
try Controller().install()
''')
    binary = scratch / "installer"
    subprocess.run(["swiftc", "-module-cache-path", str(scratch / "cache"),
                    str(swift), "-o", str(binary)], check=True)
    subprocess.run([str(binary), str(root / "editor"), str(scratch / "support"), node], check=True)
    helper = scratch / "support/Reel/AgentBridge/bridge.mjs"
    # Import the complete real dependency graph. Importing does not start a bridge,
    # probe provider accounts or read credentials. A missing adapter fails here.
    subprocess.run([node, "--input-type=module", "-e",
                    "const {startBridge} = await import(process.argv[1]); "
                    "if (typeof startBridge !== 'function') throw Error('Missing companion entry point')",
                    helper.as_uri()], check=True)
    print("PASS: the native installer produces an importable companion dependency graph")

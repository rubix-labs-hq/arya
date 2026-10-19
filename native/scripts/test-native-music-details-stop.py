#!/usr/bin/env python3
"""Compile the exact music-details task owner with deterministic request adapters."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--source-root", type=Path, required=True)
parser.add_argument("--output-dir", type=Path, required=True)
args = parser.parse_args()
product = args.source_root / "native/App/Shared/NativeEditor/NativeMediaPanel.swift"
fixture = Path(__file__).with_name("music-details-stop-tests.swift")
text = product.read_text()
start = "    private func startMusicAction("
end = "    private func run(revise: Bool) {"
assert text.count(start) == text.count(end) == 1, "Missing or ambiguous production task owner"
methods = text[text.index(start):text.index(end)].replace("private func ", "func ")
assert methods.count("musicTask.cancel()") == 1
run = text[text.index(end):text.index("private struct NativeGeneratedMediaTouchTarget:")]
assert "startMusicAction {" in run and "model.perform {" not in run
assert run.count("try Task.checkCancellation()") == 2
assert '.interactiveDismissDisabled(composing)' in text
assert '.onDisappear { stopMusic() }' in text
assert 'Button("Done") { dismiss() }.disabled(composing)' in text
assert 'Button(stoppingMusic ? "Stopping…" : "Stop") { stopMusic() }' in text
assert '.disabled(stoppingMusic)' in text
source = fixture.read_text()
assert source.count("// INSERT PRODUCTION MUSIC TASK METHODS") == 1
source = source.replace("// INSERT PRODUCTION MUSIC TASK METHODS", methods)
args.output_dir.mkdir(parents=True, exist_ok=False)
(args.output_dir / "source-binding.json").write_text(json.dumps({
    "product": str(product.resolve()), "productSHA256": hashlib.sha256(product.read_bytes()).hexdigest(),
    "fixtureSHA256": hashlib.sha256(fixture.read_bytes()).hexdigest(),
    "extractedMethodsSHA256": hashlib.sha256(methods.encode()).hexdigest(),
    "scope": "Production task ownership methods; scripted request completion, not SwiftUI or a backend render."
}, indent=2) + "\n")
generated = args.output_dir / "MusicDetailsStopTests.swift"
generated.write_text(source)
binary = args.output_dir / "music-details-stop-tests"
commands = [["/usr/bin/swiftc", "-parse-as-library", "-swift-version", "5", "-j1", "-num-threads", "1", str(generated), "-o", str(binary)], [str(binary)]]
for name, command in zip(["compile", "tests"], commands):
    with (args.output_dir / (name + ".stdout.log")).open("xb") as stdout, (args.output_dir / (name + ".stderr.log")).open("xb") as stderr:
        result = subprocess.run(command, stdout=stdout, stderr=stderr, check=False)
    (args.output_dir / (name + ".result.json")).write_text(json.dumps({"argv": command, "exitCode": result.returncode}, indent=2) + "\n")
    if result.returncode != 0:
        raise SystemExit(result.returncode)
print("PASS: exact production music-details ownership methods; eight behavior cases and source wiring checks")

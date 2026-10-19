#!/usr/bin/env python3
"""App-only receipt wiring and cancellation preservation; does not execute Swift."""
import argparse
import hashlib
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument("--base-root", type=Path)
args = parser.parse_args()
relative = Path("native/App/Shared/NativeAssistant.swift")
controller = (args.source_root / relative).read_text()
base = (args.base_root / relative).read_text() if args.base_root else None

def section(source, start, end):
    return source[source.index(start):source.index(end, source.index(start))]

# The release gate runs this without --base-root in a copy that has no .git. These SHA-256
# values pin each section as it stood in the reviewed lane base
# (build/arya-native-music-outcomes-followup/base, gitignored).
BASE_SECTIONS = {
    ("    func cancel()", "    private func cancelOwnedJobs"): "ac69f502cc11bf9eea2d059ddc2fe483d4888444d924c8ca77d69ab42a5b2af3",
    ("    private func cancelOwnedJobs", "    /// Call when a project closes"): "c3bc69e669205d991ad30ce26866c847e4bca15c2ab50bec784863e8c31e54b8",
    ('        if method == "POST", ["/api/export"', "        let result: JSON"): "e43c3c4b7560758dfa8aa07c682f41c46aae0c4046d4b1fda432a02d69c1d61d",
    ("    private func retireFinishedJobs", "    private func capture"): "6f49e1dc0cb88c9052d5393f98fdb462279716196e6c8d4e40f9a0511490f5b5",
}

# The one line added to cancel() after the lane base. It records whether the stop was confirmed
# so /api/assistant/sharing/revoke can report stopUnconfirmed; it does not change cancellation.
STOP_RESULT = "            self.lastStopResult = (id, !failed && !self.stopHadFailure)\n"

def unchanged(start, end):
    current = section(controller, start, end)
    if start == "    func cancel()":
        assert current.count(STOP_RESULT) == 1, "cancel() must record lastStopResult exactly once"
        current = current.replace(STOP_RESULT, "", 1)
    if base is not None:
        return current == section(base, start, end)
    return hashlib.sha256(current.encode()).hexdigest() == BASE_SECTIONS[(start, end)]

assert "private var toolOutcomes = AssistantToolOutcomes()" in controller
assert controller.count("toolOutcomes = AssistantToolOutcomes()") == 3, "initialize/reset/request scopes must clear old receipts"
assert "self.toolOutcomes.completionMessage(failedJobCount: failedJobs.count, projectChanged: finalVersion != initialVersion)" in controller
assert 'if method == "POST", ["/api/audio/compose", "/api/audio/compose/place"].contains(route)' in controller
assert "toolOutcomes.record(method: method, path: route, body: request, result: fields)" in controller
tool = section(controller, "    private func runTool(", "    private func boundedTranscriptResult")
assert tool.index("try Task.checkCancellation()", tool.index("let result: JSON")) < tool.index("toolOutcomes.record")
assert tool.index("guard session.backend === backend", tool.index("let result: JSON")) < tool.index("toolOutcomes.record")
assert unchanged("    func cancel()", "    private func cancelOwnedJobs"), "job cancellation changed from the reviewed base; pass --base-root to diff"
assert unchanged("    private func cancelOwnedJobs", "    /// Call when a project closes"), "owned job cancellation changed from the reviewed base; pass --base-root to diff"
assert unchanged('        if method == "POST", ["/api/export"', "        let result: JSON"), "job admission changed from the reviewed base; pass --base-root to diff"
assert unchanged("    private func retireFinishedJobs", "    private func capture"), "job retirement changed from the reviewed base; pass --base-root to diff"
print("PASS: 11 app-only source contracts. Existing job cancellation/admission/retirement code is unchanged apart from the lastStopResult record. Swift helper and actual backend XCTest cases are NOT executed.")

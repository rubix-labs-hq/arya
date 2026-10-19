#!/usr/bin/env python3
"""Compile recent-project presentation and the complete production bookmark store.

Exact duplicate saved identities collapse. Unavailable storage retains its bookmark
for retry, and reachable moved folders refresh their saved path.
"""
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "native/App/Shared/EditorView.swift"
BOOKMARKS = ROOT / "native/App/Shared/ProjectBookmarks.swift"

HARNESS = r'''
import Foundation

enum ProjectBookmarks {
    struct Recent: Identifiable, Equatable { let id: String; let name: String; let path: String; let data: Data }
    // SURVIVAL
}

func recent(_ path: String, _ bookmark: UInt8) -> ProjectBookmarks.Recent {
    ProjectBookmarks.Recent(id: path, name: (path as NSString).lastPathComponent, path: path, data: Data([bookmark]))
}

var failures = 0
func check(_ condition: Bool, _ message: String) { if !condition { failures += 1; print("FAIL", message) } else { print("ok  ", message) } }

let a = "8E004320-C012-44BB-9081-B191335993D0", b = "C898053F-4670-47B8-B395-01D637D62109", c = "52A5E4CF-59FE-40A9-8862-2BDB75FC13A4"
let list = [
    recent("/private/var/mobile/Containers/Data/Application/\(a)/Documents/Projects/Arya 1202 Import QA", 1),
    recent("/private/var/mobile/Containers/Data/Application/\(b)/Documents/Projects/Arya 1202 Import QA", 2),
    recent("/var/mobile/Containers/Data/Application/\(c)/Documents/Projects/Arya 1202 Import QA", 3),
    recent("/var/mobile/Containers/Data/Application/\(c)/Documents/Projects/Other", 4),
    recent("/var/mobile/Containers/Data/Application/\(c)/Documents/Shared/Same", 7),
    recent("/var/mobile/Containers/Data/Application/\(a)/Documents/Shared/Same", 8),
    recent("/private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/Downloads/Flo", 5),
    recent("/private/var/mobile/Library/Mobile Documents/com~apple~CloudDocs/Downloads/Flo", 6),
]
let mobile = NativeRecentProjectPresentation.visible(list, mobile: true)
check(mobile.filter { $0.name == "Arya 1202 Import QA" }.count == 3, "Projects entries keep separate bookmarks across containers")
check(mobile.first?.data == Data([1]), "the newest entry stays first for opening")
check(mobile.contains { $0.name == "Other" }, "a different project in app Documents still shows")
check(mobile.filter { $0.name == "Flo" }.count == 2, "outside app Documents, different bookmarks stay separate")
check(mobile.filter { $0.name == "Same" }.count == 2, "folders outside Arya's Documents/Projects keep their own identity")
let collapsed = NativeRecentProjectPresentation.visible([list[0], list[0]], mobile: true)
check(collapsed.count == 1, "exact path and bookmark duplicates still collapse")
let desktop = NativeRecentProjectPresentation.visible(list, mobile: false)
check(desktop.count == list.count, "the Mac list keeps its exact path and bookmark identity")

let kept = recent("/tmp/alive", 9), gone = recent("/tmp/gone", 10), moved = recent("/tmp/old-name", 11)
let survivors = ProjectBookmarks.surviving([kept, gone, moved]) { entry in
    if entry.path == "/tmp/gone" { return nil }
    if entry.path == "/tmp/old-name" { return (URL(fileURLWithPath: "/tmp/new-name", isDirectory: true), Data([12])) }
    return (URL(fileURLWithPath: entry.path, isDirectory: true), entry.data)
}
check(survivors.map(\.path) == ["/tmp/alive", "/tmp/gone", "/tmp/new-name"], "unavailable folders survive and moved folders refresh their path")
check(survivors[1] == gone, "unavailable storage keeps its complete saved bookmark for retry")
check(survivors.last?.data == Data([12]), "moved folders keep refreshed bookmark bytes")
check(survivors.last?.name == "new-name", "moved folders refresh their display name")
exit(failures == 0 ? 0 : 1)
'''


def extract(text, start, end):
    if text.count(start) != 1 or text.count(end) != 1:
        raise SystemExit(f"{start} markers not found exactly once")
    return text[text.index(start):text.index(end) + len(end)]


def main():
    presentation = extract(SOURCE.read_text(), "// BEGIN RECENT PROJECT PRESENTATION", "// END RECENT PROJECT PRESENTATION")
    survival = extract(BOOKMARKS.read_text(), "// BEGIN RECENT PROJECT SURVIVAL", "// END RECENT PROJECT SURVIVAL")
    survival_body = "\n".join(
        line for line in survival.splitlines()
        if not line.strip().startswith("// BEGIN") and not line.strip().startswith("// END")
    )
    bookmark_source = BOOKMARKS.read_text()
    refresh_body = bookmark_source.split("static func refresh()", 1)[1].split("// BEGIN RECENT PROJECT SURVIVAL", 1)[0]
    if "#if os(macOS)" in refresh_body or "startAccessingSecurityScopedResource()" not in refresh_body or "stopAccessingSecurityScopedResource()" not in refresh_body:
        raise SystemExit("Bookmark refresh must balance security scope on both Mac and iOS")
    with tempfile.TemporaryDirectory(prefix="arya-recents-") as folder:
        program = Path(folder) / "main.swift"
        source = HARNESS.replace("import Foundation\n", "import Foundation\n" + presentation + "\n", 1)
        source = source.replace("    // SURVIVAL\n", survival_body + "\n")
        program.write_text(source)
        binary = Path(folder) / "recents"
        subprocess.run(["swiftc", "-O", str(program), "-o", str(binary)], check=True, timeout=600)
        subprocess.run([str(binary)], timeout=60, check=True)
        # Compile the complete production store, not only its presentation projection.
        store = Path(folder) / "ProjectBookmarks.swift"
        store.write_text(BOOKMARKS.read_text())
        program.write_text(r'''
import Foundation
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let gone = root.appendingPathComponent("disconnected-project", isDirectory: true)
try FileManager.default.createDirectory(at: gone, withIntermediateDirectories: true)
let bookmark = try gone.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
try FileManager.default.removeItem(at: gone)
let entries: [[String: Any]] = [
    ["bookmark": bookmark, "path": gone.path],
    ["bookmark": Data([0, 1, 2]), "path": "/Volumes/Unavailable/project"],
]
// This process-only domain avoids writing to the user's app preferences.
UserDefaults.standard.setVolatileDomain(["recentProjects": entries], forName: UserDefaults.argumentDomain)
let before = ProjectBookmarks.load()
precondition(before.count == 2)
precondition(ProjectBookmarks.refresh() == before, "The actual store must retain unavailable and unresolvable bookmarks")
precondition(ProjectBookmarks.load() == before, "Automatic refresh must not erase saved retry data")
print("Actual bookmark store retains missing storage and invalid-resolution entries for retry.")
''')
        production = Path(folder) / "production-recents"
        subprocess.run(["swiftc", "-O", str(store), str(program), "-o", str(production)], check=True, timeout=600)
        return subprocess.run([str(production), folder], timeout=60).returncode


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Fails when any Mach-O file in a built Arya app strongly links a Swift overlay that some systems
the app supports do not have.

Usage: check-native-dylibs.py <path to Arya.app>
"""
import plistlib
import subprocess
import sys
from pathlib import Path

# Built with the Xcode 26-era SDK, the Result form of WKWebView.callAsyncJavaScript links
# /usr/lib/swift/libswiftWebKit.dylib. The iOS 18.4 simulator runtime has no such library, and the
# SDK maps these symbols elsewhere for iOS 18.4 and macOS 15.4 onward until the 26 releases, so a
# strong load stops the app launching on systems it claims to support. Weak loads are allowed.
MISSING_ON_SUPPORTED_SYSTEMS = {"/usr/lib/swift/libswiftWebKit.dylib"}
PRESENT_FROM_MAJOR = 26
STRONG = {"LC_LOAD_DYLIB", "LC_REEXPORT_DYLIB", "LC_LOAD_UPWARD_DYLIB"}
MACH_O_MAGIC = {b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",
                b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca", b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca"}


def mach_o_files(app):
    """Every regular Mach-O file in the bundle: the stub executable, Debug's Arya.debug.dylib,
    helpers, frameworks and plug-ins."""
    for path in sorted(app.rglob("*")):
        if path.is_symlink() or not path.is_file():
            continue
        with path.open("rb") as source:
            if source.read(4) in MACH_O_MAGIC:
                yield path


def loads(binary):
    output = subprocess.run(["/usr/bin/otool", "-l", str(binary)], capture_output=True, text=True, check=True).stdout
    kind = None
    for line in output.splitlines():
        words = line.split()
        if len(words) >= 2 and words[0] == "cmd":
            kind = words[1]
        elif len(words) >= 2 and words[0] == "name" and kind:
            yield kind, words[1]


def main(argv):
    if len(argv) != 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    app = Path(argv[1])
    mac = (app / "Contents").is_dir()
    info = plistlib.loads(((app / "Contents/Info.plist") if mac else (app / "Info.plist")).read_bytes())
    minimum = info.get("LSMinimumSystemVersion") if mac else info.get("MinimumOSVersion")
    if not isinstance(minimum, str) or not minimum.split(".")[0].isdigit():
        print(f"{app} has no readable minimum system version ({'LSMinimumSystemVersion' if mac else 'MinimumOSVersion'}).", file=sys.stderr)
        return 1
    if int(minimum.split(".")[0]) >= PRESENT_FROM_MAJOR:
        print(f"{app.name} requires {minimum}; the checked overlays are present there.")
        return 0
    files = list(mach_o_files(app))
    if not files:
        print(f"{app} contains no Mach-O files.", file=sys.stderr)
        return 1
    found = []
    for binary in files:
        for kind, name in loads(binary):
            if kind in STRONG and name in MISSING_ON_SUPPORTED_SYSTEMS:
                found.append(f"{binary.relative_to(app)} strongly links {name}")
    if found:
        print(f"{app.name} supports {minimum}, but some of those systems lack these libraries:\n  " + "\n  ".join(sorted(set(found))), file=sys.stderr)
        return 1
    print(f"{app.name} (minimum {minimum}): {len(files)} Mach-O files, none strongly links an overlay that supported systems lack.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

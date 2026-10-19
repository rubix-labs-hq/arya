#!/usr/bin/env python3
"""Build and inspect Arya archives without replacing an existing output."""
import argparse
import hashlib
import os
import stat
import types
import json
from pathlib import Path
import plistlib
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import uuid

REPO = Path(__file__).resolve().parents[2]
ENTITLEMENTS = REPO / "native/App/macOS/Reel.entitlements"
PERSISTENCE_WRAPPER_SHA256 = "87784cdf4e0844e055d6f5b6f0bdfaf6ddfb10a4f43256a3094d4fd0e1f1b41d"
PERSISTENCE_TOOL_SHA256 = "fba42b9c4ff86009b1999d09ce750660fed8a657554e30ce9c98891caf4eec92"
PERSISTENCE_MANIFEST_MODULE_SHA256 = "ebde5b0d0d69c33be9c79a1f14077d741738127c6b24449f6ce6004f201979a8"
NODE_RUNTIME_SOURCE_SHA256 = "6e423d71465f905b8d7052b6bbec5d7b86d12de84f61c70405f2a29cfab6548f"
NATIVE_DYLIB_CHECK_SHA256 = "165af90277dfe6d12fb1855eb1ec87b6a3a41078e49dcc1efe9328d3f9308889"


def load_runtime_dependency():
    path = Path(os.path.abspath(Path(__file__).with_name("node_runtime.py")))
    if path.resolve(strict=True) != path or path.is_symlink():
        raise ValueError("The runtime release dependency must have a canonical path.")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("The runtime release dependency must be a regular file.")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            data = source.read(256 * 1024 + 1)
    finally:
        os.close(descriptor)
    if len(data) > 256 * 1024 or hashlib.sha256(data).hexdigest() != NODE_RUNTIME_SOURCE_SHA256:
        raise ValueError("The runtime release dependency changed. Review it before packaging.")
    module = types.ModuleType("arya_node_runtime")
    module.__file__ = str(path)
    exec(compile(data, str(path), "exec"), module.__dict__)
    return module


def run(*args, capture=False):
    result = subprocess.run([str(arg) for arg in args], check=True,
                            text=True, capture_output=capture)
    return result.stdout if capture else None



def persistence_command(app, runtime, hashes=None):
    editor = app / "Contents/Resources/editor"
    script = editor / "scripts/prepare-project-writer.mjs"
    for file, expected in ((script, PERSISTENCE_TOOL_SHA256), (editor / "core/project-writer-manifest.mjs", PERSISTENCE_MANIFEST_MODULE_SHA256), (editor / "core/project-persistence.mjs", PERSISTENCE_WRAPPER_SHA256)):
        if runtime.sha(runtime.read_regular(file, 256 * 1024)) != expected:
            raise ValueError("The persistence preparation dependency changed. Review it before packaging.")
    if hashes is None:
        node = shutil.which("node")
        if not node:
            raise ValueError("Local archive validation requires the development Node build tool.")
    else:
        arch = {"arm64": "arm64", "x86_64": "x86_64"}.get(platform.machine())
        if not arch or arch not in hashes:
            raise ValueError("Unsupported release host architecture.")
        node = app / f"Contents/Helpers/node-{arch}"
        if runtime.sha(runtime.read_regular(node, runtime.MAX_BINARY)) != hashes[arch]:
            raise ValueError("The validated signing runtime changed before helper validation.")
    return [node, script], editor / "core"


def validate_persistence(app, info, runtime_report):
    runtime = load_runtime_dependency()
    command, core = persistence_command(app, runtime, runtime_report["signedSHA256"] if runtime_report else None)
    options = ["--official", runtime_report["teamIdentifier"]] if runtime_report else []
    receipt = json.loads(run(*command, "validate", core, *options, capture=True))
    if receipt.get("architectures") != ["arm64", "x86_64"] or receipt.get("minimumMacOS") != "14.0":
        raise ValueError("A universal macOS 14 persistence helper is required.")
    runtime.check_minimum({arch: receipt["minimumMacOS"] for arch in receipt["architectures"]}, info.get("LSMinimumSystemVersion"))
    if runtime_report and (receipt.get("signatureMode") != "developer-id" or receipt.get("teamIdentifier") != runtime_report["teamIdentifier"]):
        raise ValueError("The persistence helper signing team differs from the app runtime.")
    return receipt


def validate_bundle(app, signed=False):
    app = app.resolve(strict=True)
    contents = app / "Contents"
    with (contents / "Info.plist").open("rb") as source:
        info = plistlib.load(source)
    executable = contents / "MacOS" / info["CFBundleExecutable"]
    if not executable.is_file():
        raise ValueError("The app executable is missing.")
    editor = contents / "Resources/editor"
    for relative in ("reel-core.js", "web/index.html", "core/project.js",
                     "vendor/preact/dist/preact.module.js", "agent/bridge.mjs",
                     "agent/mcp.mjs", "agent/adapters.mjs", "agent/protocol.mjs",
                     "agent/Reel Agent Bridge.command"):
        if not (editor / relative).is_file():
            raise ValueError(f"The bundled editor is missing {relative}.")
    schemes = [scheme for entry in info.get("CFBundleURLTypes", [])
               for scheme in entry.get("CFBundleURLSchemes", [])]
    if "reelfigma" not in schemes:
        raise ValueError("The Figma OAuth callback scheme is missing.")
    if "reelagent" not in schemes:
        raise ValueError("The agent bridge pairing callback scheme is missing.")
    run("codesign", "--verify", "--deep", "--strict", app)
    details = subprocess.run(["codesign", "-dvv", str(app)], check=True,
                             text=True, capture_output=True).stderr
    flags = re.search(r"^CodeDirectory\b.*\bflags=0x([0-9a-fA-F]+)", details, re.MULTILINE)
    if not flags or int(flags.group(1), 16) & 0x10000 == 0:
        raise ValueError("The app has no hardened runtime signature.")
    # A strong load of a Swift overlay that some supported systems lack stops the app launching there.
    guard = Path(__file__).with_name("check-native-dylibs.py")
    if hashlib.sha256(guard.read_bytes()).hexdigest() != NATIVE_DYLIB_CHECK_SHA256:
        raise ValueError("The native library check changed; review it and update its pin before releasing.")
    run(sys.executable, "-I", "-S", "-B", guard, app)
    entitlements = plistlib.loads(run("codesign", "-d", "--entitlements", ":-", app, capture=True).encode())
    for key in ("com.apple.security.app-sandbox",
                "com.apple.security.files.user-selected.read-write",
                "com.apple.security.files.bookmarks.app-scope",
                "com.apple.security.network.client"):
        if entitlements.get(key) is not True:
            raise ValueError(f"The app is missing {key}.")
    if entitlements.get("com.apple.security.network.server"):
        raise ValueError("Arya must not request a network listener entitlement.")
    if signed and "Authority=Developer ID Application:" not in details:
        raise ValueError("Distribution requires a Developer ID Application signature.")
    runtime_report = load_runtime_dependency().validate(app, info) if signed else None
    persistence_report = validate_persistence(app, info, runtime_report)
    return {"runtime": runtime_report, "persistence": persistence_report, "signedCandidateValidated": signed,
            "readyToPublish": False, "notarization": "not performed",
            "freshInstallAcceptance": "not performed",
            "app": str(app), "bundleID": info["CFBundleIdentifier"],
            "version": info["CFBundleShortVersionString"],
            "signature": "Developer ID" if signed else "local", "entitlements": entitlements}


def archive(args):
    output = Path(args.output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError("The output already exists. Choose a new directory.")
    if output.parent.resolve() != output.parent:
        raise ValueError("The output directory must not pass through a symbolic link.")
    if args.identity and not args.team:
        raise ValueError("A signed archive needs both --identity and --team.")
    if args.platform == "ios" and not args.team:
        raise ValueError("An iOS device archive needs --team and a provisioning profile.")
    if args.identity:
        identities = run("security", "find-identity", "-v", "-p", "codesigning", capture=True)
        if args.identity not in identities:
            raise ValueError("The requested signing identity is not available in the keychain.")
    if args.platform == "ios" and (args.node_archives or args.runtime_entitlements):
        raise ValueError("Desktop Node payloads must not be included in an iOS archive.")
    signed_mac = args.platform == "macos" and bool(args.identity)
    if signed_mac and (not args.node_archives or not args.runtime_entitlements):
        raise ValueError("Signed Mac releases require --node-archives and --runtime-entitlements.")
    if args.platform == "macos" and not args.identity and (args.node_archives or args.runtime_entitlements):
        raise ValueError("An ad hoc development archive must omit distribution runtimes.")
    runtime = load_runtime_dependency() if signed_mac else None
    output.mkdir(parents=True)
    trusted_runtime = runtime.prepare(Path(args.node_archives), output / "runtime-payload", "14.0") if runtime else None
    scheme = "Reel" if args.platform == "macos" else "Reel iOS"
    destination = "generic/platform=macOS" if args.platform == "macos" else "generic/platform=iOS"
    command = ["xcodebuild", "-project", REPO / "native/Reel.xcodeproj",
               "-scheme", scheme, "-configuration", "Release", "-destination", destination,
               "-derivedDataPath", output / "DerivedData", "-archivePath", output / "Arya.xcarchive"]
    if args.team:
        command.append(f"DEVELOPMENT_TEAM={args.team}")
    if args.platform == "macos":
        # Copy and sign the helper runtimes before the final app signature.
        command.extend(["CODE_SIGNING_ALLOWED=NO", "ARCHS=arm64 x86_64", "ONLY_ACTIVE_ARCH=NO", "-jobs", "1"])
    elif args.identity:
        command.extend(["CODE_SIGN_STYLE=Manual", f"CODE_SIGN_IDENTITY={args.identity}"])
    if args.allow_provisioning:
        command.append("-allowProvisioningUpdates")
    command.append("archive")
    run(*command)
    if args.platform == "ios":
        print(f"Device archive saved to {output / 'Arya.xcarchive'}. Export it with Xcode Organizer.")
        return
    app = output / "Arya.xcarchive/Products/Applications/Arya.app"
    if runtime:
        with (app / "Contents/Info.plist").open("rb") as source:
            info = plistlib.load(source)
        runtime.install(output / "runtime-payload", app, trusted_runtime, info["LSMinimumSystemVersion"])
        signed_runtime = runtime.sign_and_probe(app, args.identity, args.team, Path(args.runtime_entitlements), trusted_runtime)
        hashes = {entry["architecture"]: entry["signedSHA256"] for entry in signed_runtime["files"]}
        persistence, core = persistence_command(app, runtime, hashes)
        # Sign the nested writer and bind its final bytes before sealing the app.
        run(*persistence, "sign", core, args.identity, args.team)
        run("codesign", "--force", "--sign", args.identity, "--options", "runtime", "--timestamp",
            "--entitlements", ENTITLEMENTS, app)
    else:
        run("codesign", "--force", "--sign", "-", "--options", "runtime",
            "--entitlements", ENTITLEMENTS, app)
    report = validate_bundle(app, signed=bool(args.identity))
    run("ditto", "-c", "-k", "--keepParent", app, output / "Arya.zip")
    (output / "validation.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Validated archive and ZIP saved to {output}.")


def notarization_input(value, app=False):
    path = Path(os.path.abspath(value))
    if path.resolve(strict=True) != path or path.is_symlink():
        raise ValueError("Notarization inputs must not pass through symbolic links.")
    if app:
        if path.suffix != ".app" or not path.is_dir():
            raise ValueError("Notarization requires a macOS .app bundle.")
    elif not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("The archive input must be a regular file.")
    return path


def file_sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def accepted_notarization(response):
    try:
        result = json.loads(response)
    except (ValueError, TypeError):
        raise ValueError("The notary service did not return a valid JSON receipt.") from None
    if not isinstance(result, dict) or result.get("status") != "Accepted":
        raise ValueError("The notary service did not accept the distribution archive.")
    identifier = result.get("id")
    try:
        if not isinstance(identifier, str) or str(uuid.UUID(identifier)) != identifier.lower():
            raise ValueError()
    except (ValueError, AttributeError):
        raise ValueError("The notary service receipt has no valid submission ID.") from None
    return identifier


def notarize(args):
    app = notarization_input(args.app, app=True)
    package = notarization_input(args.zip)
    if package.suffix.lower() != ".zip":
        raise ValueError("Submit the ZIP produced by the signed archive command.")
    delivered = package.with_name(package.stem + "-notarized.zip")
    submission = package.with_name(package.stem + "-submission.zip")
    receipt = package.with_name(package.stem + "-notarization.json")
    for output in (delivered, submission, receipt):
        if output.exists() or output.is_symlink():
            raise ValueError("A notarization output already exists. Preserve it and choose a new output prefix.")
    try:
        package.parent.relative_to(app)
    except ValueError:
        pass
    else:
        raise ValueError("Notarization outputs must be outside the app bundle.")
    report = validate_bundle(app, signed=True)
    output_fd = os.open(package.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with tempfile.TemporaryDirectory(prefix=".arya-notarization-", dir=package.parent) as scratch:
            temporary = Path(scratch)
            submitted = temporary / submission.name
            delivery = temporary / delivered.name
            record = temporary / receipt.name
            # Submit the exact validated app, never trust a caller-supplied ZIP's contents.
            run("ditto", "-c", "-k", "--keepParent", app, submitted)
            response = run("xcrun", "notarytool", "submit", submitted,
                           "--keychain-profile", args.profile, "--wait", "--output-format", "json", capture=True)
            identifier = accepted_notarization(response)
            run("xcrun", "stapler", "staple", app)
            run("xcrun", "stapler", "validate", app)
            run("spctl", "--assess", "--type", "execute", "--verbose", app)
            # The submitted ZIP predates the staple. Deliver a separate ZIP with the ticket.
            run("ditto", "-c", "-k", "--keepParent", app, delivery)
            identity, current = os.fstat(output_fd), package.parent.lstat()
            if stat.S_ISLNK(current.st_mode) or (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
                raise ValueError("The notarization output directory changed.")
            metadata = {"schema": 1, "product": "Arya", "bundleID": report["bundleID"],
                        "version": report["version"], "notarizationStatus": "Accepted",
                        "notarySubmissionID": identifier, "appStapleAndGatekeeperPassed": True,
                        "submission": {"file": submission.name, "sha256": file_sha256(submitted), "bytes": submitted.stat().st_size},
                        "delivery": {"file": delivered.name, "sha256": file_sha256(delivery), "bytes": delivery.stat().st_size},
                        "readyToPublish": False, "freshInstallAcceptance": "not performed",
                        "currentSourceUIAcceptance": "not performed", "releaseOwnerApproval": "not performed"}
            record.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
            identity, current = os.fstat(output_fd), package.parent.lstat()
            if stat.S_ISLNK(current.st_mode) or (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
                raise ValueError("The notarization output directory changed.")
            # Publish complete files without overwriting a racing file. Publish delivery last.
            for item in (submitted, record, delivery):
                os.link(item, item.name, dst_dir_fd=output_fd, follow_symlinks=False)
    finally:
        os.close(output_fd)
    print(f"Notarization and Gatekeeper validation passed. Deliver {delivered}.")
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser("archive")
    build.add_argument("--output", required=True)
    build.add_argument("--platform", choices=["macos", "ios"], default="macos")
    build.add_argument("--team")
    build.add_argument("--identity")
    build.add_argument("--node-archives", help="Directory containing the two pinned official Node tarballs.")
    build.add_argument("--runtime-entitlements", help="Reviewed V8 helper entitlement plist. Signed startup probes are mandatory.")
    build.add_argument("--allow-provisioning", action="store_true",
                       help="Permit Xcode to update profiles using its signed-in account.")
    check = commands.add_parser("validate")
    check.add_argument("app")
    check.add_argument("--signed", action="store_true")
    notarization = commands.add_parser("notarize")
    notarization.add_argument("--app", required=True)
    notarization.add_argument("--zip", required=True)
    notarization.add_argument("--profile", required=True)
    args = parser.parse_args()
    required_tools = {"archive": ("xcodebuild", "codesign", "ditto"),
                      "validate": ("codesign",), "notarize": ("codesign", "ditto", "xcrun", "spctl")}
    for tool in required_tools[args.command]:
        if not shutil.which(tool):
            parser.error(f"{tool} is required. Install and select Xcode.")
    try:
        if args.command == "archive":
            archive(args)
        elif args.command == "validate":
            print(json.dumps(validate_bundle(Path(args.app), args.signed), indent=2))
        else:
            notarize(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Release failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

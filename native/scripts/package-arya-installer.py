#!/usr/bin/env python3
"""Package an already-built macOS app. Never build, install, or replace an output."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys
import tempfile
import types

RELEASE_SOURCE_SHA256 = "56c57a3dbea27568728241f0e4bbbac33ae9fde8243248fdfcb04086d15b355a"
NODE_RUNTIME_SOURCE_SHA256 = "6e423d71465f905b8d7052b6bbec5d7b86d12de84f61c70405f2a29cfab6548f"


def load_release_dependency(path, expected_hash):
    path = Path(os.path.abspath(path))
    if path.resolve(strict=True) != path or path.is_symlink():
        raise ValueError("The release validator must have a canonical path.")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("The release validator is not a regular file.")
        source = os.read(descriptor, 1024 * 1024 + 1)
    finally:
        os.close(descriptor)
    if len(source) > 1024 * 1024 or hashlib.sha256(source).hexdigest() != expected_hash:
        raise ValueError("The release validator changed. Review and pin the new dependency before packaging.")
    module = types.ModuleType("arya_release_validator")
    module.__file__ = str(path)
    # Compile exactly the bytes checked above, never reopen a potentially replaced file.
    exec(compile(source, str(path), "exec"), module.__dict__)
    return module


try:
    release = load_release_dependency(Path(__file__).with_name("release.py"), RELEASE_SOURCE_SHA256)
    node_runtime = load_release_dependency(Path(__file__).with_name("node_runtime.py"), NODE_RUNTIME_SOURCE_SHA256)
    if release.NODE_RUNTIME_SOURCE_SHA256 != NODE_RUNTIME_SOURCE_SHA256:
        raise ValueError("The runtime validator pin differs from the release validator pin.")
    # Keep both reviewed modules in memory. Do not reload a changed dependency mid-run.
    release.load_runtime_dependency = lambda: node_runtime
except (OSError, ValueError):
    print("Packaging dependency is unavailable or changed. Re-review the release validator.", file=sys.stderr)
    raise SystemExit(2)

INSTALL_TEXT = """Before installing or updating

Save your projects and finish or stop any assistant runs. If you started Arya's
companion in Terminal, press Control-C in that companion's window and wait for it
to exit. Quit all running copies of Arya, including any retained Reel build.

Back up project folders with their media before updating. Keep the previous
approved installer and its published checksum so you can return to that version.

Install this version

1. Check this version and the downloaded image's checksum against the official
   download page before replacing your installed app.
2. Drag Arya.app onto Applications. Choose Replace for the existing Arya.app.
   Wait for Finder to finish copying before opening the app.
3. Eject this disk image. Open Arya from Applications, then check its version in
   Finder's Get Info. Do not launch the app from this image or an older copy.
4. Let macOS verify the app and confirm the normal first-launch prompt. If you
   use the companion, start it again from the installed app's Assistant settings.

Your projects live in folders you choose. Replacing the app does not replace those
folders. Keep preferences, account connections and folder permissions in place.
If your previous app is named Reel.app, installing Arya.app does not replace it.
Keep that copy closed and check the version and location of the app you open.

Return to a previous version

Save your work, stop the companion in its Terminal window and quit Arya. Use the
previous approved installer after checking its published checksum. Replace the
Applications copy, eject the image and check the installed version in Get Info.
Open a separate copy of the backup made before the update. A project saved by a
newer version may not open in an older version. Replacing the app does not undo
project edits or convert a project to an older format. Start the companion again
from the restored app's Assistant settings if you use it.

The editor works without an AI account. Open Getting started on the start screen
or in the Help menu for project, editing and optional assistant instructions.
AI-assisted editing requires a supported provider account. Install Claude Code
or Codex using the provider's official instructions, then use its sign-in flow.
Arya supplies a separate companion, started from Assistant settings. Check its
connection and account status before Send. Arya does not include an AI plan and
does not ask for your provider subscription password.

If macOS reports that the app is damaged, unsigned, or blocked, stop and use the
support instructions on the official download page. Do not disable Gatekeeper or
remove quarantine attributes to force this copy to run.

Uninstall the Mac app

Save your work and finish or stop assistant runs. If you started Arya's companion
in Terminal, press Control-C in that companion's window and wait for it to exit.
Quitting Arya does not stop that separate companion. Quit all Arya copies, then
move Arya.app from Applications to Trash in Finder.

Keep project folders, their media and exported videos. Removing the app does not
remove those files, preferences, account connections or companion support files.
Leave those in place for reinstalling unless you choose to remove them separately.
Reinstall through the channel that supplied your app. Keep your backup and
approved installer if the release is no longer available.
"""


def installation_text(metadata, mode):
    names = {"arm64": "Apple silicon", "x86_64": "Intel"}
    header = (f"Install Arya {metadata['version']}, build {metadata['build']}\n"
              f"Requires macOS {metadata['minimumMacOS']} or newer.\n"
              f"Supported Macs: {', '.join(names[arch] for arch in metadata['architectures'])}.\n\n")
    prefix = "" if mode == "official" else "REHEARSAL ONLY. This image is not an official download.\n\n"
    return prefix + header + INSTALL_TEXT


def command(*args):
    result = subprocess.run([str(arg) for arg in args], text=True, capture_output=True)
    if result.returncode:
        # Tool output can contain local paths and account metadata. Keep it out of reports.
        raise ValueError(f"{Path(str(args[0])).name} failed with exit code {result.returncode}.")
    return result.stdout


def captured_release_run(*args, capture=False):
    result = command(*args)
    return result if capture else None


# The reviewed validator's original run() inherits stderr. Capture it for this tool.
release.run = captured_release_run


def canonical_input(value):
    path = Path(os.path.abspath(value))
    if path.resolve(strict=True) != path or path.is_symlink():
        raise ValueError("The input must not pass through a symbolic link.")
    if not path.is_dir() or path.suffix != ".app":
        raise ValueError("The input must be a macOS .app bundle.")
    for base, directories, files in os.walk(path, followlinks=False):
        for name in directories + files:
            item = Path(base) / name
            mode = item.lstat().st_mode
            if stat.S_ISLNK(mode):
                if os.path.isabs(os.readlink(item)):
                    raise ValueError("The app contains an absolute symbolic link.")
                try:
                    item.resolve(strict=True).relative_to(path)
                except (ValueError, FileNotFoundError, RuntimeError):
                    raise ValueError("The app has an external or broken symbolic link.") from None
            elif not (stat.S_ISREG(mode) or stat.S_ISDIR(mode)):
                raise ValueError("The app contains a special filesystem entry.")
    return path


def read_metadata(app, mode):
    with (app / "Contents/Info.plist").open("rb") as source:
        info = plistlib.load(source)
    for key in ("CFBundleExecutable", "CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion"):
        value = info.get(key)
        if not isinstance(value, str) or not value or not re.fullmatch(r"[A-Za-z0-9._+-]+", value):
            raise ValueError(f"Invalid or missing {key}.")
    if info.get("CFBundlePackageType") != "APPL":
        raise ValueError("The input is not an APPL bundle.")
    if mode == "official" and (app.name != "Arya.app" or info.get("CFBundleDisplayName") != "Arya" or info.get("CFBundleName") != "Arya"):
        raise ValueError("Official distribution needs an Arya.app bundle with the Arya display and bundle names.")
    minimum = info.get("LSMinimumSystemVersion")
    if not isinstance(minimum, str) or not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", minimum):
        raise ValueError("The bundle must declare its minimum macOS version.")
    return info


def verify_app(app, mode, validator=release.validate_bundle, runner=command):
    info = read_metadata(app, mode)
    try:
        report = validator(app, signed=mode == "official")
    except subprocess.CalledProcessError as error:
        raise ValueError(f"App validation tool failed with exit code {error.returncode}.") from None
    runtime_receipt = None
    if mode == "official":
        runtime = report.get("runtime")
        if not isinstance(runtime, dict) or runtime.get("version") != node_runtime.VERSION or runtime.get("architectures") != ["arm64", "x86_64"]:
            raise ValueError("Official packaging requires the pinned, validated universal bridge runtime.")
        helpers = runtime.get("signedSHA256")
        if not isinstance(helpers, dict) or set(helpers) != {"arm64", "x86_64"} or any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in helpers.values()):
            raise ValueError("The runtime validation receipt is missing signed helper hashes.")
        manifest_hash = runtime.get("manifestSHA256")
        if not isinstance(manifest_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", manifest_hash):
            raise ValueError("The runtime validation receipt is missing its manifest hash.")
        persistence = report.get("persistence")
        if not isinstance(persistence, dict) or persistence.get("architectures") != ["arm64", "x86_64"] or persistence.get("minimumMacOS") != "14.0" or persistence.get("signatureMode") != "developer-id" or persistence.get("teamIdentifier") != runtime.get("teamIdentifier") or any(not isinstance(persistence.get(key), str) or not re.fullmatch(r"[a-f0-9]{64}", persistence[key]) for key in ("binarySHA256", "manifestSHA256")):
            raise ValueError("Official packaging requires the signed, validated persistence helper and manifest.")
        runtime_receipt = {"persistence": persistence, "version": runtime["version"], "architectures": runtime["architectures"],
                           "manifestSHA256": manifest_hash, "signedSHA256": helpers}
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    architectures = sorted(set(runner("lipo", "-archs", executable).strip().split()))
    if not architectures or any(arch not in ("arm64", "x86_64") for arch in architectures):
        raise ValueError("The executable has unsupported or missing architectures.")
    if mode == "official" and architectures != runtime_receipt["architectures"]:
        raise ValueError("The app and its validated bridge runtime need the same universal architectures.")
    for architecture in architectures:
        headers = runner("otool", "-arch", architecture, "-l", executable)
        minimums = []
        for block in re.split(r"Load command \d+", headers):
            if "cmd LC_BUILD_VERSION" in block:
                minimums.extend(re.findall(r"\bminos\s+(\d+\.\d+(?:\.\d+)?)", block))
            elif "cmd LC_VERSION_MIN_MACOSX" in block:
                minimums.extend(re.findall(r"\bversion\s+(\d+\.\d+(?:\.\d+)?)", block))
        declared = tuple(int(part) for part in info["LSMinimumSystemVersion"].split("."))
        normalized = lambda parts: tuple(parts) + (0,) * (3 - len(parts))
        if not minimums or any(normalized(tuple(map(int, version.split(".")))) > normalized(declared) for version in minimums):
            raise ValueError("The executable minimum OS exceeds the bundle's declared minimum, or cannot be verified.")
    notarized = False
    if mode == "official":
        runner("xcrun", "stapler", "validate", app)
        runner("spctl", "--assess", "--type", "execute", "--verbose", app)
        notarized = True
    return {"bundleID": report["bundleID"], "version": info["CFBundleShortVersionString"],
            "build": info["CFBundleVersion"], "minimumMacOS": info["LSMinimumSystemVersion"],
            "architectures": architectures, "appSignature": report["signature"],
            "bridgeRuntime": runtime_receipt,
            "appStapleAndGatekeeperPassed": notarized}


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bundle_digest(app):
    """Include paths, file bytes, permissions, and internal link targets."""
    digest = hashlib.sha256()
    for base, directories, files in os.walk(app, followlinks=False):
        directories.sort()
        for name in sorted(directories + files):
            item = Path(base) / name
            relative = item.relative_to(app).as_posix()
            mode = item.lstat().st_mode
            payload = os.readlink(item) if stat.S_ISLNK(mode) else sha256(item) if stat.S_ISREG(mode) else "directory"
            digest.update(json.dumps([relative, stat.S_IMODE(mode), payload], separators=(",", ":")).encode() + b"\n")
    return digest.hexdigest()


def reserve_output(value):
    output = Path(os.path.abspath(value))
    if output.exists() or output.is_symlink():
        raise ValueError("The output already exists. Choose a new directory.")
    if output.parent.resolve(strict=True) != output.parent or not output.parent.is_dir():
        raise ValueError("The existing output parent must not pass through a symbolic link.")
    output.mkdir(mode=0o700)
    return output


def verify_image_contents(image, temporary, expected_digest, expected_text, mode, validator, runner):
    mount = temporary / "mounted"
    mount.mkdir(mode=0o700)
    response = plistlib.loads(runner("hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, "-plist", image).encode())
    entities = [entity for entity in response.get("system-entities", []) if entity.get("mount-point") == str(mount)]
    if len(entities) != 1 or not re.fullmatch(r"/dev/disk\d+(?:s\d+)?", entities[0].get("dev-entry", "")):
        raise ValueError("The created image mount could not be identified. No unrelated device will be detached.")
    device = entities[0]["dev-entry"]
    try:
        mounted_app = canonical_input(mount / "Arya.app")
        if bundle_digest(mounted_app) != expected_digest or not mounted_app.is_dir():
            raise ValueError("The disk image app differs from the validated source.")
        shortcut = mount / "Applications"
        if not shortcut.is_symlink() or os.readlink(shortcut) != "/Applications":
            raise ValueError("The disk image Applications shortcut is invalid.")
        if (mount / "Install Arya.txt").read_text(encoding="utf-8") != expected_text:
            raise ValueError("The disk image installation instructions differ from the staged copy.")
        verify_app(mounted_app, mode, validator, runner)
    finally:
        runner("hdiutil", "detach", device)


def package(args, runner=command, validator=release.validate_bundle):
    if sys.platform != "darwin":
        raise ValueError("DMG packaging requires macOS.")
    if args.mode == "official" and (not args.identity or not args.profile):
        raise ValueError("Official packaging needs --identity and an existing --profile.")
    if args.mode == "official" and not args.identity.startswith("Developer ID Application:"):
        raise ValueError("The DMG needs a Developer ID Application identity.")
    if args.mode != "official" and (args.identity or args.profile):
        raise ValueError("Rehearsal packaging must not use signing or notarization credentials.")
    app = canonical_input(args.app)
    output_candidate = Path(os.path.abspath(args.output))
    try:
        output_candidate.relative_to(app)
    except ValueError:
        pass
    else:
        raise ValueError("The output must be outside the source app bundle.")
    # Validate before creating output. Validate the copied bytes again before imaging.
    metadata = verify_app(app, args.mode, validator, runner)
    before = bundle_digest(app)
    output = reserve_output(args.output)
    output_fd = os.open(output, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with tempfile.TemporaryDirectory(prefix=".arya-package-", dir=output) as scratch:
            temporary = Path(scratch)
            staging = temporary / "volume"
            staging.mkdir(mode=0o700)
            copied = staging / "Arya.app"
            runner("ditto", app, copied)
            canonical_input(copied)
            if bundle_digest(copied) != before or bundle_digest(app) != before:
                raise ValueError("The source or copied app changed during packaging.")
            # Rehearsal naming does not change bundle metadata or its signature.
            verify_app(copied, args.mode, validator, runner)
            (staging / "Applications").symlink_to("/Applications")
            text = installation_text(metadata, args.mode)
            (staging / "Install Arya.txt").write_text(text, encoding="utf-8")
            label = "Arya" if args.mode == "official" else "Arya rehearsal"
            filename = f"Arya-{metadata['version']}-{metadata['build']}" + ("" if args.mode == "official" else "-REHEARSAL") + ".dmg"
            image = temporary / filename
            runner("hdiutil", "create", "-srcfolder", staging, "-volname", label,
                   "-fs", "HFS+", "-format", "UDZO", image)
            runner("hdiutil", "verify", image)
            notary_id = None
            if args.mode == "official":
                runner("codesign", "--sign", args.identity, "--timestamp", image)
                response = runner("xcrun", "notarytool", "submit", image,
                                  "--keychain-profile", args.profile, "--wait", "--output-format", "json")
                notary_id = release.accepted_notarization(response)
                runner("xcrun", "stapler", "staple", image)
                runner("xcrun", "stapler", "validate", image)
                runner("codesign", "--verify", "--strict", image)
                runner("spctl", "--assess", "--type", "open", "--context", "context:primary-signature", "--verbose", image)
                runner("hdiutil", "verify", image)
            verify_image_contents(image, temporary, before, text, args.mode, validator, runner)
            metadata.update({"schema": 1, "product": "Arya", "mode": args.mode,
                             "officialDownload": args.mode == "official", "image": filename,
                             "readyToPublish": False, "readOnlyImageContentVerificationPassed": True,
                             "sha256": sha256(image), "bytes": image.stat().st_size,
                             "sourceBundleDigest": before, "notarySubmissionID": notary_id,
                             "releaseValidatorSourceSHA256": RELEASE_SOURCE_SHA256,
                             "nodeRuntimeValidatorSourceSHA256": NODE_RUNTIME_SOURCE_SHA256,
                             "dmgStapleAndGatekeeperPassed": args.mode == "official",
                             "installationInstructionsSHA256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
                             "updateMechanism": "manual replacement in Applications",
                             "freshMacInstallAcceptance": "not performed by this tool",
                             "manualUpdateAcceptance": "not performed by this tool",
                             "manualRollbackAcceptance": "not performed by this tool",
                             "uninstallAcceptance": "not performed by this tool"})
            checksum = temporary / "SHA256SUMS"
            checksum.write_text(f"{metadata['sha256']}  {filename}\n", encoding="utf-8")
            receipt = temporary / "distribution.json"
            receipt.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
            identity = os.fstat(output_fd)
            current = output.lstat()
            if stat.S_ISLNK(current.st_mode) or (identity.st_dev, identity.st_ino) != (current.st_dev, current.st_ino):
                raise ValueError("The reserved output directory changed.")
            # Hard links publish complete files on the same volume and never overwrite.
            for item in (checksum, receipt, image):
                os.link(item, item.name, dst_dir_fd=output_fd, follow_symlinks=False)
        return metadata
    finally:
        os.close(output_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True)
    parser.add_argument("--output", required=True, help="A new directory inside an existing canonical parent.")
    parser.add_argument("--mode", choices=("rehearsal", "official"), default="rehearsal")
    parser.add_argument("--identity")
    parser.add_argument("--profile", help="An existing notarytool keychain profile. This tool creates no credentials.")
    args = parser.parse_args()
    try:
        report = package(args)
        print(json.dumps(report, indent=2))
        return 0
    except OSError:
        print("Packaging failed: a filesystem operation could not complete.", file=sys.stderr)
        return 1
    except (ValueError, KeyError, TypeError) as error:
        print(f"Packaging failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Read-only iOS app preflight, plus a privacy manifest check for built macOS and iOS
bundles. This does not upload, sign, build or approve an app."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess
import sys


APP_MANIFEST = "native/App/Shared/PrivacyInfo.xcprivacy"
# Both targets copy the one source manifest. ReelKit and NativeProjectIO link statically into
# each app executable, so this app manifest declares their API use too.
BUNDLE_INFO = {"macos": "Contents/Info.plist", "ios": "Info.plist"}
BUNDLE_MANIFEST = {"macos": "Contents/Resources/PrivacyInfo.xcprivacy", "ios": "PrivacyInfo.xcprivacy"}
BUNDLE_IDENTIFIER = {"macos": "app.reel.Reel", "ios": "app.reel.ios"}
MANIFEST_KEYS = {"NSPrivacyTracking", "NSPrivacyTrackingDomains", "NSPrivacyCollectedDataTypes", "NSPrivacyAccessedAPITypes"}
# Apple's approved reasons per required reason API category ("Describing use of required
# reason API"). The SDK-only wrapper reasons 0A2A.1 and C56D.1 are omitted because Arya is an app.
APPROVED_REASONS = {
    "NSPrivacyAccessedAPICategoryFileTimestamp": {"DDA9.1", "C617.1", "3B52.1"},
    "NSPrivacyAccessedAPICategorySystemBootTime": {"35F9.1", "8FFB.1", "3D61.1"},
    "NSPrivacyAccessedAPICategoryDiskSpace": {"85F4.1", "E174.1", "7D9E.1", "B728.1"},
    "NSPrivacyAccessedAPICategoryActiveKeyboards": {"3EC4.1", "54BD.1"},
    "NSPrivacyAccessedAPICategoryUserDefaults": {"CA92.1", "1C8F.1", "AC6B.1"},
}
# The categories Arya's code uses and the reasons it declares. Change this only together with
# the manifest and the source evidence for the new use.
DECLARED_REASONS = {
    "NSPrivacyAccessedAPICategoryUserDefaults": {"CA92.1"},
    "NSPrivacyAccessedAPICategoryFileTimestamp": {"C617.1", "3B52.1"},
    "NSPrivacyAccessedAPICategorySystemBootTime": {"35F9.1"},
    "NSPrivacyAccessedAPICategoryDiskSpace": {"E174.1"},
}


class GateError(ValueError):
    pass


def require(value, message):
    if not value:
        raise GateError(message)


def regular(path, limit=4 * 1024 * 1024):
    require(type(limit) is int and limit > 0, "Invalid inspection limit")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError as error:
        raise GateError(f"Expected a readable regular file: {path.name}") from error
    try:
        before = os.fstat(descriptor)
        require(stat.S_ISREG(before.st_mode), f"Expected a regular file: {path.name}")
        require(before.st_size <= limit, f"File exceeds the inspection limit: {path.name}")
        chunks = []
        count = 0
        while count <= limit:
            chunk = os.read(descriptor, min(64 * 1024, limit + 1 - count))
            if not chunk:
                break
            chunks.append(chunk)
            count += len(chunk)
        require(count <= limit, f"File grew beyond the inspection limit: {path.name}")
        after = os.fstat(descriptor)
        current = os.lstat(path)
        identity = lambda value: (value.st_dev, value.st_ino, value.st_mode, value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)
        require(identity(before) == identity(after) == identity(current) and count == before.st_size,
                f"File changed during inspection: {path.name}")
        return b"".join(chunks)
    except OSError as error:
        raise GateError(f"File could not be inspected consistently: {path.name}") from error
    finally:
        os.close(descriptor)


def load_plist(path):
    value = plistlib.loads(regular(path))
    require(isinstance(value, dict), f"Expected a plist dictionary: {path.name}")
    return value


def bundle_regular(app, path, limit=4 * 1024 * 1024):
    require(path.resolve().is_relative_to(app), "Required bundle file resolves outside the app")
    require(not any(parent.is_symlink() for parent in path.parents if parent != app and app in parent.parents), "Required bundle file has a symlinked parent")
    return regular(path, limit)


def sha256(path):
    return hashlib.sha256(regular(path)).hexdigest()


def validate_manifest(data):
    """Parse privacy manifest bytes and require the reviewed declarations exactly."""
    try:
        value = plistlib.loads(data)
    except Exception as error:
        raise GateError("Privacy manifest is not a readable property list") from error
    require(isinstance(value, dict) and set(value) == MANIFEST_KEYS, "Privacy manifest keys differ from the reviewed set")
    require(value["NSPrivacyTracking"] is False, "Privacy manifest must declare NSPrivacyTracking false")
    require(value["NSPrivacyTrackingDomains"] == [], "Privacy manifest must not list tracking domains")
    require(value["NSPrivacyCollectedDataTypes"] == [], "Privacy manifest collected data differs from the reviewed empty list")
    entries = value["NSPrivacyAccessedAPITypes"]
    require(isinstance(entries, list), "Privacy manifest API types must be a list")
    declared = {}
    for entry in entries:
        require(isinstance(entry, dict) and set(entry) == {"NSPrivacyAccessedAPIType", "NSPrivacyAccessedAPITypeReasons"}, "Malformed required reason API entry")
        category, reasons = entry["NSPrivacyAccessedAPIType"], entry["NSPrivacyAccessedAPITypeReasons"]
        require(isinstance(category, str) and category in APPROVED_REASONS, "Unknown required reason API category")
        require(category not in declared, f"Repeated required reason API category: {category}")
        require(isinstance(reasons, list) and reasons and all(isinstance(reason, str) for reason in reasons) and len(set(reasons)) == len(reasons), f"Malformed reasons for {category}")
        require(set(reasons) <= APPROVED_REASONS[category], f"Reason not approved for {category}")
        declared[category] = set(reasons)
    require(declared == DECLARED_REASONS, "Declared required reason APIs differ from the reviewed source evidence")
    return {category: sorted(reasons) for category, reasons in sorted(declared.items())}


def bundled_manifest(root, app, platform):
    """Validate the source manifest and require the built bundle to carry the same bytes."""
    reviewed = regular(root / APP_MANIFEST)
    declared = validate_manifest(reviewed)
    manifest = app / BUNDLE_MANIFEST[platform]
    require(bundle_regular(app, manifest) == reviewed, "Built app privacy manifest is missing or differs from the reviewed source")
    return manifest, declared


def built_app_checks(root, app):
    """Manifest-only check for any built Arya bundle, including unsigned Debug builds."""
    require(app.is_dir() and not app.is_symlink(), "Pass a real app bundle directory")
    app = app.resolve()
    layouts = [platform for platform, info in BUNDLE_INFO.items() if (app / info).is_file()]
    require(len(layouts) == 1, "Expected exactly one macOS or iOS bundle layout")
    platform = layouts[0]
    info = plistlib.loads(bundle_regular(app, app / BUNDLE_INFO[platform]))
    require(isinstance(info, dict) and info.get("CFBundleIdentifier") == BUNDLE_IDENTIFIER[platform], "Bundle identifier differs")
    manifest, declared = bundled_manifest(root, app, platform)
    return {"platform": platform, "app_path": str(app), "manifest_path": BUNDLE_MANIFEST[platform],
            "manifest_sha256": sha256(manifest), "privacy_manifest_checks": "passed", "accessed_api_reasons": declared}


def source_versions(root):
    spec = (root / "native/project.yml").read_text()
    values = {}
    for key in ["MARKETING_VERSION", "CURRENT_PROJECT_VERSION"]:
        match = re.search(r"^\s+" + key + r":\s*[\"']?([0-9.]+)[\"']?\s*$", spec, re.M)
        require(match is not None, f"Missing version setting: {key}")
        values[key] = match.group(1)
    for platform in ["iOS", "macOS"]:
        info = load_plist(root / f"native/App/{platform}/Info.plist")
        require(info.get("CFBundleShortVersionString") == "$(MARKETING_VERSION)", f"{platform} bundle version does not use MARKETING_VERSION")
        require(info.get("CFBundleVersion") == "$(CURRENT_PROJECT_VERSION)", f"{platform} build string does not use CURRENT_PROJECT_VERSION")
    for key, expression in [("CFBundleShortVersionString", "$(MARKETING_VERSION)"), ("CFBundleVersion", "$(CURRENT_PROJECT_VERSION)")]:
        require(spec.count(f"        {key}: {expression}\n") == 2, f"Both XcodeGen targets must preserve {key}")
    return values


def source_checks(root):
    versions = source_versions(root)
    info = load_plist(root / "native/App/iOS/Info.plist")
    require(info.get("UIRequiresFullScreen") is False, "iPad windowing requires UIRequiresFullScreen=false")
    require({"UIInterfaceOrientationPortrait", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"}.issubset(info.get("UISupportedInterfaceOrientations", [])), "Missing iPhone orientation declaration")
    require(len(info.get("UISupportedInterfaceOrientations~ipad", [])) == 4, "Missing iPad orientation declaration")
    require(bool(info.get("NSSpeechRecognitionUsageDescription")), "Speech purpose string is missing")
    spec = (root / "native/project.yml").read_text()
    require('TARGETED_DEVICE_FAMILY: "1,2"' in spec, "iPhone/iPad target family differs")
    icons = json.loads((root / "native/App/Shared/Assets.xcassets/AppIcon-iOS.appiconset/Contents.json").read_text())
    for image in icons["images"]:
        name = image.get("filename")
        if name:
            require((root / "native/App/Shared/Assets.xcassets/AppIcon-iOS.appiconset" / name).is_file(), f"Missing app icon: {name}")
    declared = validate_manifest(regular(root / APP_MANIFEST))
    return {"scope": "source_only", "technical_source_checks": "passed", "versions": versions,
            "privacy_manifests_checked": True, "accessed_api_reasons": declared, "privacy_declarations_accepted": False,
            "archive_checked": False, "runtime_checked": False, "store_ready": False}


def validate_profile(profile, identifier, team, application_identifier=None, now=None):
    require(isinstance(profile, dict), "Invalid provisioning profile")
    entitlements = profile.get("Entitlements", {})
    require(entitlements.get("get-task-allow") is False, "Development debugging profile is not an App Store profile")
    require("ProvisionedDevices" not in profile, "Device-limited ad hoc/development profile is not an App Store profile")
    require(profile.get("ProvisionsAllDevices") is not True, "Enterprise provisioning is not an App Store profile")
    require(team in profile.get("TeamIdentifier", []), "Profile team differs from the signing team")
    prefix = profile.get("ApplicationIdentifierPrefix", [])
    app_id = entitlements.get("application-identifier")
    require(any(app_id == value + "." + identifier for value in prefix if isinstance(value, str)), "Profile application identifier differs")
    require(application_identifier is None or app_id == application_identifier, "Signed app and profile identifiers differ")
    expires = profile.get("ExpirationDate")
    require(isinstance(expires, datetime.datetime), "Profile expiration is missing")
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=datetime.timezone.utc)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    require(expires > now, "Provisioning profile expired")
    return {"distribution_profile_structure_checks": "passed", "profile_expires_utc": expires.isoformat()}


def live_command(args):
    result = subprocess.run(args, capture_output=True, timeout=30)
    require(result.returncode == 0, "Read-only Apple inspection failed: " + args[0].split("/")[-1])
    return result.stdout, result.stderr


def distribution_checks(app, identifier, run=live_command):
    run(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)])
    out, err = run(["/usr/bin/codesign", "--display", "--verbose=4", str(app)])
    signature = (out + err).decode("utf-8", errors="replace")
    require("Signature=adhoc" not in signature, "Ad hoc signature is not an App Store signature")
    team = re.search(r"^TeamIdentifier=([A-Z0-9]{10})$", signature, re.M)
    require(team is not None, "Signing team is missing")
    out, _ = run(["/usr/bin/codesign", "--display", "--entitlements", "-", str(app)])
    entitlements = plistlib.loads(out)
    require(entitlements.get("get-task-allow") is not True, "App debugging entitlement is enabled")
    app_id = entitlements.get("application-identifier")
    require(isinstance(app_id, str) and app_id.endswith("." + identifier), "Signed app identifier differs")
    require(entitlements.get("com.apple.developer.team-identifier") == team.group(1), "Signed app team entitlement differs")
    profile = app / "embedded.mobileprovision"
    regular(profile)
    out, _ = run(["/usr/bin/security", "cms", "-D", "-i", str(profile)])
    result = validate_profile(plistlib.loads(out), identifier, team.group(1), app_id)
    result.update({"local_signature_integrity_checks": "passed", "profile_sha256": sha256(profile),
                   "certificate_and_profile_trust_accepted": False, "app_store_connect_validation_accepted": False})
    return result


def app_checks(root, app, expected_version, expected_build, expected_identifier="app.reel.ios", run=live_command):
    require(app.is_dir() and not app.is_symlink(), "Pass a real iOS app bundle directory")
    app = app.resolve()
    info_path = app / "Info.plist"
    info = load_plist(info_path)
    require(info.get("CFBundleIdentifier") == expected_identifier, "Bundle identifier differs")
    require(info.get("CFBundleShortVersionString") == expected_version, "Built marketing version differs")
    require(info.get("CFBundleVersion") == expected_build, "Built build string differs")
    require(info.get("CFBundleDisplayName") == "Arya", "Display name differs")
    require(info.get("DTPlatformName") == "iphoneos", "A Simulator bundle is not a distribution candidate")
    sdk = re.fullmatch(r"iphoneos([0-9]+)(?:\.[0-9]+)*", info.get("DTSDKName", ""))
    require(sdk is not None and int(sdk.group(1)) >= 26, "Apple currently requires an iOS 26 or newer SDK")
    require(str(info.get("DTXcode", "")).isdigit() and int(info["DTXcode"]) >= 2600, "Apple currently requires Xcode 26 or newer")
    require(set(info.get("UIDeviceFamily", [])) == {1, 2}, "Built app does not support both iPhone and iPad")
    require(info.get("MinimumOSVersion") == "17.0", "Built minimum OS differs from the reviewed target")
    require(info.get("UIRequiresFullScreen") is False, "Built app disables iPad windowing")
    require(bool(info.get("NSSpeechRecognitionUsageDescription")), "Built app lacks its speech purpose string")
    icon = info.get("CFBundleIcons", {}).get("CFBundlePrimaryIcon", {})
    require(bool(icon.get("CFBundleIconName") or icon.get("CFBundleIconFiles")), "Built primary icon metadata is missing")
    require((app / "Assets.car").is_file() and not (app / "Assets.car").is_symlink(), "Built app assets are missing or symlinked")
    executable = info.get("CFBundleExecutable")
    require(isinstance(executable, str) and Path(executable).name == executable, "Invalid executable name")
    regular(app / executable, 512 * 1024 * 1024)
    manifest, _ = bundled_manifest(root, app, "ios")
    result = {"scope": "ios_bundle_and_distribution_profile", "technical_bundle_checks": "passed",
              "app_path": str(app), "info_sha256": sha256(info_path), "manifest_sha256": sha256(manifest),
              "runtime_checked": False, "store_ready": False,
              "remaining_gates": ["Distribution certificate chain, certificate/profile matching and App Store Connect validation", "Exact-source archive and Xcode aggregate privacy report", "Physical iPhone/iPad workflow acceptance", "AI sharing consent and provider retention assessment", "Owner metadata/legal choices", "Apple review"]}
    result.update(distribution_checks(app, expected_identifier, run=run))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--ios-app", type=Path, help="Signed iOS distribution candidate for the full preflight.")
    mode.add_argument("--built-app", type=Path, action="append", help="Any built macOS or iOS Arya.app; checks only its privacy manifest. Repeatable.")
    parser.add_argument("--expected-version")
    parser.add_argument("--expected-build")
    parser.add_argument("--expected-identifier", default="app.reel.ios")
    args = parser.parse_args()
    try:
        root = args.root.resolve()
        if args.built_app:
            result = {"scope": "built_app_privacy_manifests", "apps": [built_app_checks(root, app) for app in args.built_app],
                      "signature_checked": False, "privacy_declarations_accepted": False, "store_ready": False}
        elif args.ios_app:
            values = source_versions(root)
            result = app_checks(root, args.ios_app, args.expected_version or values["MARKETING_VERSION"], args.expected_build or values["CURRENT_PROJECT_VERSION"], args.expected_identifier)
        else:
            result = source_checks(root)
        print(json.dumps(result, indent=2))
        return 0
    except (GateError, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(json.dumps({"technical_checks": "failed", "store_ready": False, "error": str(error)}, indent=2))
        return 1


if __name__ == "__main__":
    sys.exit(main())

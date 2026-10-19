"""Preflight regression fixtures. No compiler, signing service or device calls."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("store_preflight", Path(__file__).with_name("verify-arya-store-app.py"))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)
REPOSITORY = Path(__file__).resolve().parents[2]


def manifest(**changes):
    value = {"NSPrivacyTracking": False, "NSPrivacyTrackingDomains": [], "NSPrivacyCollectedDataTypes": [],
             "NSPrivacyAccessedAPITypes": [{"NSPrivacyAccessedAPIType": category, "NSPrivacyAccessedAPITypeReasons": sorted(reasons)}
                                           for category, reasons in preflight.DECLARED_REASONS.items()]}
    value.update(changes)
    return plistlib.dumps(value)


class StorePreflightTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="arya-store-preflight-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "source"
        self.app = Path(self.temporary.name) / "Arya.app"
        self.app.mkdir()
        self.team = "TEAM123456"
        self.app_id = "PREFIX1234.app.reel.ios"
        self.info = {
            "CFBundleIdentifier": "app.reel.ios", "CFBundleShortVersionString": "0.3.0", "CFBundleVersion": "1",
            "CFBundleDisplayName": "Arya", "CFBundleExecutable": "Arya", "DTPlatformName": "iphoneos",
            "DTSDKName": "iphoneos27.0", "DTXcode": "2700",
            "UIDeviceFamily": [1, 2], "MinimumOSVersion": "17.0", "UIRequiresFullScreen": False,
            "NSSpeechRecognitionUsageDescription": "Transcribe selected clips.",
            "CFBundleIcons": {"CFBundlePrimaryIcon": {"CFBundleIconName": "AppIcon-iOS"}},
        }
        self.entitlements = {"application-identifier": self.app_id, "com.apple.developer.team-identifier": self.team, "get-task-allow": False}
        self.profile = {"TeamIdentifier": [self.team], "ApplicationIdentifierPrefix": ["PREFIX1234"],
                        "ExpirationDate": datetime.datetime(2099, 1, 1), "Entitlements": self.entitlements.copy()}
        source = self.root / preflight.APP_MANIFEST; source.parent.mkdir(parents=True)
        source.write_bytes(manifest())
        (self.app / "PrivacyInfo.xcprivacy").write_bytes(manifest())
        for name in ["Arya", "Assets.car", "embedded.mobileprovision"]:
            (self.app / name).write_bytes(b"fixture only")
        self.calls = []
        self.write_info()

    def write_info(self):
        (self.app / "Info.plist").write_bytes(plistlib.dumps(self.info))

    def inspect_command(self, args):
        self.calls.append(args)
        if args[0].endswith("security"):
            return plistlib.dumps(self.profile), b""
        if "--entitlements" in args:
            return plistlib.dumps(self.entitlements), b""
        if "--display" in args:
            return b"", ("TeamIdentifier=" + self.team + "\nAuthority=Fixture Distribution\n").encode()
        return b"", b""

    def audit(self):
        return preflight.app_checks(self.root, self.app, "0.3.0", "1", run=self.inspect_command)

    def test_fixture_passes_technical_gates_without_claiming_release_readiness(self):
        result = self.audit()
        self.assertEqual(result["local_signature_integrity_checks"], "passed")
        self.assertFalse(result["certificate_and_profile_trust_accepted"])
        self.assertFalse(result["app_store_connect_validation_accepted"])
        self.assertFalse(result["runtime_checked"])
        self.assertFalse(result["store_ready"])
        self.assertTrue(all(call[0] in ["/usr/bin/codesign", "/usr/bin/security"] for call in self.calls))
        self.assertFalse(any("--sign" in call for call in self.calls))

    def test_simulator_or_version_mismatch_fails_before_apple_inspection(self):
        for key, value in [("DTPlatformName", "iphonesimulator"), ("DTSDKName", "iphoneos17.0"), ("DTXcode", "1500"), ("CFBundleShortVersionString", "1.0"), ("CFBundleVersion", "2"), ("UIDeviceFamily", [2])]:
            old = self.info[key]; self.info[key] = value; self.write_info()
            with self.subTest(key=key), self.assertRaises(preflight.GateError): self.audit()
            self.assertEqual(self.calls, [])
            self.info[key] = old

    def test_missing_or_changed_manifest_fails(self):
        path = self.app / "PrivacyInfo.xcprivacy"; path.unlink()
        with self.assertRaises(preflight.GateError): self.audit()
        path.write_bytes(b"changed manifest")
        with self.assertRaises(preflight.GateError): self.audit()
        path.write_bytes(manifest(NSPrivacyCollectedDataTypes=[]) + b"\n")
        with self.assertRaises(preflight.GateError): self.audit()
        self.assertEqual(self.calls, [])

    def test_committed_manifest_declares_the_reviewed_reasons(self):
        declared = preflight.validate_manifest((REPOSITORY / preflight.APP_MANIFEST).read_bytes())
        self.assertEqual(declared, {category: sorted(reasons) for category, reasons in sorted(preflight.DECLARED_REASONS.items())})
        for category, reasons in preflight.DECLARED_REASONS.items():
            self.assertTrue(reasons <= preflight.APPROVED_REASONS[category])

    def test_manifest_declaration_changes_fail(self):
        entries = plistlib.loads(manifest())["NSPrivacyAccessedAPITypes"]
        def entry(category, *reasons): return {"NSPrivacyAccessedAPIType": category, "NSPrivacyAccessedAPITypeReasons": list(reasons)}
        cases = {
            "tracking": manifest(NSPrivacyTracking=True),
            "tracking as string": manifest(NSPrivacyTracking="false"),
            "tracking domain": manifest(NSPrivacyTrackingDomains=["example.com"]),
            "collected data": manifest(NSPrivacyCollectedDataTypes=[{"NSPrivacyCollectedDataType": "NSPrivacyCollectedDataTypeOtherUserContent"}]),
            "missing key": plistlib.dumps({key: value for key, value in plistlib.loads(manifest()).items() if key != "NSPrivacyTrackingDomains"}),
            "extra key": plistlib.dumps({**plistlib.loads(manifest()), "NSPrivacyExtra": True}),
            "missing category": manifest(NSPrivacyAccessedAPITypes=entries[1:]),
            "extra category": manifest(NSPrivacyAccessedAPITypes=entries + [entry("NSPrivacyAccessedAPICategoryActiveKeyboards", "54BD.1")]),
            "unknown category": manifest(NSPrivacyAccessedAPITypes=entries + [entry("NSPrivacyAccessedAPICategoryFingerprint", "CA92.1")]),
            "repeated category": manifest(NSPrivacyAccessedAPITypes=entries + entries[:1]),
            "reason from another category": manifest(NSPrivacyAccessedAPITypes=[entry(e["NSPrivacyAccessedAPIType"], *(["E174.1"] if e["NSPrivacyAccessedAPIType"].endswith("UserDefaults") else e["NSPrivacyAccessedAPITypeReasons"])) for e in entries]),
            "sdk only reason": manifest(NSPrivacyAccessedAPITypes=[entry(e["NSPrivacyAccessedAPIType"], *e["NSPrivacyAccessedAPITypeReasons"], *(["C56D.1"] if e["NSPrivacyAccessedAPIType"].endswith("UserDefaults") else [])) for e in entries]),
            "approved but unreviewed reason": manifest(NSPrivacyAccessedAPITypes=[entry(e["NSPrivacyAccessedAPIType"], *e["NSPrivacyAccessedAPITypeReasons"], *(["DDA9.1"] if e["NSPrivacyAccessedAPIType"].endswith("FileTimestamp") else [])) for e in entries]),
            "empty reasons": manifest(NSPrivacyAccessedAPITypes=[entry(e["NSPrivacyAccessedAPIType"]) for e in entries]),
            "not a plist": b"<plist><dict>",
            "not a dictionary": plistlib.dumps([]),
        }
        for name, data in cases.items():
            with self.subTest(name=name), self.assertRaises(preflight.GateError):
                preflight.validate_manifest(data)

    def built_app(self, platform):
        app = Path(self.temporary.name) / platform / "Arya.app"
        info = app / preflight.BUNDLE_INFO[platform]; info.parent.mkdir(parents=True)
        info.write_bytes(plistlib.dumps({"CFBundleIdentifier": preflight.BUNDLE_IDENTIFIER[platform]}))
        bundled = app / preflight.BUNDLE_MANIFEST[platform]; bundled.parent.mkdir(parents=True, exist_ok=True)
        bundled.write_bytes(manifest())
        return app, bundled

    def test_built_mac_and_ios_apps_carry_the_manifest_at_their_platform_location(self):
        for platform, location in [("macos", "Contents/Resources/PrivacyInfo.xcprivacy"), ("ios", "PrivacyInfo.xcprivacy")]:
            with self.subTest(platform=platform):
                app, _ = self.built_app(platform)
                result = preflight.built_app_checks(self.root, app)
                self.assertEqual((result["platform"], result["manifest_path"], result["privacy_manifest_checks"]), (platform, location, "passed"))
                self.assertEqual(set(result["accessed_api_reasons"]), set(preflight.DECLARED_REASONS))

    def test_built_app_manifest_missing_misplaced_or_changed_fails(self):
        app, bundled = self.built_app("macos")
        bundled.rename(app / "PrivacyInfo.xcprivacy")
        with self.assertRaises(preflight.GateError): preflight.built_app_checks(self.root, app)
        (app / "PrivacyInfo.xcprivacy").rename(app / "Contents/PrivacyInfo.xcprivacy")
        with self.assertRaises(preflight.GateError): preflight.built_app_checks(self.root, app)
        (app / "Contents/PrivacyInfo.xcprivacy").rename(bundled)
        preflight.built_app_checks(self.root, app)
        bundled.write_bytes(manifest(NSPrivacyTracking=True))
        with self.assertRaises(preflight.GateError): preflight.built_app_checks(self.root, app)
        bundled.write_bytes(manifest())
        (self.root / preflight.APP_MANIFEST).write_bytes(manifest(NSPrivacyTrackingDomains=["example.com"]))
        with self.assertRaises(preflight.GateError): preflight.built_app_checks(self.root, app)

    def test_built_app_identity_and_layout_must_match(self):
        ios, _ = self.built_app("ios")
        (ios / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "app.reel.Reel"}))
        with self.assertRaises(preflight.GateError): preflight.built_app_checks(self.root, ios)
        mac, _ = self.built_app("macos")
        (mac / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "app.reel.ios"}))
        with self.assertRaises(preflight.GateError): preflight.built_app_checks(self.root, mac)
        (mac / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "app.reel.Reel"}))
        (mac / "Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "app.reel.ios"}))
        with self.assertRaises(preflight.GateError): preflight.built_app_checks(self.root, mac)

    def test_built_app_manifest_cannot_come_through_a_symlink(self):
        app, bundled = self.built_app("macos")
        resources = bundled.parent
        external = Path(self.temporary.name) / "external-resources"
        resources.rename(external)
        resources.symlink_to(external, target_is_directory=True)
        with self.assertRaises(preflight.GateError): preflight.built_app_checks(self.root, app)
        resources.unlink(); external.rename(resources)
        outside = Path(self.temporary.name) / "outside.xcprivacy"; outside.write_bytes(manifest())
        bundled.unlink(); bundled.symlink_to(outside)
        with self.assertRaises(preflight.GateError): preflight.built_app_checks(self.root, app)

    def test_debug_ad_hoc_enterprise_expired_or_wrong_id_profile_fails(self):
        now = datetime.datetime(2026, 10, 4, tzinfo=datetime.timezone.utc)
        for change in [{"ProvisionedDevices": ["fixture-device"]}, {"ProvisionsAllDevices": True}, {"ExpirationDate": datetime.datetime(2020, 1, 1)}, {"TeamIdentifier": ["OTHER12345"]}]:
            profile = {**self.profile, **change}
            with self.subTest(change=change), self.assertRaises(preflight.GateError):
                preflight.validate_profile(profile, "app.reel.ios", self.team, self.app_id, now=now)
        for key, value in [("get-task-allow", True), ("application-identifier", "PREFIX1234.other.app")]:
            profile = {**self.profile, "Entitlements": {**self.entitlements, key: value}}
            with self.subTest(key=key), self.assertRaises(preflight.GateError):
                preflight.validate_profile(profile, "app.reel.ios", self.team, self.app_id, now=now)

    def test_signature_failure_is_not_a_pass(self):
        def rejected(args): raise preflight.GateError("signature verification failed")
        with self.assertRaises(preflight.GateError):
            preflight.app_checks(self.root, self.app, "0.3.0", "1", run=rejected)

    def test_resource_symlink_cannot_borrow_an_external_manifest(self):
        bundled = self.app / "PrivacyInfo.xcprivacy"
        external = Path(self.temporary.name) / "external-manifest.xcprivacy"
        bundled.rename(external)
        bundled.symlink_to(external)
        with self.assertRaises(preflight.GateError): self.audit()
        self.assertEqual(self.calls, [])

    def test_legacy_application_prefix_can_differ_from_team(self):
        result = preflight.validate_profile(self.profile, "app.reel.ios", self.team, self.app_id)
        self.assertEqual(result["distribution_profile_structure_checks"], "passed")

    def test_file_growth_is_bounded_and_rejected(self):
        path = Path(self.temporary.name) / "growing-file"
        path.write_bytes(b"base")
        actual_read = os.read
        requested = []
        def growing_read(descriptor, size):
            requested.append(size)
            if len(requested) == 1:
                path.write_bytes(b"x" * 64)
            return actual_read(descriptor, size)
        with patch.object(preflight.os, "read", growing_read), self.assertRaises(preflight.GateError):
            preflight.regular(path, limit=4)
        self.assertEqual(requested, [5])

    def test_path_replacement_during_read_is_rejected(self):
        path = Path(self.temporary.name) / "replaced-file"
        path.write_bytes(b"base")
        actual_open = os.open
        def replacement_open(file, flags):
            descriptor = actual_open(file, flags)
            path.rename(path.with_name("previous-file"))
            path.write_bytes(b"base")
            return descriptor
        with patch.object(preflight.os, "open", replacement_open), self.assertRaises(preflight.GateError):
            preflight.regular(path, limit=4)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "POSIX FIFO fixture")
    def test_fifo_and_fifo_replacement_are_rejected_without_a_blocking_open(self):
        path = Path(self.temporary.name) / "fifo-file"
        os.mkfifo(path)
        actual_open = os.open
        observed = []
        def nonblocking_open(file, flags):
            observed.append(flags)
            return actual_open(file, flags)
        with patch.object(preflight.os, "open", nonblocking_open), self.assertRaises(preflight.GateError):
            preflight.regular(path, limit=4)
        self.assertTrue(observed[0] & os.O_NONBLOCK)
        self.assertTrue(observed[0] & os.O_NOFOLLOW)
        path.unlink(); path.write_bytes(b"base")
        def replacement_open(file, flags):
            descriptor = actual_open(file, flags)
            path.rename(path.with_name("previous-fifo-file"))
            os.mkfifo(path)
            return descriptor
        with patch.object(preflight.os, "open", replacement_open), self.assertRaises(preflight.GateError):
            preflight.regular(path, limit=4)


if __name__ == "__main__":
    unittest.main()

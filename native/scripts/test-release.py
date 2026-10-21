import importlib.util
import hashlib
import io
from contextlib import redirect_stdout, redirect_stderr
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("reel_release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.prepared = tempfile.TemporaryDirectory(prefix="arya-release-writer-")
        cls.writerFixtureCore = Path(cls.prepared.name).resolve() / "core"
        cls.writerFixtureCore.mkdir()
        subprocess.run([shutil.which("node"), str(release.REPO / "editor/scripts/prepare-project-writer.mjs"), "prepare", str(cls.writerFixtureCore)], check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.prepared.cleanup()

    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="reel-release-runtime-")
        self.addCleanup(self.folder.cleanup)
        self.app = Path(self.folder.name).resolve() / "Reel.app"
        contents = self.app / "Contents"
        (contents / "MacOS").mkdir(parents=True)
        shutil.copyfile("/usr/bin/true", contents / "MacOS/Reel")
        (contents / "MacOS/Reel").chmod(0o755)
        with (contents / "Info.plist").open("wb") as target:
            plistlib.dump({"CFBundleExecutable": "Reel", "CFBundleIdentifier": "app.reel.test",
                          "CFBundleShortVersionString": "1.0", "LSMinimumSystemVersion": "14.0", "CFBundlePackageType": "APPL",
                          "CFBundleURLTypes": [{"CFBundleURLSchemes": ["reelfigma", "reelagent"]}]}, target)
        editor = contents / "Resources/editor"
        for file in ("reel-core.js", "web/index.html", "core/project.js", "vendor/preact/dist/preact.module.js",
                     "agent/bridge.mjs", "agent/mcp.mjs", "agent/adapters.mjs", "agent/protocol.mjs",
                     "agent/Reel Agent Bridge.command"):
            output = editor / file
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text("fixture\n")

        integration = Path(__file__).resolve().parents[2]
        original_core = self.writerFixtureCore
        (contents / "Helpers").mkdir()
        shutil.copyfile(original_core / "project-writer", contents / "Helpers/project-writer")
        (contents / "Helpers/project-writer").chmod(0o755)
        manifest = json.loads((original_core / "project-writer.prepared.json").read_text())
        manifest["binaryRelativePath"] = "../../../Helpers/project-writer"
        (editor / "core/project-writer.prepared.json").write_text(json.dumps(manifest))
        (editor / "scripts").mkdir()
        shutil.copyfile(integration / "editor/scripts/prepare-project-writer.mjs", editor / "scripts/prepare-project-writer.mjs")
        shutil.copyfile(integration / "editor/core/project-writer-manifest.mjs", editor / "core/project-writer-manifest.mjs")
        shutil.copyfile(integration / "editor/core/project-persistence.mjs", editor / "core/project-persistence.mjs")

    def sign(self, runtime):
        command = ["codesign", "--force", "--sign", "-", "--entitlements", str(release.ENTITLEMENTS)]
        if runtime:
            command.extend(["--options", "runtime"])
        subprocess.run(command + [str(self.app)], check=True, capture_output=True)

    def testFolderNameCannotFakeHardenedRuntime(self):
        self.sign(False)
        with self.assertRaisesRegex(ValueError, "hardened runtime"):
            release.validate_bundle(self.app)

    def testRealHardenedSignatureAndEntitlementsPass(self):
        self.sign(True)
        self.assertTrue(release.validate_bundle(self.app)["entitlements"]["com.apple.security.network.client"])
        with self.assertRaisesRegex(ValueError, "Developer ID"):
            release.validate_bundle(self.app, signed=True)

    def testArchivePreservesExistingAndDanglingOutput(self):
        class Args:
            output = self.folder.name
        with self.assertRaisesRegex(ValueError, "already exists"):
            release.archive(Args())
        output = Path(self.folder.name) / "linked-output"
        output.symlink_to(Path(self.folder.name) / "absent")
        Args.output = str(output)
        with self.assertRaisesRegex(ValueError, "already exists"):
            release.archive(Args())
        self.assertTrue(output.is_symlink())

    def testMissingCompanionOrPairingCallbackFails(self):
        launcher = self.app / "Contents/Resources/editor/agent/Reel Agent Bridge.command"
        launcher.unlink()
        with self.assertRaisesRegex(ValueError, "Agent Bridge.command"):
            release.validate_bundle(self.app)
        launcher.write_text("fixture\n")
        info_path = self.app / "Contents/Info.plist"
        with info_path.open("rb") as source:
            info = plistlib.load(source)
        info["CFBundleURLTypes"] = [{"CFBundleURLSchemes": ["reelfigma"]}]
        with info_path.open("wb") as target:
            plistlib.dump(info, target)
        with self.assertRaisesRegex(ValueError, "pairing callback"):
            release.validate_bundle(self.app)

    def testActualPreparedHelperHasUniversalReceiptWithoutPublicationClaim(self):
        self.sign(True)
        with (self.app / "Contents/Info.plist").open("rb") as source:
            info = plistlib.load(source)
        receipt = release.validate_persistence(self.app, info, None)
        self.assertEqual(receipt["architectures"], ["arm64", "x86_64"])
        self.assertEqual(receipt["minimumMacOS"], "14.0")
        self.assertEqual(receipt["signatureMode"], "development")

    def testPersistenceDependencyTamperFailsBeforeInvocation(self):
        script = self.app / "Contents/Resources/editor/scripts/prepare-project-writer.mjs"
        script.write_text("throw Error('never execute changed code')")
        with patch.object(release, "run") as command:
            with self.assertRaisesRegex(ValueError, "dependency changed"):
                release.validate_persistence(self.app, {"LSMinimumSystemVersion": "14.0"}, None)
            command.assert_not_called()

    def testChangedPreparedBinaryAndUnsupportedAppMinimumFail(self):
        self.sign(True)
        binary = self.app / "Contents/Helpers/project-writer"
        original = binary.read_bytes()
        binary.write_bytes(original + b"changed")
        with self.assertRaises(subprocess.CalledProcessError):
            release.validate_persistence(self.app, {"LSMinimumSystemVersion": "14.0"}, None)
        binary.write_bytes(original)
        with self.assertRaisesRegex(ValueError, "newer macOS"):
            release.validate_persistence(self.app, {"LSMinimumSystemVersion": "13.0"}, None)

    def testReleaseEntitlementsLetTheSandboxedAppStartTheAssistantInTerminal(self):
        # macOS will not open a .command file the sandboxed app wrote, so Arya asks Terminal by Apple Event.
        entitlements = plistlib.loads(release.ENTITLEMENTS.read_bytes())
        self.assertTrue(entitlements["com.apple.security.automation.apple-events"])
        self.assertEqual(entitlements["com.apple.security.temporary-exception.apple-events"], ["com.apple.Terminal"])
        info = plistlib.loads((release.REPO / "native/App/macOS/Info.plist").read_bytes())
        self.assertIn("Terminal", info["NSAppleEventsUsageDescription"])

    def testSignedCandidateCannotClaimPublicationReadiness(self):
        entitlements = plistlib.loads(release.ENTITLEMENTS.read_bytes())
        signature = "CodeDirectory flags=0x10000(runtime)\nAuthority=Developer ID Application: Fixture\n"
        runtime = SimpleNamespace(validate=lambda app, info: {"version": "fixture"})
        with patch.object(release, "run", return_value=plistlib.dumps(entitlements).decode()), \
             patch.object(release.subprocess, "run", return_value=SimpleNamespace(stderr=signature)), \
             patch.object(release, "load_runtime_dependency", return_value=runtime), \
             patch.object(release, "validate_persistence", return_value={"signatureMode": "fixture"}):
            report = release.validate_bundle(self.app, signed=True)
        self.assertTrue(report["signedCandidateValidated"])
        self.assertFalse(report["readyToPublish"])
        self.assertEqual(report["notarization"], "not performed")
        self.assertEqual(report["freshInstallAcceptance"], "not performed")
        self.assertNotIn("distributionReady", report)


class ReleaseNotarizationTests(unittest.TestCase):
    """Pure tests. Apple tools, signing and compilation are never executed."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="arya-notarization-pure-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.app = self.root / "Arya.app"
        (self.app / "Contents").mkdir(parents=True)
        self.output = self.root / "output"
        self.output.mkdir()
        self.package = self.output / "Arya.zip"
        self.package.write_bytes(b"original archive stays untouched")
        self.args = SimpleNamespace(app=str(self.app), zip=str(self.package), profile="existing-fixture-profile")
        self.submission_id = "12345678-1234-1234-1234-123456789abc"
        self.response = json.dumps({"status": "Accepted", "id": self.submission_id})
        self.calls = []
        self.stapled = False
        self.external = patch.object(release.subprocess, "run", side_effect=AssertionError("No real tool may run in pure notarization tests"))
        self.external.start()
        self.addCleanup(self.external.stop)
        self.validation = patch.object(release, "validate_bundle", return_value={"bundleID": "test.arya.fixture", "version": "1.2.3"})
        self.validate = self.validation.start()
        self.addCleanup(self.validation.stop)

    def runner(self, *args, capture=False):
        self.calls.append(tuple(str(arg) for arg in args))
        if args[0] == "ditto":
            target = Path(args[-1])
            self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
            target.write_bytes(b"fixture ZIP with ticket" if self.stapled else b"fixture ZIP before ticket")
        elif args[:3] == ("xcrun", "notarytool", "submit"):
            self.assertTrue(capture)
            self.assertEqual(args[-2:], ("--output-format", "json"))
            self.assertNotEqual(Path(args[3]).parent, self.output)
            return self.response
        elif args[:3] == ("xcrun", "stapler", "staple"):
            self.stapled = True
        elif args[:3] != ("xcrun", "stapler", "validate") and args[0] != "spctl":
            raise AssertionError("Unexpected fixture command")
        return "" if capture else None

    def notarize(self, runner=None):
        with patch.object(release, "run", side_effect=runner or self.runner), redirect_stdout(io.StringIO()):
            return release.notarize(self.args)

    def assert_no_delivery(self):
        self.assertFalse((self.output / "Arya-notarized.zip").exists())
        self.assertFalse((self.output / "Arya-notarization.json").exists())
        self.assertFalse(any(p.name.startswith(".arya-notarization-") for p in self.output.iterdir()))

    def test_accepted_receipt_binds_distinct_zip_bytes_without_publication_claim(self):
        original = self.package.read_bytes()
        report = self.notarize()
        self.validate.assert_called_once_with(self.app, signed=True)
        self.assertEqual(self.package.read_bytes(), original)
        self.assertEqual(report["notarySubmissionID"], self.submission_id)
        self.assertEqual(report["notarizationStatus"], "Accepted")
        self.assertTrue(report["appStapleAndGatekeeperPassed"])
        self.assertFalse(report["readyToPublish"])
        for key in ("freshInstallAcceptance", "currentSourceUIAcceptance", "releaseOwnerApproval"):
            self.assertEqual(report[key], "not performed")
        for key in ("submission", "delivery"):
            actual = (self.output / report[key]["file"]).read_bytes()
            self.assertEqual(hashlib.sha256(actual).hexdigest(), report[key]["sha256"])
            self.assertEqual(len(actual), report[key]["bytes"])
        self.assertNotEqual(report["submission"]["sha256"], report["delivery"]["sha256"])
        self.assertEqual(json.loads((self.output / "Arya-notarization.json").read_text()), report)
        self.assertEqual(sorted(p.name for p in self.output.iterdir()), ["Arya-notarization.json", "Arya-notarized.zip", "Arya-submission.zip", "Arya.zip"])
        submit = next(i for i, c in enumerate(self.calls) if c[:3] == ("xcrun", "notarytool", "submit"))
        staple = next(i for i, c in enumerate(self.calls) if c[:3] == ("xcrun", "stapler", "staple"))
        self.assertLess(submit, staple)

    def test_successful_exit_with_nonaccepted_status_never_staples_or_delivers(self):
        for response in ({"status": "Invalid", "id": self.submission_id}, {"status": "In Progress", "id": self.submission_id}, {}, [], None):
            with self.subTest(response=response):
                self.response = json.dumps(response)
                with self.assertRaisesRegex(ValueError, "did not accept"):
                    self.notarize()
                self.assertFalse(self.stapled)
                self.assert_no_delivery()
                self.assertEqual(list(self.output.iterdir()), [self.package])

    def test_uppercase_uuid_receipt_is_accepted_and_preserved(self):
        self.response = json.dumps({"status": "Accepted", "id": self.submission_id.upper()})
        report = self.notarize()
        self.assertEqual(report["notarySubmissionID"], self.submission_id.upper())

    def test_malformed_json_and_invalid_submission_id_fail_without_tool_output(self):
        for response in ("private account message", json.dumps({"status": "Accepted"}), json.dumps({"status": "Accepted", "id": "private-account-id"}), json.dumps({"status": "Accepted", "id": 5})):
            with self.subTest(response=response):
                self.response = response
                with self.assertRaisesRegex(ValueError, "JSON receipt|submission ID") as error:
                    self.notarize()
                self.assertNotIn("private", str(error.exception))
                self.assertFalse(self.stapled)
                self.assert_no_delivery()

    def test_apple_tool_failure_never_publishes_delivery_or_receipt(self):
        for failed in (("xcrun", "notarytool", "submit"), ("xcrun", "stapler", "staple"), ("xcrun", "stapler", "validate"), ("spctl", "--assess", "--type")):
            with self.subTest(failed=failed):
                def runner(*args, capture=False):
                    if args[:3] == failed:
                        raise subprocess.CalledProcessError(1, args)
                    return self.runner(*args, capture=capture)
                with self.assertRaises(subprocess.CalledProcessError):
                    self.notarize(runner)
                self.assert_no_delivery()
                self.assertEqual(list(self.output.iterdir()), [self.package])
                self.stapled = False

    def test_existing_files_and_dangling_links_are_preserved_before_validation(self):
        for name in ("Arya-notarized.zip", "Arya-submission.zip", "Arya-notarization.json"):
            for symlink in (False, True):
                with self.subTest(name=name, symlink=symlink):
                    target = self.output / name
                    target.symlink_to(self.output / "absent") if symlink else target.write_bytes(b"keep existing")
                    with self.assertRaisesRegex(ValueError, "already exists"):
                        self.notarize()
                    self.validate.assert_not_called()
                    self.assertEqual(self.calls, [])
                    if symlink:
                        self.assertTrue(target.is_symlink())
                    else:
                        self.assertEqual(target.read_bytes(), b"keep existing")
                    target.unlink()

    def test_racing_files_are_never_overwritten(self):
        for name in ("Arya-submission.zip", "Arya-notarization.json", "Arya-notarized.zip"):
            with self.subTest(name=name):
                def runner(*args, capture=False):
                    value = self.runner(*args, capture=capture)
                    if args[:3] == ("xcrun", "notarytool", "submit"):
                        (self.output / name).write_bytes(b"keep racing file")
                    return value
                with self.assertRaises(FileExistsError):
                    self.notarize(runner)
                self.assertEqual((self.output / name).read_bytes(), b"keep racing file")
                if name != "Arya-notarized.zip":
                    self.assertFalse((self.output / "Arya-notarized.zip").exists())
                for item in self.output.iterdir():
                    if item != self.package:
                        item.unlink()
                self.stapled = False

    def test_input_links_and_parent_aliases_are_rejected_before_validation(self):
        alias = self.root / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        app_link = self.root / "AppAlias.app"
        app_link.symlink_to(self.app, target_is_directory=True)
        package_link = self.output / "Alias.zip"
        package_link.symlink_to(self.package)
        for app, package in ((app_link, self.package), (alias / "Arya.app", self.package), (self.app, package_link), (self.app, alias / "output/Arya.zip")):
            with self.subTest(app=app, package=package):
                self.args.app, self.args.zip = str(app), str(package)
                with self.assertRaisesRegex(ValueError, "symbolic links"):
                    self.notarize()
                self.validate.assert_not_called()
                self.assertEqual(self.calls, [])

    def test_special_input_and_non_zip_are_rejected_before_validation(self):
        fifo = self.output / "input.zip"
        os.mkfifo(fifo)
        for file, message in ((fifo, "regular file"), (self.output, "regular file")):
            self.args.zip = str(file)
            with self.assertRaisesRegex(ValueError, message):
                self.notarize()
        other = self.output / "Arya.dmg"
        other.write_bytes(b"fixture")
        self.args.zip = str(other)
        with self.assertRaisesRegex(ValueError, "ZIP produced"):
            self.notarize()
        self.validate.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_output_inside_app_is_rejected_before_validation(self):
        inside = self.app / "Contents/Arya.zip"
        inside.write_bytes(b"fixture")
        self.args.zip = str(inside)
        with self.assertRaisesRegex(ValueError, "outside the app bundle"):
            self.notarize()
        self.validate.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_changed_parent_does_not_publish_to_replacement(self):
        displaced = self.root / "displaced-output"
        def runner(*args, capture=False):
            value = self.runner(*args, capture=capture)
            if args[0] == "ditto" and self.stapled:
                self.output.rename(displaced)
                self.output.mkdir()
            return value
        with self.assertRaisesRegex(ValueError, "directory changed"):
            self.notarize(runner)
        self.assertEqual(list(self.output.iterdir()), [])
        self.assertFalse((displaced / "Arya-notarized.zip").exists())
        self.assertEqual((displaced / "Arya.zip").read_bytes(), b"original archive stays untouched")

    def test_notarize_cli_checks_only_its_required_tools(self):
        argv = ["release.py", "notarize", "--app", str(self.app), "--zip", str(self.package), "--profile", "fixture"]
        checked = []
        def which(tool):
            checked.append(tool)
            return None if tool == "xcodebuild" else "/fixture/" + tool
        with patch.object(release.sys, "argv", argv), patch.object(release.shutil, "which", side_effect=which), patch.object(release, "notarize") as operation:
            self.assertEqual(release.main(), 0)
        self.assertEqual(checked, ["codesign", "ditto", "xcrun", "spctl"])
        operation.assert_called_once()

    def test_missing_notary_tool_fails_before_the_operation(self):
        argv = ["release.py", "notarize", "--app", str(self.app), "--zip", str(self.package), "--profile", "fixture"]
        with patch.object(release.sys, "argv", argv), patch.object(release.shutil, "which", side_effect=lambda tool: None if tool == "xcrun" else "/fixture/" + tool), patch.object(release, "notarize") as operation, redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                release.main()
        operation.assert_not_called()


if __name__ == "__main__":
    unittest.main()

"""Pure packaging tests. External Apple tools are injected, never executed."""
import importlib.util
import json
import hashlib
import io
from contextlib import redirect_stderr
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("arya_installer", Path(__file__).with_name("package-arya-installer.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="arya-installer-tests-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.app = self.root / "Arya.app"
        (self.app / "Contents/MacOS").mkdir(parents=True)
        (self.app / "Contents/MacOS/Arya").write_bytes(b"fixture executable")
        self.info = {"CFBundleExecutable": "Arya", "CFBundleIdentifier": "test.arya.fixture",
                     "CFBundleShortVersionString": "1.2.3", "CFBundleVersion": "7",
                     "CFBundleDisplayName": "Arya", "CFBundleName": "Arya",
                     "CFBundlePackageType": "APPL", "LSMinimumSystemVersion": "14.0"}
        self.save_info()
        self.calls = []
        self.notary_status = "Accepted"
        self.notary_id = "12345678-1234-1234-1234-123456789abc"
        self.notary_response = None
        self.architectures = "arm64 x86_64"
        self.minos = "14.0"
        self.runtime_receipt = {"version": installer.node_runtime.VERSION, "architectures": ["arm64", "x86_64"],
                                "teamIdentifier": "ABCDEFGHIJ", "manifestSHA256": "a" * 64, "signedSHA256": {"arm64": "b" * 64, "x86_64": "c" * 64}}
        self.persistence_receipt = {"architectures": ["arm64", "x86_64"], "minimumMacOS": "14.0", "signatureMode": "developer-id", "teamIdentifier": "ABCDEFGHIJ", "binarySHA256": "d" * 64, "manifestSHA256": "e" * 64}
        self.args = SimpleNamespace(app=str(self.app), output=str(self.root / "output"),
                                    mode="rehearsal", identity=None, profile=None)
        self.platform = patch.object(installer.sys, "platform", "darwin")
        self.platform.start()
        self.addCleanup(self.platform.stop)

    def save_info(self):
        (self.app / "Contents/Info.plist").write_bytes(plistlib.dumps(self.info))

    def validator(self, app, signed=False):
        return {"bundleID": self.info["CFBundleIdentifier"], "signature": "Developer ID" if signed else "local",
                "runtime": self.runtime_receipt if signed else None, "persistence": self.persistence_receipt if signed else None}

    def runner(self, *args):
        self.calls.append(tuple(str(arg) for arg in args))
        if args[0] == "lipo":
            return self.architectures
        if args[0] == "otool":
            return f"Load command 1\n cmd LC_BUILD_VERSION\n minos {self.minos}\n sdk 27.0\nLoad command 2\n cmd LC_SOURCE_VERSION\n version 100.0\n"
        if args[0] == "ditto":
            shutil.copytree(args[1], args[2], symlinks=True)
        if args[:2] == ("hdiutil", "create"):
            Path(args[-1]).write_bytes(b"fixture disk image, not a real DMG")
            self.staging = Path(args[3])
        if args[:2] == ("hdiutil", "attach"):
            self.mount = Path(args[5])
            for item in self.staging.iterdir():
                target = self.mount / item.name
                if item.is_symlink():
                    target.symlink_to(item.readlink())
                elif item.is_dir():
                    shutil.copytree(item, target, symlinks=True)
                else:
                    shutil.copyfile(item, target)
            return plistlib.dumps({"system-entities": [{"mount-point": str(self.mount), "dev-entry": "/dev/disk99s1"}]}).decode()
        if args[:2] == ("hdiutil", "detach"):
            for item in self.mount.iterdir():
                if item.is_dir() and not item.is_symlink():
                    shutil.rmtree(item)
                else:
                    item.unlink()
        if args[:3] == ("xcrun", "notarytool", "submit"):
            return self.notary_response if self.notary_response is not None else json.dumps({"status": self.notary_status, "id": self.notary_id})
        return ""

    def package(self, runner=None):
        return installer.package(self.args, runner=runner or self.runner, validator=self.validator)

    def official(self):
        self.args.mode = "official"
        self.args.identity = "Developer ID Application: Fixture Team (TEST)"
        self.args.profile = "existing-fixture-profile"

    def test_rehearsal_is_explicit_and_has_integrity_receipt(self):
        before = installer.bundle_digest(self.app)
        report = self.package()
        self.assertFalse(report["officialDownload"])
        self.assertFalse(report["readyToPublish"])
        self.assertFalse(report["appStapleAndGatekeeperPassed"])
        self.assertFalse(report["dmgStapleAndGatekeeperPassed"])
        self.assertIn("REHEARSAL", report["image"])
        self.assertEqual(installer.bundle_digest(self.app), before)
        output = Path(self.args.output)
        self.assertEqual(installer.sha256(output / report["image"]), report["sha256"])
        self.assertEqual(json.loads((output / "distribution.json").read_text()), report)
        self.assertEqual((output / "SHA256SUMS").read_text(), f"{report['sha256']}  {report['image']}\n")
        self.assertFalse(any(call[0] in ("codesign", "xcrun", "spctl") for call in self.calls))
        self.assertEqual(sorted(path.name for path in output.iterdir()), sorted([report["image"], "SHA256SUMS", "distribution.json"]))

    def test_official_requires_both_apple_acceptance_checks(self):
        self.official()
        report = self.package()
        self.assertTrue(report["appStapleAndGatekeeperPassed"])
        self.assertTrue(report["dmgStapleAndGatekeeperPassed"])
        self.assertEqual(report["architectures"], ["arm64", "x86_64"])
        self.assertEqual(report["freshMacInstallAcceptance"], "not performed by this tool")
        self.assertEqual(report["notarySubmissionID"], self.notary_id)
        self.assertEqual(report["bridgeRuntime"], {**{k: v for k, v in self.runtime_receipt.items() if k != "teamIdentifier"}, "persistence": self.persistence_receipt})
        self.assertEqual(report["nodeRuntimeValidatorSourceSHA256"], installer.NODE_RUNTIME_SOURCE_SHA256)
        submit = next(index for index, call in enumerate(self.calls) if call[:3] == ("xcrun", "notarytool", "submit"))
        staple = next(index for index, call in enumerate(self.calls) if call[:3] == ("xcrun", "stapler", "staple"))
        self.assertLess(submit, staple)
        self.assertTrue(any(call[:6] == ("spctl", "--assess", "--type", "open", "--context", "context:primary-signature") for call in self.calls))

    def test_image_instructions_identify_release_and_keep_manual_acceptance_open(self):
        for mode in ("rehearsal", "official"):
            with self.subTest(mode=mode):
                self.args.output = str(self.root / mode)
                if mode == "official":
                    self.official()
                captured = {}
                before = installer.bundle_digest(self.app)
                def capture(*args):
                    value = self.runner(*args)
                    if args[:2] == ("hdiutil", "create"):
                        captured["staged"] = (self.staging / "Install Arya.txt").read_bytes()
                    if args[:2] == ("hdiutil", "attach"):
                        captured["mounted"] = (self.mount / "Install Arya.txt").read_bytes()
                    return value
                report = self.package(capture)
                self.assertEqual(captured["staged"], captured["mounted"])
                self.assertEqual(report["installationInstructionsSHA256"], hashlib.sha256(captured["mounted"]).hexdigest())
                text = captured["mounted"].decode("utf-8")
                self.assertIn("Install Arya 1.2.3, build 7\n", text)
                self.assertIn("Requires macOS 14.0 or newer.\n", text)
                self.assertIn("Supported Macs: Apple silicon, Intel.\n", text)
                self.assertEqual(text.startswith("REHEARSAL ONLY."), mode == "rehearsal")
                self.assertIn("press Control-C in that companion's window", text)
                self.assertIn("backup made before the update", text)
                self.assertIn("The editor works without an AI account.", text)
                self.assertIn("Open Getting started on the start screen", text)
                self.assertIn("Install Claude Code\nor Codex using the provider's official instructions", text)
                self.assertIn("Arya supplies a separate companion", text)
                self.assertNotIn("its official companion", text)
                self.assertEqual(installer.bundle_digest(self.app), before)
                self.assertEqual(report["updateMechanism"], "manual replacement in Applications")
                for key in ("freshMacInstallAcceptance", "manualUpdateAcceptance", "manualRollbackAcceptance"):
                    self.assertEqual(report[key], "not performed by this tool")
                self.assertFalse(report["readyToPublish"])

    def test_different_candidate_metadata_changes_instructions(self):
        first = self.package()
        self.info.update(CFBundleShortVersionString="2.0", CFBundleVersion="8", LSMinimumSystemVersion="15.0")
        self.save_info()
        self.architectures = "arm64"
        self.args.output = str(self.root / "next-output")
        def capture(*args):
            value = self.runner(*args)
            if args[:2] == ("hdiutil", "create"):
                self.next_text = (self.staging / "Install Arya.txt").read_text()
            return value
        second = self.package(capture)
        self.assertIn("Install Arya 2.0, build 8\n", self.next_text)
        self.assertIn("Requires macOS 15.0 or newer.\n", self.next_text)
        self.assertIn("Supported Macs: Apple silicon.\n", self.next_text)
        self.assertNotIn("Intel", self.next_text)
        self.assertNotEqual(first["installationInstructionsSHA256"], second["installationInstructionsSHA256"])

    def test_uninstall_instructions_require_companion_stop_and_preserve_user_files(self):
        user_files = {
            "projects/First/reel.project.json": b'{"name":"First"}',
            "projects/First/media/source.mov": b"disposable source fixture",
            "exports/First.mp4": b"disposable export fixture",
            "support/Reel/AgentBridge/bridge.mjs": b"disposable companion fixture",
            "preferences.json": b'{"theme":"dark"}',
        }
        for name, data in user_files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        for mode in ("rehearsal", "official"):
            with self.subTest(mode=mode):
                self.args.output = str(self.root / (mode + "-uninstall"))
                if mode == "official":
                    self.official()
                captured = {}
                def capture(*args):
                    value = self.runner(*args)
                    if args[:2] == ("hdiutil", "attach"):
                        captured["text"] = (self.mount / "Install Arya.txt").read_text()
                    return value
                with patch.object(installer.subprocess, "run", side_effect=AssertionError("An external process must not run in this fixture")):
                    report = self.package(capture)
                self.assertIn("Uninstall the Mac app\n", captured["text"])
                uninstall = captured["text"].split("Uninstall the Mac app\n", 1)[1]
                self.assertLess(uninstall.index("wait for it to exit"), uninstall.index("move Arya.app"))
                self.assertIn("Quitting Arya does not stop that separate companion", uninstall)
                self.assertIn("Keep project folders, their media and exported videos", uninstall)
                self.assertIn("preferences, account connections or companion support files", uninstall)
                self.assertEqual(report["uninstallAcceptance"], "not performed by this tool")
                self.assertFalse(report["readyToPublish"])
                saved = json.loads((Path(self.args.output) / "distribution.json").read_text())
                self.assertEqual(saved["uninstallAcceptance"], "not performed by this tool")
                for name, data in user_files.items():
                    self.assertEqual((self.root / name).read_bytes(), data)

    def test_rehearsal_platform_requirements_reach_mounted_instructions_and_receipt(self):
        for number, (architectures, minimum, names) in enumerate([
            ("arm64", "14.0", "Apple silicon"),
            ("x86_64", "15.0", "Intel"),
            ("arm64 x86_64", "14.0", "Apple silicon, Intel"),
        ]):
            with self.subTest(architectures=architectures, minimum=minimum):
                self.architectures = architectures
                self.minos = minimum
                self.info["LSMinimumSystemVersion"] = minimum
                self.save_info()
                self.args.output = str(self.root / ("platform-" + str(number)))
                captured = {}
                def capture(*args):
                    value = self.runner(*args)
                    if args[:2] == ("hdiutil", "attach"):
                        captured["text"] = (self.mount / "Install Arya.txt").read_text()
                    return value
                with patch.object(installer.subprocess, "run", side_effect=AssertionError("An external process must not run in this fixture")):
                    report = self.package(capture)
                self.assertIn(f"Requires macOS {minimum} or newer.\n", captured["text"])
                self.assertIn(f"Supported Macs: {names}.\n", captured["text"])
                saved = json.loads((Path(self.args.output) / "distribution.json").read_text())
                self.assertEqual(saved["minimumMacOS"], minimum)
                self.assertEqual(saved["architectures"], sorted(architectures.split()))
                self.assertEqual(saved["installationInstructionsSHA256"], hashlib.sha256(captured["text"].encode()).hexdigest())
                self.assertEqual(saved, report)
                self.assertFalse(saved["readyToPublish"])

    def test_altered_mounted_instructions_detach_without_publication(self):
        def alter(*args):
            value = self.runner(*args)
            if args[:2] == ("hdiutil", "attach"):
                (self.mount / "Install Arya.txt").write_text("Install an unverified prior build\n")
            return value
        with self.assertRaisesRegex(ValueError, "installation instructions differ"):
            self.package(alter)
        self.assertIn(("hdiutil", "detach", "/dev/disk99s1"), self.calls)
        self.assertEqual(list(Path(self.args.output).iterdir()), [])

    def test_notary_rejection_never_publishes_image(self):
        self.official()
        self.notary_status = "Invalid"
        with self.assertRaisesRegex(ValueError, "did not accept"):
            self.package()
        self.assertEqual(list(Path(self.args.output).iterdir()), [])
        self.assertFalse(any(call[:3] == ("xcrun", "stapler", "staple") for call in self.calls))

    def test_notary_receipt_requires_valid_json_and_submission_id(self):
        self.official()
        for response in ("private account message", "[]", "null", "{}", json.dumps({"status": "Accepted"}), json.dumps({"status": "Accepted", "id": "private-account-id"}), json.dumps({"status": "Accepted", "id": 7})):
            with self.subTest(response=response):
                self.notary_response = response
                with self.assertRaisesRegex(ValueError, "JSON receipt|did not accept|submission ID") as error:
                    self.package()
                self.assertNotIn("private", str(error.exception))
                self.assertFalse(any(call[:3] == ("xcrun", "stapler", "staple") and call[-1].endswith(".dmg") for call in self.calls))
                self.assertEqual(list(Path(self.args.output).iterdir()), [])
                Path(self.args.output).rmdir()

    def test_existing_output_is_preserved(self):
        output = Path(self.args.output)
        output.mkdir()
        (output / "keep.txt").write_text("keep")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.package()
        self.assertEqual((output / "keep.txt").read_text(), "keep")
        self.assertFalse(any(call[0] == "ditto" for call in self.calls))

    def test_dangling_output_link_is_preserved(self):
        output = Path(self.args.output)
        output.symlink_to(self.root / "missing")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.package()
        self.assertTrue(output.is_symlink())

    def test_input_and_output_parent_links_are_rejected(self):
        link = self.root / "alias"
        link.symlink_to(self.root, target_is_directory=True)
        self.args.app = str(link / "Arya.app")
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            self.package()
        self.args.app = str(self.app)
        self.args.output = str(link / "output")
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            self.package()

    def test_external_bundle_link_is_rejected_internal_link_is_preserved(self):
        link = self.app / "Contents/link"
        link.symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            self.package()
        link.unlink()
        link.symlink_to("MacOS/Arya")
        self.assertEqual(installer.canonical_input(self.app), self.app)

    def test_invalid_minimum_or_architecture_stops_before_output(self):
        self.minos = "15.0"
        with self.assertRaisesRegex(ValueError, "minimum OS"):
            self.package()
        self.minos = "14.0"
        self.architectures = "arm64 ppc"
        with self.assertRaisesRegex(ValueError, "architectures"):
            self.package()
        self.assertFalse(Path(self.args.output).exists())

    def test_missing_minimum_os_and_path_executable_are_rejected(self):
        self.info.pop("LSMinimumSystemVersion")
        self.save_info()
        with self.assertRaisesRegex(ValueError, "minimum macOS"):
            self.package()
        self.info["LSMinimumSystemVersion"] = "14.0"
        self.info["CFBundleExecutable"] = "../../outside"
        self.save_info()
        with self.assertRaisesRegex(ValueError, "CFBundleExecutable"):
            self.package()

    def test_brand_and_credentials_are_gates(self):
        self.official()
        self.info["CFBundleDisplayName"] = "Reel"
        self.save_info()
        with self.assertRaisesRegex(ValueError, "Arya.app"):
            self.package()
        self.info["CFBundleDisplayName"] = "Arya"
        self.save_info()
        self.args.profile = None
        with self.assertRaisesRegex(ValueError, "existing --profile"):
            self.package()
        self.args.profile = "fixture"
        self.args.identity = "Apple Development: Fixture"
        with self.assertRaisesRegex(ValueError, "Developer ID"):
            self.package()
        self.args.mode = "rehearsal"
        with self.assertRaisesRegex(ValueError, "must not use"):
            self.package()

    def test_tool_failure_does_not_publish(self):
        def fail_verify(*args):
            if args[:2] == ("hdiutil", "verify"):
                raise ValueError("fixture verification failed")
            return self.runner(*args)
        with self.assertRaisesRegex(ValueError, "verification failed"):
            self.package(fail_verify)
        self.assertEqual(list(Path(self.args.output).iterdir()), [])

    def test_changed_source_copy_is_rejected(self):
        def change_copy(*args):
            value = self.runner(*args)
            if args[0] == "ditto":
                (Path(args[2]) / "Contents/MacOS/Arya").write_bytes(b"changed")
            return value
        with self.assertRaisesRegex(ValueError, "changed during packaging"):
            self.package(change_copy)
        self.assertFalse(any(call[0] == "hdiutil" for call in self.calls))

    def test_atomic_publish_wont_replace_racing_file(self):
        def race(*args):
            value = self.runner(*args)
            if args[:2] == ("hdiutil", "verify"):
                (Path(self.args.output) / "SHA256SUMS").write_text("keep race")
            return value
        with self.assertRaises(FileExistsError):
            self.package(race)
        self.assertEqual((Path(self.args.output) / "SHA256SUMS").read_text(), "keep race")
        self.assertFalse(list(Path(self.args.output).glob("*.dmg")))

    def test_non_macos_stops_before_any_tool(self):
        with patch.object(installer.sys, "platform", "linux"):
            with self.assertRaisesRegex(ValueError, "requires macOS"):
                self.package()
        self.assertEqual(self.calls, [])

    def test_mounted_app_corruption_is_rejected_and_owned_image_is_detached(self):
        def corrupt_mount(*args):
            value = self.runner(*args)
            if args[:2] == ("hdiutil", "attach"):
                (self.mount / "Arya.app/Contents/MacOS/Arya").write_bytes(b"corrupt mount")
            return value
        with self.assertRaisesRegex(ValueError, "differs from"):
            self.package(corrupt_mount)
        self.assertIn(("hdiutil", "detach", "/dev/disk99s1"), self.calls)
        self.assertFalse(list(Path(self.args.output).glob("*.dmg")))

    def test_invalid_mounted_applications_shortcut_is_rejected(self):
        def replace_shortcut(*args):
            value = self.runner(*args)
            if args[:2] == ("hdiutil", "attach"):
                shortcut = self.mount / "Applications"
                shortcut.unlink()
                shortcut.symlink_to(self.root)
            return value
        with self.assertRaisesRegex(ValueError, "shortcut is invalid"):
            self.package(replace_shortcut)
        self.assertIn(("hdiutil", "detach", "/dev/disk99s1"), self.calls)

    def test_validation_failure_does_not_leak_tool_arguments(self):
        def failure(app, signed=False):
            raise subprocess.CalledProcessError(1, ["codesign", "private-account-metadata"], stderr="private stderr")
        with self.assertRaisesRegex(ValueError, "exit code 1") as caught:
            installer.package(self.args, runner=self.runner, validator=failure)
        self.assertNotIn("private", str(caught.exception))
        self.assertFalse(Path(self.args.output).exists())

    def test_output_inside_source_is_rejected_without_any_write_or_tool(self):
        before = installer.bundle_digest(self.app)
        for name in ("packaged", "Contents/output"):
            self.args.output = str(self.app / name)
            with self.assertRaisesRegex(ValueError, "outside the source"):
                self.package()
            self.assertFalse(Path(self.args.output).exists())
            self.assertEqual(installer.bundle_digest(self.app), before)
            self.assertEqual(self.calls, [])

    def test_absolute_internal_link_is_rejected(self):
        link = self.app / "Contents/internal-link"
        link.symlink_to(self.app / "Contents/MacOS/Arya")
        with self.assertRaisesRegex(ValueError, "absolute symbolic link"):
            self.package()
        self.assertFalse(Path(self.args.output).exists())
        self.assertEqual(self.calls, [])

    def test_copied_external_link_is_rejected_before_imaging(self):
        def add_link(*args):
            value = self.runner(*args)
            if args[0] == "ditto":
                (Path(args[2]) / "Contents/link").symlink_to(self.app / "Contents/MacOS/Arya")
            return value
        with self.assertRaisesRegex(ValueError, "absolute symbolic link"):
            self.package(add_link)
        self.assertFalse(any(call[0] == "hdiutil" for call in self.calls))

    def test_dependency_hash_checked_before_execution(self):
        source = self.root / "release-fixture.py"
        source.write_text("raise RuntimeError('untrusted code executed')\n")
        with self.assertRaisesRegex(ValueError, "validator changed"):
            installer.load_release_dependency(source, installer.RELEASE_SOURCE_SHA256)
        source.write_text("value = 7\n")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        self.assertEqual(installer.load_release_dependency(source, digest).value, 7)

    def test_real_validator_run_captures_and_redacts_stderr(self):
        self.info["CFBundleURLTypes"] = [{"CFBundleURLSchemes": ["reelfigma", "reelagent"]}]
        self.save_info()
        for name in ("reel-core.js", "web/index.html", "core/project.js",
                     "vendor/preact/dist/preact.module.js", "agent/bridge.mjs", "agent/mcp.mjs",
                     "agent/adapters.mjs", "agent/protocol.mjs", "agent/Reel Agent Bridge.command"):
            file = self.app / "Contents/Resources/editor" / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture")
        def failed_tool(args, **kwargs):
            self.assertTrue(kwargs["capture_output"])
            return SimpleNamespace(returncode=1, stdout="private stdout", stderr="private account stderr")
        with patch.object(installer.subprocess, "run", side_effect=failed_tool), redirect_stderr(io.StringIO()) as stderr:
            with self.assertRaisesRegex(ValueError, "codesign failed with exit code 1") as error:
                installer.verify_app(self.app, "rehearsal")
        self.assertEqual(stderr.getvalue(), "")
        self.assertNotIn("private", str(error.exception))

    def test_cli_filesystem_error_redacts_missing_path(self):
        with patch.object(installer.sys, "argv", ["package", "--app", str(self.root / "private-account-path/Arya.app"),
                                                 "--output", self.args.output]), redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(installer.main(), 1)
        self.assertNotIn("private-account", stderr.getvalue())
        self.assertNotIn(str(self.root), stderr.getvalue())
        self.assertIn("filesystem operation", stderr.getvalue())

    def test_official_requires_complete_pinned_runtime_receipt(self):
        self.official()
        original = self.runtime_receipt
        for candidate in (None, {**original, "version": "unapproved"},
                          {**original, "architectures": ["arm64"]},
                          {**original, "signedSHA256": {"arm64": "b" * 64}},
                          {**original, "signedSHA256": {"arm64": "bad", "x86_64": "c" * 64}},
                          {**original, "manifestSHA256": "bad"}):
            with self.subTest(candidate=candidate):
                self.runtime_receipt = candidate
                with self.assertRaisesRegex(ValueError, "runtime|helper|manifest"):
                    self.package()
                self.assertFalse(Path(self.args.output).exists())
        self.runtime_receipt = original

    def test_exact_runtime_dependency_is_retained_without_reload(self):
        self.assertIs(installer.release.load_runtime_dependency(), installer.node_runtime)
        runtime_path = Path(installer.node_runtime.__file__)
        self.assertEqual(hashlib.sha256(runtime_path.read_bytes()).hexdigest(), installer.NODE_RUNTIME_SOURCE_SHA256)
        self.assertEqual(installer.release.NODE_RUNTIME_SOURCE_SHA256, installer.NODE_RUNTIME_SOURCE_SHA256)

    def test_official_executable_architectures_must_match_runtime(self):
        self.official()
        self.architectures = "arm64"
        with self.assertRaisesRegex(ValueError, "same universal architectures"):
            self.package()
        self.assertFalse(Path(self.args.output).exists())

    def test_pinned_runtime_validator_failure_stops_real_release_validation(self):
        self.info["CFBundleURLTypes"] = [{"CFBundleURLSchemes": ["reelfigma", "reelagent"]}]
        self.save_info()
        for name in ("reel-core.js", "web/index.html", "core/project.js", "vendor/preact/dist/preact.module.js",
                     "agent/bridge.mjs", "agent/mcp.mjs", "agent/adapters.mjs", "agent/protocol.mjs", "agent/Reel Agent Bridge.command"):
            file = self.app / "Contents/Resources/editor" / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("fixture")
        entitlements = {key: True for key in ("com.apple.security.app-sandbox", "com.apple.security.files.user-selected.read-write",
                                            "com.apple.security.files.bookmarks.app-scope", "com.apple.security.network.client")}
        def captured_tool(args, **kwargs):
            self.assertTrue(kwargs["capture_output"])
            output = plistlib.dumps(entitlements).decode() if "--entitlements" in args else ""
            details = "CodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=Developer ID Application: Fixture\n"
            return SimpleNamespace(returncode=0, stdout=output, stderr=details)
        with patch.object(installer.subprocess, "run", side_effect=captured_tool), \
             patch.object(installer.node_runtime, "validate", side_effect=ValueError("runtime payload missing")) as validator:
            with self.assertRaisesRegex(ValueError, "runtime payload missing"):
                installer.verify_app(self.app, "official")
            validator.assert_called_once()

    def test_official_requires_signed_persistence_receipt(self):
        self.official()
        original = self.persistence_receipt
        for candidate in (None, {**original, "architectures": ["arm64"]}, {**original, "signatureMode": "unsigned"}, {**original, "teamIdentifier": "ZZZZZZZZZZ"}, {**original, "binarySHA256": "bad"}, {**original, "manifestSHA256": "bad"}):
            self.persistence_receipt = candidate
            with self.assertRaisesRegex(ValueError, "persistence helper"):
                self.package()
            self.assertFalse(Path(self.args.output).exists())
        self.persistence_receipt = original


if __name__ == "__main__":
    unittest.main()

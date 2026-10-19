"""Disposable notice-resource fixtures. No compiler, signer, app or network runs."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("arya_notices", Path(__file__).with_name("verify-arya-notices.py"))
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


class NoticeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="arya-notice-fixtures-")
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name).resolve()
        self.root = self.folder / "source"
        self.root.mkdir()
        self.lock = {"lockfileVersion": 3, "packages": {}}
        text = "# Fixture notices\n\n" + notices.MEDIABUNNY_SOURCE + "\n"
        self.licenses = []
        for name, label, version, license_name in notices.DEPENDENCIES:
            self.lock["packages"]["node_modules/" + name] = {"version": version, "license": license_name,
                "resolved": "https://registry.npmjs.org/" + name + "/-/" + name + "-" + version + ".tgz",
                "integrity": "sha512-" + base64.b64encode(b"x" * 64).decode()}
            self.write("editor/node_modules/" + name + "/package.json", json.dumps({"name": name, "version": version, "license": license_name}).encode())
            license_bytes = ("Fixture license for " + name + "\nFull fixture text.\n").encode()
            source = "editor/node_modules/" + name + "/LICENSE"
            self.write(source, license_bytes)
            self.licenses.append((source, "vendor/" + name + "/LICENSE"))
            text += "\n| " + label + " | " + version + " | " + license_name + " |\n" + license_bytes.decode()
        for name, source, bundle in notices.FONTS:
            license_bytes = ("Fixture license for " + name + "\nFull font fixture text.\n").encode()
            self.write(source, license_bytes)
            self.licenses.append((source, bundle))
            text += "\n" + license_bytes.decode()
        self.write("site/assets/fonts/manrope-OFL.txt", (self.root / "editor/web/fonts/manrope-OFL.txt").read_bytes())
        self.write("editor/package-lock.json", json.dumps(self.lock).encode())
        self.write(notices.NOTICE, text.encode())
        self.sha = hashlib.sha256(text.encode()).hexdigest()
        self.apps = {}
        for platform, prefix in [("macos", "Contents/Resources/editor"), ("ios", "editor")]:
            app = self.folder / (platform + ".app")
            editor = app / prefix
            editor.mkdir(parents=True)
            shutil.copyfile(self.root / notices.NOTICE, editor / notices.NOTICE)
            for source, bundle in self.licenses:
                if bundle:
                    destination = editor / bundle
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(self.root / source, destination)
            self.apps[platform] = app

    def write(self, relative, data):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def verify(self, platform="macos", sha=None):
        return notices.verify(self.root, self.apps[platform], platform, sha or self.sha)

    def test_both_layouts_verify_exact_bytes_and_keep_other_acceptance_false(self):
        for platform in self.apps:
            with self.subTest(platform=platform):
                report = self.verify(platform)
                self.assertTrue(report["noticeResourceChecksPassed"])
                self.assertEqual(report["noticeSHA256"], self.sha)
                self.assertEqual(len(report["components"]), 7)
                self.assertEqual(report["mediabunnySourceAccessURL"], notices.MEDIABUNNY_SOURCE)
                for key in ("signatureValidated", "runtimeValidated", "readyToPublish", "publicationApproved", "legalReviewAccepted"):
                    self.assertIs(report[key], False)
                for component in report["components"]:
                    actual = (self.root / component["sourcePath"]).read_bytes()
                    self.assertEqual(component["licenseSHA256"], hashlib.sha256(actual).hexdigest())
                    self.assertEqual(component["bytes"], len(actual))

    def test_notice_missing_or_changed_in_app_fails(self):
        notice = self.apps["ios"] / "editor" / notices.NOTICE
        notice.write_bytes(b"truncated")
        with self.assertRaisesRegex(notices.NoticeError, "bundled root notice"):
            self.verify("ios")
        notice.unlink()
        with self.assertRaises(notices.NoticeError):
            self.verify("ios")

    def test_reviewed_notice_fingerprint_is_required(self):
        for sha in ("bad", "0" * 64):
            with self.subTest(sha=sha), self.assertRaises(notices.NoticeError):
                self.verify(sha=sha)

    def test_missing_full_license_or_source_access_url_fails(self):
        original = (self.root / notices.NOTICE).read_bytes()
        for removed in ((self.root / "editor/node_modules/mediabunny/LICENSE").read_bytes(), notices.MEDIABUNNY_SOURCE.encode()):
            altered = original.replace(removed, b"")
            (self.root / notices.NOTICE).write_bytes(altered)
            (self.apps["ios"] / "editor" / notices.NOTICE).write_bytes(altered)
            with self.assertRaises(notices.NoticeError):
                self.verify("ios", hashlib.sha256(altered).hexdigest())

    def test_changed_or_missing_vendor_and_font_license_fails(self):
        for source, bundle in self.licenses:
            if bundle:
                file = self.apps["ios"] / "editor" / bundle
                original = file.read_bytes()
                file.write_bytes(b"changed license")
                with self.subTest(bundle=bundle), self.assertRaisesRegex(notices.NoticeError, "bundled license"):
                    self.verify("ios")
                file.unlink()
                with self.assertRaises(notices.NoticeError):
                    self.verify("ios")
                file.write_bytes(original)

    def test_installed_and_lock_version_license_or_provenance_mismatch_fails(self):
        package = self.root / "editor/node_modules/preact/package.json"
        original = json.loads(package.read_bytes())
        for key, value in [("name", "other"), ("version", "99.0.0"), ("license", "other")]:
            package.write_text(json.dumps({**original, key: value}))
            with self.subTest(key=key), self.assertRaises(notices.NoticeError):
                self.verify()
        package.write_text(json.dumps(original))
        for key, value in [("version", "99.0.0"), ("license", "other"), ("resolved", "https://example.com/package.tgz"), ("integrity", "sha512-bad")]:
            changed = json.loads(json.dumps(self.lock))
            changed["packages"]["node_modules/preact"][key] = value
            self.write("editor/package-lock.json", json.dumps(changed).encode())
            with self.subTest(key=key), self.assertRaises(notices.NoticeError):
                self.verify()

    def test_symlinked_leaf_and_parent_cannot_borrow_exact_external_bytes(self):
        app = self.apps["ios"]
        license = app / "editor/vendor/preact/LICENSE"
        source = self.root / "editor/node_modules/preact/LICENSE"
        license.unlink(); license.symlink_to(source)
        with self.assertRaises(notices.NoticeError):
            self.verify("ios")
        license.unlink(); shutil.copyfile(source, license)
        vendor = app / "editor/vendor/preact"
        shutil.rmtree(vendor); vendor.symlink_to(source.parent, target_is_directory=True)
        with self.assertRaises(notices.NoticeError):
            self.verify("ios")

    def test_root_aliases_and_relative_source_escape_are_rejected(self):
        alias = self.folder / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(notices.NoticeError):
            with notices.Reader(alias):
                self.fail("Alias root must not open")
        with notices.Reader(self.root) as source:
            for path in ("../source/THIRD_PARTY_NOTICES.md", "/etc/passwd", "editor/../THIRD_PARTY_NOTICES.md", "editor//package-lock.json", "editor\\package-lock.json"):
                with self.subTest(path=path), self.assertRaises(notices.NoticeError):
                    source.read(path)

    def test_special_empty_and_oversize_files_fail_without_reading(self):
        path = self.write("fixture", b"")
        with notices.Reader(self.root) as source:
            with self.assertRaises(notices.NoticeError): source.read("fixture", 4)
            path.write_bytes(b"xxxxx")
            with self.assertRaises(notices.NoticeError): source.read("fixture", 4)
            path.unlink(); os.mkfifo(path)
            with patch.object(notices.os, "read", side_effect=AssertionError("FIFO must not be read")):
                with self.assertRaises(notices.NoticeError): source.read("fixture", 4)

    def test_growth_is_bounded_and_path_replacement_is_detected(self):
        path = self.write("fixture", b"abc")
        real_read = os.read
        requests = []
        def growing(descriptor, count):
            requests.append(count)
            path.write_bytes(b"x" * 64)
            return real_read(descriptor, count)
        with notices.Reader(self.root) as source, patch.object(notices.os, "read", growing):
            with self.assertRaises(notices.NoticeError): source.read("fixture", 4)
        self.assertEqual(requests, [5])
        path.write_bytes(b"abc")
        def replacement(descriptor, count):
            path.rename(path.with_name("old-fixture"))
            path.write_bytes(b"abc")
            return real_read(descriptor, count)
        with notices.Reader(self.root) as source, patch.object(notices.os, "read", replacement):
            with self.assertRaises(notices.NoticeError): source.read("fixture", 4)

    def test_all_descriptor_opens_are_nonblocking_and_no_follow(self):
        real_open = os.open
        flags = []
        def observed(path, options, **kwargs):
            flags.append(options)
            return real_open(path, options, **kwargs)
        with patch.object(notices.os, "open", observed):
            self.verify()
        self.assertTrue(flags)
        for options in flags:
            self.assertTrue(options & os.O_NONBLOCK)
            self.assertTrue(options & os.O_NOFOLLOW)

    def test_cli_failure_reports_no_private_input_or_source_contents(self):
        argv = ["notices", "--root", str(self.folder / "private-account-path"), "--app", str(self.apps["ios"]), "--platform", "ios", "--expected-notice-sha256", self.sha]
        with patch.object(notices.sys, "argv", argv), redirect_stdout(io.StringIO()) as output:
            self.assertEqual(notices.main(), 1)
        report = json.loads(output.getvalue())
        self.assertNotIn("private-account", output.getvalue())
        self.assertNotIn(str(self.folder), output.getvalue())
        self.assertFalse(report["noticeResourceChecksPassed"])
        self.assertFalse(report["readyToPublish"])


if __name__ == "__main__":
    unittest.main()

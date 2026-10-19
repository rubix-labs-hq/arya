#!/usr/bin/env python3
"""Disposable filesystem and interleaving tests for the scanner read helper."""
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HELPER = Path(__file__).with_name("public-readiness-read.py")
# The helper runs with a minimal environment, as public-readiness.mjs runs it; inherited settings
# such as SWIFT_BACKTRACE make the /usr/bin/python3 stub write warnings to stderr.
CHILD_ENV = {"PATH": "/usr/bin:/bin"}
spec = importlib.util.spec_from_file_location("read_helper", HELPER)
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


class ReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="arya-reader-")
        self.base = Path(self.temporary.name).resolve()
        self.root = self.base / "inside"
        self.outside = self.base / "outside"
        self.root.mkdir()
        self.outside.mkdir()
        self.folder = self.root / "folder"
        self.folder.mkdir()
        self.file = self.folder / "sample.txt"
        self.file.write_bytes(b"safe")
        (self.outside / "sample.txt").write_bytes(b"outside-private-marker")

    def tearDown(self):
        self.temporary.cleanup()

    def read(self, maximum=reader.MAXIMUM):
        return reader.bounded_read(str(self.root), "folder/sample.txt", maximum)

    def replace_open(self, function):
        # The patched callable still delegates to the supported descriptor API.
        return patch.multiple(os, open=function, supports_dir_fd=os.supports_dir_fd | {function})

    def test_regular_and_empty_files(self):
        self.assertEqual(self.read(), b"safe")
        self.file.write_bytes(b"")
        self.assertEqual(self.read(), b"")

    def test_size_cap_without_reading_oversized_file(self):
        self.file.write_bytes(b"a" * 33)
        with patch.object(os, "read", side_effect=AssertionError("Oversized file was read.")):
            self.assertIsNone(self.read(32))
        self.file.write_bytes(b"a" * 32)
        self.assertEqual(self.read(32), b"a" * 32)

    def test_leaf_symlink(self):
        self.file.unlink()
        self.file.symlink_to(self.outside / "sample.txt")
        with self.assertRaises(OSError):
            self.read()

    def test_ancestor_symlink(self):
        self.folder.rename(self.root / "saved")
        self.folder.symlink_to(self.outside, target_is_directory=True)
        with self.assertRaises(OSError):
            self.read()

    def test_root_and_root_ancestor_symlinks(self):
        alias = self.base / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            reader.bounded_read(str(alias), "folder/sample.txt")
        with self.assertRaises(OSError):
            reader.bounded_read(str(alias / "folder"), "sample.txt")

    def test_directory_and_fifo_leaves(self):
        self.file.unlink()
        self.file.mkdir()
        with self.assertRaises(OSError):
            self.read()
        self.file.rmdir()
        os.mkfifo(self.file)
        request = {"root": str(self.root), "path": "folder/sample.txt", "maximum": 32}
        result = subprocess.run([sys.executable, "-I", "-S", str(HELPER)],
                                input=json.dumps(request).encode(), capture_output=True, timeout=3, env=CHILD_ENV)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, b"")
        self.assertEqual(result.stderr, b"Working-file read rejected.\n")

    def test_fifo_replacement_between_stat_and_open_is_nonblocking(self):
        original = os.open
        def interleave(name, flags, **kwargs):
            if name == "sample.txt":
                self.file.unlink()
                os.mkfifo(self.file)
                self.assertTrue(flags & os.O_NONBLOCK)
                self.assertTrue(flags & os.O_NOFOLLOW)
            return original(name, flags, **kwargs)
        with self.replace_open(interleave), patch.object(os, "read", side_effect=AssertionError("FIFO was read.")):
            with self.assertRaises(OSError):
                self.read()

    def test_symlink_replacement_between_stat_and_open(self):
        original = os.open
        def interleave(name, flags, **kwargs):
            if name == "sample.txt":
                self.file.unlink()
                self.file.symlink_to(self.outside / "sample.txt")
            return original(name, flags, **kwargs)
        with self.replace_open(interleave), patch.object(os, "read", side_effect=AssertionError("Link was read.")):
            with self.assertRaises(OSError):
                self.read()

    def test_regular_leaf_replacement_between_stat_and_open(self):
        original = os.open
        def interleave(name, flags, **kwargs):
            if name == "sample.txt":
                self.file.rename(self.folder / "saved.txt")
                self.file.write_bytes(b"replacement")
            return original(name, flags, **kwargs)
        with self.replace_open(interleave), patch.object(os, "read", side_effect=AssertionError("Replacement was read.")):
            with self.assertRaises(OSError):
                self.read()

    def test_ancestor_replacement_before_directory_open(self):
        original = os.open
        def interleave(name, flags, **kwargs):
            if name == "folder":
                self.folder.rename(self.root / "saved")
                self.folder.symlink_to(self.outside, target_is_directory=True)
            return original(name, flags, **kwargs)
        with self.replace_open(interleave), patch.object(os, "read", side_effect=AssertionError("Outside content was read.")):
            with self.assertRaises(OSError):
                self.read()

    def test_ancestor_replacement_after_directory_open(self):
        original = os.open
        def interleave(name, flags, **kwargs):
            descriptor = original(name, flags, **kwargs)
            if name == "folder":
                self.folder.rename(self.root / "saved")
                self.folder.symlink_to(self.outside, target_is_directory=True)
            return descriptor
        with self.replace_open(interleave), patch.object(os, "read", side_effect=AssertionError("Content was read.")):
            with self.assertRaises(OSError):
                self.read()

    def test_root_replacement_after_directory_open(self):
        original = os.open
        def interleave(name, flags, **kwargs):
            descriptor = original(name, flags, **kwargs)
            if name == "inside":
                self.root.rename(self.base / "saved-root")
                self.root.symlink_to(self.outside, target_is_directory=True)
            return descriptor
        with self.replace_open(interleave), patch.object(os, "read", side_effect=AssertionError("Content was read.")):
            with self.assertRaises(OSError):
                self.read()

    def test_all_opens_use_pinned_parents_and_no_follow_flags(self):
        original = os.open
        calls = []
        def record(name, flags, **kwargs):
            calls.append((name, flags, kwargs))
            return original(name, flags, **kwargs)
        with self.replace_open(record):
            self.assertEqual(self.read(), b"safe")
        self.assertEqual(calls[0][0], "/")
        for name, flags, kwargs in calls:
            self.assertTrue(flags & os.O_NONBLOCK)
            self.assertTrue(flags & os.O_NOFOLLOW)
            if name != "/":
                self.assertNotIn("/", name)
                self.assertIsInstance(kwargs["dir_fd"], int)
            if name != "sample.txt":
                self.assertTrue(flags & os.O_DIRECTORY)

    def change_during_read(self, change):
        original = os.read
        changed = False
        def interleave(descriptor, length):
            nonlocal changed
            result = original(descriptor, length)
            if not changed:
                changed = True
                change()
            return result
        with patch.object(os, "read", interleave):
            with self.assertRaises(OSError):
                self.read(32)

    def test_same_size_write_during_read(self):
        self.change_during_read(lambda: self.file.write_bytes(b"evil"))

    def test_growth_during_read(self):
        self.change_during_read(lambda: self.file.write_bytes(b"a" * 64))

    def test_permission_change_during_read(self):
        self.change_during_read(lambda: self.file.chmod(stat.S_IRUSR))

    def test_leaf_replacement_during_read(self):
        def change():
            self.file.rename(self.folder / "saved.txt")
            self.file.symlink_to(self.outside / "sample.txt")
        self.change_during_read(change)

    def test_ownership_is_in_identity_and_stamp(self):
        before = self.file.stat()
        fields = list(before)
        fields[4] += 1
        changed = os.stat_result(fields)
        self.assertNotEqual(reader.identity(before), reader.identity(changed))

    def test_bad_paths_and_limits_fail_before_opening(self):
        with patch.object(os, "open", side_effect=AssertionError("Invalid path reached open.")):
            for path in ("../outside/sample.txt", "/sample.txt", "folder//sample.txt", "folder/./sample.txt", "", "x\0y"):
                with self.assertRaises(ValueError):
                    reader.bounded_read(str(self.root), path)
            for maximum in (0, -1, True, reader.MAXIMUM + 1):
                with self.assertRaises(ValueError):
                    self.read(maximum)

    def test_cli_success_and_sanitized_bad_requests(self):
        request = {"root": str(self.root), "path": "folder/sample.txt", "maximum": 32}
        result = subprocess.run([sys.executable, "-I", "-S", str(HELPER)],
                                input=json.dumps(request).encode(), capture_output=True, timeout=3, env=CHILD_ENV)
        self.assertEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"ARYA_OK\nsafe")
        self.assertEqual(result.stderr, b"")
        for payload in (b"outside-private-marker", json.dumps({**request, "extra": "outside-private-marker"}).encode(),
                        b"a" * (reader.REQUEST_LIMIT + 1)):
            result = subprocess.run([sys.executable, "-I", "-S", str(HELPER)],
                                    input=payload, capture_output=True, timeout=3, env=CHILD_ENV)
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, b"Working-file read rejected.\n")


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Read-only Mac/iOS notice checks. Never builds, signs, launches or publishes."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys

DEPENDENCIES = (
    ("preact", "Preact", "10.29.8", "MIT"),
    ("htm", "htm", "3.1.1", "Apache-2.0"),
    ("mediabunny", "Mediabunny", "1.61.0", "MPL-2.0"),
)
FONTS = (
    ("Inter", "editor/web/fonts/LICENSE-Inter.txt", "web/fonts/LICENSE-Inter.txt"),
    ("Mrs Saint Delafield", "editor/web/fonts/MrsSaintDelafield-OFL.txt", "web/fonts/MrsSaintDelafield-OFL.txt"),
    ("Manrope", "editor/web/fonts/manrope-OFL.txt", "web/fonts/manrope-OFL.txt"),
    ("Newsreader", "site/assets/fonts/newsreader-OFL.txt", None),
)
NOTICE = "THIRD_PARTY_NOTICES.md"
MEDIABUNNY_SOURCE = "https://registry.npmjs.org/mediabunny/-/mediabunny-1.61.0.tgz"
LIMIT = 2 * 1024 * 1024
OPEN = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


class NoticeError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise NoticeError(message)


def identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_ctime_ns)


class Reader:
    """Open each path component beneath an anchored directory without following links."""

    def __init__(self, root):
        self.root = Path(os.path.abspath(root))
        require(self.root.resolve(strict=True) == self.root, "Inspection roots must be canonical directories.")
        descriptor = os.open(self.root.anchor, OPEN | os.O_DIRECTORY)
        try:
            for part in self.root.parts[1:]:
                child = os.open(part, OPEN | os.O_DIRECTORY, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            self.initial = os.fstat(descriptor)
            require(stat.S_ISDIR(self.initial.st_mode), "Inspection root must be a directory.")
            self.descriptor = descriptor
        except BaseException:
            os.close(descriptor)
            raise

    def __enter__(self):
        return self

    def __exit__(self, kind, error, traceback):
        try:
            current = self.root.lstat()
            require(not stat.S_ISLNK(current.st_mode) and (current.st_dev, current.st_ino) == (self.initial.st_dev, self.initial.st_ino), "Inspection root changed during verification.")
        finally:
            os.close(self.descriptor)

    def read(self, relative, limit=LIMIT):
        require(type(limit) is int and limit > 0, "Invalid read limit.")
        require(isinstance(relative, str) and relative and "\\" not in relative, "Invalid input path.")
        parts = relative.split("/")
        require(not PurePosixPath(relative).is_absolute() and all(part not in ("", ".", "..") for part in parts), "Input paths must stay inside their inspection root.")
        directory = os.dup(self.descriptor)
        descriptor = None
        try:
            for part in parts[:-1]:
                child = os.open(part, OPEN | os.O_DIRECTORY, dir_fd=directory)
                os.close(directory)
                directory = child
            descriptor = os.open(parts[-1], OPEN, dir_fd=directory)
            before = os.fstat(descriptor)
            require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= limit, "Notice inputs must be bounded, nonempty regular files.")
            chunks, count = [], 0
            while count <= limit:
                chunk = os.read(descriptor, min(64 * 1024, limit + 1 - count))
                if not chunk:
                    break
                chunks.append(chunk)
                count += len(chunk)
            after = os.fstat(descriptor)
            current = os.stat(parts[-1], dir_fd=directory, follow_symlinks=False)
            require(count == before.st_size and count <= limit and identity(before) == identity(after) == identity(current), "Notice input changed during verification.")
            return b"".join(chunks)
        except OSError:
            raise NoticeError("A notice input is unavailable or has an unsafe filesystem path.") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)
            os.close(directory)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_object(data):
    value = json.loads(data)
    require(isinstance(value, dict), "Expected a JSON object.")
    return value


def verify(root, app, platform, expected_notice_sha256):
    require(platform in ("macos", "ios"), "Choose a Mac or iOS bundle layout.")
    require(isinstance(expected_notice_sha256, str) and re.fullmatch(r"[a-f0-9]{64}", expected_notice_sha256), "Pass the reviewed root notice SHA256.")
    require(Path(app).suffix == ".app", "Pass an app bundle directory.")
    editor = "Contents/Resources/editor" if platform == "macos" else "editor"
    with Reader(root) as source, Reader(app) as bundle:
        notice_bytes = source.read(NOTICE)
        require(digest(notice_bytes) == expected_notice_sha256, "The root notice differs from the reviewed fingerprint.")
        notice_text = notice_bytes.decode("utf-8", errors="strict")
        require(MEDIABUNNY_SOURCE in notice_text, "The exact Mediabunny source-access URL is missing.")
        require(bundle.read(editor + "/" + NOTICE) == notice_bytes, "The bundled root notice differs from the reviewed bytes.")
        lock_bytes = source.read("editor/package-lock.json")
        lock = json_object(lock_bytes)
        require(lock.get("lockfileVersion") == 3 and isinstance(lock.get("packages"), dict), "Unsupported package lock structure.")
        components = []

        def license_check(name, source_path, bundle_path, extra=None):
            license_bytes = source.read(source_path)
            text = license_bytes.decode("utf-8", errors="strict").strip()
            require(text and text in notice_text, "A complete inventoried license text is missing from the root notice.")
            if bundle_path:
                require(bundle.read(editor + "/" + bundle_path) == license_bytes, "A bundled license differs from its installed source bytes.")
            components.append({"name": name, "sourcePath": source_path, "bundlePath": editor + "/" + bundle_path if bundle_path else None,
                               "licenseSHA256": digest(license_bytes), "bytes": len(license_bytes), **(extra or {})})

        for name, label, version, license_name in DEPENDENCIES:
            locked = lock["packages"].get("node_modules/" + name)
            installed_bytes = source.read("editor/node_modules/" + name + "/package.json")
            installed = json_object(installed_bytes)
            require(isinstance(locked, dict) and locked.get("version") == version and locked.get("license") == license_name
                    and installed.get("name") == name and installed.get("version") == version and installed.get("license") == license_name,
                    "A dependency differs from the reviewed version/license inventory.")
            resolved = "https://registry.npmjs.org/" + name + "/-/" + name + "-" + version + ".tgz"
            integrity = locked.get("integrity")
            require(locked.get("resolved") == resolved and isinstance(integrity, str) and integrity.startswith("sha512-"), "Dependency lock provenance is missing or differs.")
            try:
                require(len(base64.b64decode(integrity[7:], validate=True)) == 64, "Invalid package integrity field.")
            except ValueError:
                raise NoticeError("Invalid package integrity field.") from None
            require("| " + label + " | " + version + " | " + license_name + " |" in notice_text, "A dependency notice version/license row differs.")
            license_check(name, "editor/node_modules/" + name + "/LICENSE", "vendor/" + name + "/LICENSE",
                          {"version": version, "license": license_name, "packageJSONSHA256": digest(installed_bytes), "lockedArchiveURL": resolved, "lockedIntegrity": integrity})
        for name, source_path, bundle_path in FONTS:
            license_check(name, source_path, bundle_path)
        require(source.read("site/assets/fonts/manrope-OFL.txt") == source.read("editor/web/fonts/manrope-OFL.txt"), "Website and native Manrope license inventory differs.")
        return {"schema": 1, "scope": "app_notice_resources", "platform": platform, "noticeResourceChecksPassed": True,
                "noticeSHA256": digest(notice_bytes), "lockfileSHA256": digest(lock_bytes), "components": components,
                "mediabunnySourceAccessURL": MEDIABUNNY_SOURCE, "signatureValidated": False, "runtimeValidated": False,
                "readyToPublish": False, "publicationApproved": False, "legalReviewAccepted": False,
                "limitations": ["This compares notice resources and reviewed local dependency inventory; it does not verify upstream archive bytes.",
                                "Node helper payload license files require their separate runtime validator.",
                                "App execution, signatures, store acceptance, copyright ownership and source-license selection remain separate gates."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--platform", choices=("macos", "ios"), required=True)
    parser.add_argument("--expected-notice-sha256", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.root, args.app, args.platform, args.expected_notice_sha256), indent=2))
        return 0
    except (OSError, ValueError, TypeError, KeyError, RuntimeError):
        print(json.dumps({"noticeResourceChecksPassed": False, "signatureValidated": False, "runtimeValidated": False,
                          "readyToPublish": False, "publicationApproved": False, "error": "Notice verification failed. No private path or file contents were printed."}))
        return 1


if __name__ == "__main__":
    sys.exit(main())

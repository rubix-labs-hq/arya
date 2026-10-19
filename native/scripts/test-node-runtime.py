import copy
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import struct
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("arya_runtime_tests", HERE / "node_runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)
TEAM = "ABCDEFGHIJ"


def thin(architecture, minimum=0x000E0000):
    cpu = runtime.ARCHIVES[architecture][2]
    return struct.pack("<8I", 0xFEEDFACF, cpu, 0, 2, 1, 24, 0, 0) + struct.pack("<6I", 0x32, 24, 1, minimum, minimum, 0) + b"fixture"


def universal():
    a, b = thin("arm64"), thin("x86_64")
    return struct.pack(">II", 0xCAFEBABE, 2) + struct.pack(">5I", runtime.ARCHIVES["arm64"][2], 0, 48, len(a), 0) + struct.pack(">5I", runtime.ARCHIVES["x86_64"][2], 0, 48 + len(a), len(b), 0) + a + b


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="arya-runtime-pure-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.app = self.root / "Arya.app"
        self.app.mkdir()
        runtime.write_new(self.app, "Contents/MacOS/Arya", universal(), 0o755)
        self.info = {"CFBundleExecutable": "Arya", "LSMinimumSystemVersion": "14.0"}
        self.manifest = {"schemaVersion": 1, "name": "Node.js", "version": runtime.VERSION,
                         "checksumSource": runtime.CHECKSUM_SOURCE, "state": "signed", "teamIdentifier": TEAM,
                         "helperEntitlements": {}, "files": []}
        for architecture, (platform, archive_sha, _) in runtime.ARCHIVES.items():
            binary, license_data = thin(architecture), b"Node license fixture"
            path = f"Contents/Helpers/node-{architecture}"
            license_path = f"Contents/Resources/assistant/Node-LICENSE-{architecture}.txt"
            runtime.write_new(self.app, path, binary, 0o755)
            runtime.write_new(self.app, license_path, license_data)
            self.manifest["files"].append({"architecture": architecture, "path": path,
                "licensePath": license_path, "archiveSHA256": archive_sha,
                "archiveURL": f"https://nodejs.org/download/release/v{runtime.VERSION}/node-v{runtime.VERSION}-{platform}.tar.gz",
                "unsignedSHA256": runtime.sha(binary), "signedSHA256": runtime.sha(binary),
                "licenseSHA256": runtime.sha(license_data), "minimumMacOS": "14.0.0",
                "startupProbe": {"version": runtime.VERSION, "architecture": "x64" if architecture == "x86_64" else "arm64", "jit": True}})
        self.save()
        self.calls = []

    def save(self):
        path = self.app / runtime.MANIFEST
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.manifest))

    def runner(self, *args, stderr=False, env=None):
        self.calls.append(args)
        if "--verify" in args:
            requirement = next(arg for arg in args if str(arg).startswith("-R"))
            self.assertTrue(requirement.startswith("-R=anchor apple generic"), "codesign needs literal requirement text after '='")
            self.assertIn(f'"{TEAM}"', requirement)
            return ""
        if "-dvv" in args:
            return "CodeDirectory v=20500 size=100 flags=0x10000(runtime)\nAuthority=Developer ID Application: Fixture\nTeamIdentifier=" + TEAM + "\n"
        if "--entitlements" in args:
            return plistlib.dumps({}).decode()
        raise AssertionError("Unanticipated command " + str(args))

    def check(self):
        return runtime.validate(self.app, self.info, self.runner)

    def testUniversalAppAndExactHelpersPassWithInjectedSignatureEvidence(self):
        result = self.check()
        self.assertEqual(result["architectures"], ["arm64", "x86_64"])
        self.assertEqual(result["version"], runtime.VERSION)
        self.assertEqual(len([c for c in self.calls if "--verify" in c]), 3)

    def testMissingHelperFails(self):
        (self.app / self.manifest["files"][0]["path"]).unlink()
        with self.assertRaises(FileNotFoundError): self.check()

    def testMissingLicenseFails(self):
        (self.app / self.manifest["files"][0]["licensePath"]).unlink()
        with self.assertRaises(FileNotFoundError): self.check()

    def testMissingManifestFails(self):
        (self.app / runtime.MANIFEST).unlink()
        with self.assertRaises(FileNotFoundError): self.check()

    def testDanglingHelperLinkFailsBeforeSignatureOrExecution(self):
        path = self.app / self.manifest["files"][0]["path"]
        path.unlink(); path.symlink_to(path.with_name("absent"))
        with self.assertRaises(FileNotFoundError): self.check()
        self.assertFalse(any(str(path) in map(str, call) for call in self.calls))

    def testWrongCPUFailsEvenWithUpdatedHash(self):
        entry = self.manifest["files"][0]
        binary = thin("x86_64")
        (self.app / entry["path"]).write_bytes(binary)
        entry["signedSHA256"] = runtime.sha(binary); self.save()
        with self.assertRaisesRegex(ValueError, "CPU"): self.check()

    def testOneSliceAppFails(self):
        (self.app / "Contents/MacOS/Arya").write_bytes(thin("arm64"))
        with self.assertRaisesRegex(ValueError, "both arm64"): self.check()
        self.assertEqual(self.calls, [])

    def testWrongSignerFails(self):
        def wrong(*args, stderr=False, env=None):
            if "-dvv" in args:
                return self.runner(*args, stderr=stderr).replace(TEAM, "WRONGTEAM1")
            return self.runner(*args, stderr=stderr, env=env)
        with self.assertRaisesRegex(ValueError, "matching Developer ID"):
            runtime.validate(self.app, self.info, wrong)

    def testAdHocSignerFails(self):
        def wrong(*args, stderr=False, env=None):
            if "-dvv" in args:
                return self.runner(*args, stderr=stderr).replace("Authority=Developer ID Application: Fixture", "Signature=adhoc")
            return self.runner(*args, stderr=stderr, env=env)
        with self.assertRaisesRegex(ValueError, "matching Developer ID"):
            runtime.validate(self.app, self.info, wrong)

    def testWrongPinnedArchiveSHAOrPathFails(self):
        for key, value in [("archiveSHA256", "a" * 64), ("path", "Contents/Helpers/other"), ("licensePath", "../../license")]:
            with self.subTest(key=key):
                original = copy.deepcopy(self.manifest)
                self.manifest["files"][0][key] = value; self.save()
                with self.assertRaisesRegex(ValueError, "pinned path or source"): self.check()
                self.manifest = original; self.save()

    def testSignedHashLicenseHashAndProbeFailures(self):
        for key, value in [("signedSHA256", "0" * 64), ("licenseSHA256", "0" * 64), ("startupProbe", {"jit": False})]:
            with self.subTest(key=key):
                original = copy.deepcopy(self.manifest)
                self.manifest["files"][0][key] = value; self.save()
                with self.assertRaises(ValueError): self.check()
                self.manifest = original; self.save()

    def testHelperMinimumMacOSCannotExceedDeclaredAppMinimum(self):
        entry = self.manifest["files"][0]; binary = thin("arm64", 0x00100000)
        (self.app / entry["path"]).write_bytes(binary)
        entry["signedSHA256"] = runtime.sha(binary); entry["minimumMacOS"] = "16.0.0"; self.save()
        with self.assertRaisesRegex(ValueError, "newer macOS"): self.check()

    def testOtherPlatformAndTruncatedLoadCommandRejected(self):
        data = bytearray(thin("arm64")); struct.pack_into("<I", data, 40, 2)
        with self.assertRaisesRegex(ValueError, "target macOS"): runtime.macho_slices(data)
        with self.assertRaises(ValueError): runtime.macho_slices(thin("arm64")[:40])

    def testOverlappingUniversalSlicesRejected(self):
        data = bytearray(universal()); struct.pack_into(">I", data, 36, 48)
        with self.assertRaisesRegex(ValueError, "Overlapping"): runtime.macho_slices(data)

    def testUnexpectedHelperEntitlementRejected(self):
        with self.assertRaisesRegex(ValueError, "V8 memory"):
            runtime.helper_entitlements(plistlib.dumps({"com.apple.security.cs.disable-library-validation": True}))
        with self.assertRaises(ValueError): runtime.helper_entitlements(plistlib.dumps({"com.apple.security.cs.allow-jit": False}))

    def testCopyRechecksCapturedManifestAndPayloadBeforeCreatingHelpers(self):
        payload = self.root / "payload"; payload.mkdir()
        unsigned = copy.deepcopy(self.manifest); unsigned["state"] = "unsigned"
        for entry in unsigned["files"]:
            binary = thin(entry["architecture"])
            runtime.write_new(payload, entry["path"], binary, 0o755)
            runtime.write_new(payload, entry["licensePath"], b"Node license fixture")
        runtime.write_new(payload, runtime.MANIFEST, json.dumps(unsigned).encode())
        output = self.root / "Copy.app"; output.mkdir()
        (payload / unsigned["files"][0]["path"]).write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "changed before copy"):
            runtime.install(payload, output, unsigned, "14.0")
        self.assertEqual(list(output.iterdir()), [])

    def testSignAndProbeRunsBothArchitecturesBeforeSealingManifest(self):
        manifest = copy.deepcopy(self.manifest); manifest["state"] = "unsigned"
        self.manifest = manifest; self.save()
        entitlements = self.root / "entitlements.plist"; entitlements.write_bytes(plistlib.dumps({}))
        events = []
        def fake(*args, stderr=False, env=None):
            if "--sign" in args:
                events.append(("sign", Path(args[-1]).name))
                with Path(args[-1]).open("ab") as target: target.write(b"fixture-signature")
                return ""
            if args[0] == "/usr/bin/arch":
                arch = args[1][1:]; events.append(("probe", arch))
                self.assertEqual(set(env), {"PATH", "HOME", "LANG"})
                return json.dumps({"version": runtime.VERSION, "architecture": "x64" if arch == "x86_64" else "arm64", "jit": True})
            return self.runner(*args, stderr=stderr, env=env)
        result = runtime.sign_and_probe(self.app, "fixture identity", TEAM, entitlements, manifest, fake)
        self.assertEqual(events, [("sign", "node-arm64"), ("probe", "arm64"), ("sign", "node-x86_64"), ("probe", "x86_64")])
        self.assertEqual(result["state"], "signed")
        self.assertTrue(all(entry["unsignedSHA256"] != entry["signedSHA256"] for entry in result["files"]))
        self.assertEqual(json.loads((self.app / runtime.MANIFEST).read_text()), result)

    def testFailedStartupDoesNotSealSuccessfulReceipt(self):
        manifest = copy.deepcopy(self.manifest); manifest["state"] = "unsigned"
        self.manifest = manifest; self.save()
        entitlements = self.root / "entitlements.plist"; entitlements.write_bytes(plistlib.dumps({}))
        def fake(*args, stderr=False, env=None):
            if "--sign" in args: return ""
            if args[0] == "/usr/bin/arch": return json.dumps({"jit": False})
            return self.runner(*args, stderr=stderr, env=env)
        with self.assertRaisesRegex(ValueError, "startup probe failed"):
            runtime.sign_and_probe(self.app, "fixture identity", TEAM, entitlements, manifest, fake)
        self.assertEqual(json.loads((self.app / runtime.MANIFEST).read_text())["state"], "unsigned")

    def reject_fifo(self, reader, target, replacement=False):
        target.write_bytes(b"regular fixture") if replacement else os.mkfifo(target)
        original_open = os.open
        opened = []
        def checked_open(path, flags, *args, **kwargs):
            self.assertTrue(flags & os.O_NONBLOCK, "The reader must not wait for a FIFO writer")
            self.assertTrue(flags & os.O_NOFOLLOW)
            if replacement:
                target.unlink()
                os.mkfifo(target)
            descriptor = original_open(path, flags, *args, **kwargs)
            opened.append(descriptor)
            return descriptor
        # The actual descriptor is a writerless FIFO. No file read or external tool is permitted.
        with mock.patch.object(os, "open", side_effect=checked_open), mock.patch.object(os, "fdopen", side_effect=AssertionError("A FIFO must not be read")), mock.patch.object(runtime.subprocess, "run", side_effect=AssertionError("A FIFO must not run a tool")):
            with self.assertRaisesRegex(ValueError, "regular file"):
                reader()
        self.assertEqual(len(opened), 1)
        with self.assertRaises(OSError): os.fstat(opened[0])

    def testStableFIFORejectedWithoutWriterOrRead(self):
        target = self.root / "writerless-fifo"
        self.reject_fifo(lambda: runtime.read_regular(target, 1024), target)

    def testRegularFileReplacedWithFIFOImmediatelyBeforeOpenRejected(self):
        target = self.root / "replacement-fifo"
        self.reject_fifo(lambda: runtime.read_regular(target, 1024), target, replacement=True)

    def release_fixture(self):
        spec = importlib.util.spec_from_file_location("arya_release_fifo_tests", HERE / "release.py")
        release = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(release)
        directory = self.root / "release-fixture"; directory.mkdir()
        release.__file__ = str(directory / "release.py")
        return release, directory / "node_runtime.py"

    def testReleaseLoaderStableFIFORejectedWithoutWriterOrRead(self):
        release, target = self.release_fixture()
        self.reject_fifo(release.load_runtime_dependency, target)

    def testReleaseLoaderReplacementBeforeOpenRejected(self):
        release, target = self.release_fixture()
        self.reject_fifo(release.load_runtime_dependency, target, replacement=True)

    def testArchivePinRejectedWithoutParsingOrWritingPayload(self):
        source = self.root / "archives"; source.mkdir()
        first = next(iter(runtime.ARCHIVES.values()))[0]
        (source / f"node-v{runtime.VERSION}-{first}.tar.gz").write_bytes(b"not an archive")
        output = self.root / "NeverCreated"
        with self.assertRaisesRegex(ValueError, "SHA256"):
            runtime.prepare(source, output, "14.0")
        self.assertFalse(output.exists())


if __name__ == "__main__": unittest.main()

"""Prepare, copy, sign, probe and validate Arya's pinned macOS bridge runtimes."""
import hashlib
import io
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import struct
import subprocess
import tarfile

VERSION = "24.21.0"
CHECKSUM_SOURCE = "https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt"
ARCHIVES = {
    "arm64": ("darwin-arm64", "bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057", 0x0100000C),
    "x86_64": ("darwin-x64", "1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097", 0x01000007),
}
MANIFEST = "Contents/Resources/assistant/node-runtime.json"
ENTITLEMENT_KEYS = {"com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory"}
MAX_ARCHIVE = 100 * 1024 * 1024
MAX_BINARY = 512 * 1024 * 1024
MAX_LICENSE = 2 * 1024 * 1024
PROBE = r'''function f(x){return x*3+1} %PrepareFunctionForOptimization(f); for(let i=0;i<10000;i++)f(i); %OptimizeFunctionOnNextCall(f); if(f(7)!==22||!(%GetOptimizationStatus(f)&16))throw Error("V8 optimization failed"); process.stdout.write(JSON.stringify({version:process.versions.node,architecture:process.arch,jit:true}));'''


def read_regular(path, limit):
    path = Path(os.path.abspath(path))
    if path.resolve(strict=True) != path or path.is_symlink():
        raise ValueError("Runtime files cannot pass through symbolic links.")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= limit:
            raise ValueError("The runtime file is not a bounded regular file.")
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = source.read(limit + 1)
        after = os.fstat(fd)
        current = path.stat()
        identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns, item.st_ctime_ns)
        if len(data) != before.st_size or len(data) > limit or identity(before) != identity(after) or identity(before) != identity(current):
            raise ValueError("The runtime file changed while reading.")
        return data
    finally:
        os.close(fd)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def version_tuple(text):
    if not isinstance(text, str) or not re.fullmatch(r"\d+\.\d+(?:\.\d+)?", text):
        raise ValueError("Invalid minimum macOS version.")
    parts = tuple(map(int, text.split(".")))
    return parts + (0,) * (3 - len(parts))


def packed_version(value):
    return f"{value >> 16}.{value >> 8 & 255}.{value & 255}"


def macho_slices(data):
    def thin(offset, length):
        if length < 32 or offset < 0 or offset + length > len(data):
            raise ValueError("Invalid Mach-O slice bounds.")
        magic = data[offset:offset + 4]
        endian = "<" if magic == b"\xcf\xfa\xed\xfe" else ">" if magic == b"\xfe\xed\xfa\xcf" else None
        if endian is None:
            raise ValueError("A 64-bit Mach-O executable is required.")
        _, cpu, _, filetype, count, size, _, _ = struct.unpack_from(endian + "8I", data, offset)
        if filetype != 2 or count > 4096 or size > 4 * 1024 * 1024 or 32 + size > length:
            raise ValueError("Invalid Mach-O load commands.")
        architecture = next((key for key, value in ARCHIVES.items() if value[2] == cpu), None)
        if architecture is None:
            raise ValueError("Unsupported Mach-O architecture.")
        cursor, end, minimums = offset + 32, offset + 32 + size, []
        for _ in range(count):
            if cursor + 8 > end:
                raise ValueError("Truncated Mach-O load command.")
            cmd, command_size = struct.unpack_from(endian + "II", data, cursor)
            if command_size < 8 or command_size % 4 or cursor + command_size > end:
                raise ValueError("Invalid Mach-O command size.")
            if cmd == 0x32:
                if command_size < 24:
                    raise ValueError("Truncated LC_BUILD_VERSION.")
                platform, minimum = struct.unpack_from(endian + "II", data, cursor + 8)
                if platform != 1:
                    raise ValueError("The runtime must target macOS.")
                minimums.append(packed_version(minimum))
            if cmd == 0x24:
                if command_size < 16:
                    raise ValueError("Truncated LC_VERSION_MIN_MACOSX.")
                minimums.append(packed_version(struct.unpack_from(endian + "I", data, cursor + 8)[0]))
            cursor += command_size
        if cursor != end or not minimums or len(set(minimums)) != 1:
            raise ValueError("Missing or inconsistent minimum macOS version.")
        return architecture, minimums[0]
    if data[:4] not in (b"\xca\xfe\xba\xbe", b"\xca\xfe\xba\xbf"):
        architecture, minimum = thin(0, len(data))
        return {architecture: minimum}
    fat64 = data[:4] == b"\xca\xfe\xba\xbf"
    if len(data) < 8:
        raise ValueError("Truncated universal Mach-O header.")
    count = struct.unpack_from(">I", data, 4)[0]
    entry_size = 32 if fat64 else 20
    if count not in (1, 2) or 8 + count * entry_size > len(data):
        raise ValueError("Invalid universal Mach-O count.")
    slices, ranges = {}, []
    for index in range(count):
        values = struct.unpack_from(">IIQQII" if fat64 else ">IIIII", data, 8 + index * entry_size)
        cpu, _, offset, length, alignment = values[:5]
        if alignment > 30 or offset % (1 << alignment) or offset < 8 + count * entry_size:
            raise ValueError("Invalid universal Mach-O alignment.")
        if any(offset < end and start < offset + length for start, end in ranges):
            raise ValueError("Overlapping universal Mach-O slices.")
        architecture, minimum = thin(offset, length)
        if architecture in slices or ARCHIVES[architecture][2] != cpu:
            raise ValueError("Repeated or inconsistent universal Mach-O architecture.")
        slices[architecture] = minimum
        ranges.append((offset, offset + length))
    return slices


def check_minimum(slices, declared):
    ceiling = version_tuple(declared)
    if any(version_tuple(value) > ceiling for value in slices.values()):
        raise ValueError("A binary requires newer macOS than the app declares.")


def tar_member(archive, name, limit):
    entries = [entry for entry in archive.getmembers() if entry.name == name]
    if len(entries) != 1 or not entries[0].isfile() or not 0 < entries[0].size <= limit:
        raise ValueError("Expected one bounded regular archive member.")
    with archive.extractfile(entries[0]) as source:
        data = source.read(limit + 1)
    if len(data) != entries[0].size or len(data) > limit:
        raise ValueError("Archive member size did not match.")
    return data


def fresh_directory(output):
    output = Path(os.path.abspath(output))
    if output.exists() or output.is_symlink() or output.parent.resolve(strict=True) != output.parent:
        raise ValueError("Choose a new canonical output directory.")
    output.mkdir(mode=0o700)
    return output


def write_new(root, relative, data, mode=0o644):
    target = root / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.parent.resolve(strict=True) != target.parent or target.is_symlink():
        raise ValueError("Runtime output cannot pass through symbolic links.")
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        with os.fdopen(fd, "wb", closefd=False) as destination:
            destination.write(data)
    finally:
        os.close(fd)
    return target


def prepare(archives, output, declared_minimum):
    version_tuple(declared_minimum)
    payloads, entries = {}, []
    for architecture, (platform, expected_sha, _) in ARCHIVES.items():
        data = read_regular(Path(archives) / f"node-v{VERSION}-{platform}.tar.gz", MAX_ARCHIVE)
        if sha(data) != expected_sha:
            raise ValueError("Official Node archive SHA256 did not match.")
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            prefix = f"node-v{VERSION}-{platform}"
            binary = tar_member(archive, prefix + "/bin/node", MAX_BINARY)
            license_data = tar_member(archive, prefix + "/LICENSE", MAX_LICENSE)
        slices = macho_slices(binary)
        if set(slices) != {architecture}:
            raise ValueError("The Node helper has the wrong CPU slices.")
        check_minimum(slices, declared_minimum)
        license_data.decode("utf-8", errors="strict")
        entry = {"architecture": architecture, "path": f"Contents/Helpers/node-{architecture}",
                 "archiveURL": f"https://nodejs.org/download/release/v{VERSION}/node-v{VERSION}-{platform}.tar.gz",
                 "archiveSHA256": expected_sha, "unsignedSHA256": sha(binary),
                 "minimumMacOS": slices[architecture], "licensePath": f"Contents/Resources/assistant/Node-LICENSE-{architecture}.txt",
                 "licenseSHA256": sha(license_data)}
        payloads[architecture] = binary, license_data
        entries.append(entry)
    output = fresh_directory(output)
    manifest = {"schemaVersion": 1, "name": "Node.js", "version": VERSION, "checksumSource": CHECKSUM_SOURCE,
                "state": "unsigned", "files": entries}
    for entry in entries:
        binary, license_data = payloads[entry["architecture"]]
        write_new(output, entry["path"], binary, 0o755)
        write_new(output, entry["licensePath"], license_data)
    write_new(output, MANIFEST, (json.dumps(manifest, indent=2) + "\n").encode())
    return manifest


def validate_entries(manifest, state):
    if manifest.get("schemaVersion") != 1 or manifest.get("name") != "Node.js" or manifest.get("version") != VERSION or manifest.get("checksumSource") != CHECKSUM_SOURCE or manifest.get("state") != state:
        raise ValueError("The runtime manifest has invalid provenance or state.")
    entries = manifest.get("files")
    if not isinstance(entries, list) or len(entries) != 2 or {entry.get("architecture") for entry in entries if isinstance(entry, dict)} != set(ARCHIVES):
        raise ValueError("Both runtime architectures are required.")
    for entry in entries:
        architecture = entry["architecture"]
        platform, expected_sha, _ = ARCHIVES[architecture]
        if entry.get("path") != f"Contents/Helpers/node-{architecture}" or entry.get("licensePath") != f"Contents/Resources/assistant/Node-LICENSE-{architecture}.txt" or entry.get("archiveSHA256") != expected_sha or entry.get("archiveURL") != f"https://nodejs.org/download/release/v{VERSION}/node-v{VERSION}-{platform}.tar.gz":
            raise ValueError("The runtime manifest changed a pinned path or source.")
        for key in ["unsignedSHA256", "licenseSHA256"] + (["signedSHA256"] if state == "signed" else []):
            if not isinstance(entry.get(key), str) or not re.fullmatch(r"[a-f0-9]{64}", entry[key]):
                raise ValueError("The runtime manifest has invalid hashes.")
        version_tuple(entry.get("minimumMacOS"))
    return entries


def install(payload, app, trusted_manifest, declared_minimum):
    app = Path(os.path.abspath(app))
    if app.resolve(strict=True) != app or not app.is_dir() or app.suffix != ".app":
        raise ValueError("Install the runtime only into a canonical macOS app bundle.")
    disk_manifest = json.loads(read_regular(Path(payload) / MANIFEST, 64 * 1024))
    if disk_manifest != trusted_manifest:
        raise ValueError("The prepared runtime manifest changed before copy.")
    captures = []
    for entry in validate_entries(trusted_manifest, "unsigned"):
        binary = read_regular(Path(payload) / entry["path"], MAX_BINARY)
        license_data = read_regular(Path(payload) / entry["licensePath"], MAX_LICENSE)
        if sha(binary) != entry["unsignedSHA256"] or sha(license_data) != entry["licenseSHA256"]:
            raise ValueError("The prepared runtime payload changed before copy.")
        slices = macho_slices(binary)
        if slices != {entry["architecture"]: entry["minimumMacOS"]}:
            raise ValueError("The runtime CPU or minimum macOS metadata changed.")
        check_minimum(slices, declared_minimum)
        captures.append((entry, binary, license_data))
    for entry, binary, license_data in captures:
        write_new(app, entry["path"], binary, 0o755)
        write_new(app, entry["licensePath"], license_data)
    write_new(app, MANIFEST, (json.dumps(trusted_manifest, indent=2) + "\n").encode())


def run(*args, stderr=False, env=None):
    result = subprocess.run([str(value) for value in args], check=True, text=True,
                            capture_output=True, timeout=60, env=env)
    if len(result.stdout) + len(result.stderr) > 128 * 1024:
        raise ValueError("The runtime validation tool exceeded its output limit.")
    return result.stdout + ("\n" + result.stderr if stderr else "")


def signing_state(path, team, runner=run):
    if not isinstance(team, str) or not re.fullmatch(r"[A-Z0-9]{10}", team):
        raise ValueError("A valid signing team is required.")
    requirement = f'anchor apple generic and certificate leaf[subject.OU] = "{team}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
    # codesign reads -R as a file path unless the requirement text starts with "=".
    runner("/usr/bin/codesign", "--verify", "--strict", "-R=" + requirement, path)
    details = runner("/usr/bin/codesign", "-dvv", path, stderr=True)
    flags = re.search(r"^CodeDirectory\b.*\bflags=0x([0-9a-fA-F]+)", details, re.MULTILINE)
    if not flags or not int(flags.group(1), 16) & 0x10000 or "Authority=Developer ID Application:" not in details or f"TeamIdentifier={team}\n" not in details + "\n":
        raise ValueError("A matching Developer ID hardened-runtime signature is required.")
    return plistlib.loads(runner("/usr/bin/codesign", "-d", "--entitlements", ":-", path).encode())


def helper_entitlements(data):
    values = plistlib.loads(data)
    if not isinstance(values, dict) or any(key not in ENTITLEMENT_KEYS or value is not True for key, value in values.items()):
        raise ValueError("Only explicit V8 memory entitlements are permitted for the helper.")
    return values


def sign_and_probe(app, identity, team, entitlements_path, trusted_manifest, runner=run):
    entitlements_path = Path(entitlements_path)
    approved_entitlements = helper_entitlements(read_regular(entitlements_path, 8 * 1024))
    manifest = json.loads(json.dumps(trusted_manifest))
    entries = validate_entries(manifest, "unsigned")
    app = Path(app)
    for entry in entries:
        node = app / entry["path"]
        if sha(read_regular(node, MAX_BINARY)) != entry["unsignedSHA256"]:
            raise ValueError("The unsigned helper changed before signing.")
        runner("/usr/bin/codesign", "--force", "--sign", identity, "--options", "runtime", "--timestamp", "--entitlements", entitlements_path, node)
        if signing_state(node, team, runner) != approved_entitlements:
            raise ValueError("The helper's signed entitlements do not match the requested file.")
        environment = {"PATH": "/usr/bin:/bin", "HOME": str(Path.home()), "LANG": "en_US.UTF-8"}
        arch = entry["architecture"]
        if macho_slices(read_regular(node, MAX_BINARY)) != {arch: entry["minimumMacOS"]}:
            raise ValueError("The signed helper CPU or minimum OS changed before startup.")
        probe = json.loads(runner("/usr/bin/arch", "-" + arch, node, "--allow-natives-syntax", "-e", PROBE, env=environment))
        if probe != {"version": VERSION, "architecture": "x64" if arch == "x86_64" else "arm64", "jit": True}:
            raise ValueError("The signed V8 startup probe failed.")
        entry["signedSHA256"] = sha(read_regular(node, MAX_BINARY))
        entry["startupProbe"] = probe
    manifest.update(state="signed", teamIdentifier=team, helperEntitlements=approved_entitlements)
    target = app / MANIFEST
    # Only replace the exact manifest just copied into this newly-created archive.
    if json.loads(read_regular(target, 64 * 1024)) != trusted_manifest:
        raise ValueError("The copied runtime manifest changed before sealing.")
    temporary = target.with_name("node-runtime.signed.json")
    write_new(app, str(temporary.relative_to(app)), (json.dumps(manifest, indent=2) + "\n").encode())
    os.replace(temporary, target)
    return manifest


def validate(app, info, runner=run):
    app = Path(app)
    declared = info.get("LSMinimumSystemVersion")
    version_tuple(declared)
    executable = app / "Contents/MacOS" / info["CFBundleExecutable"]
    slices = macho_slices(read_regular(executable, MAX_BINARY))
    if set(slices) != set(ARCHIVES):
        raise ValueError("An official Arya app requires both arm64 and x86_64 slices.")
    check_minimum(slices, declared)
    manifest = json.loads(read_regular(app / MANIFEST, 64 * 1024))
    entries = validate_entries(manifest, "signed")
    team = manifest.get("teamIdentifier")
    signing_state(app, team, runner)
    entitlements = manifest.get("helperEntitlements")
    if not isinstance(entitlements, dict) or any(key not in ENTITLEMENT_KEYS or value is not True for key, value in entitlements.items()):
        raise ValueError("Invalid helper entitlement declaration.")
    for entry in entries:
        binary = read_regular(app / entry["path"], MAX_BINARY)
        license_data = read_regular(app / entry["licensePath"], MAX_LICENSE)
        if sha(binary) != entry["signedSHA256"] or sha(license_data) != entry["licenseSHA256"]:
            raise ValueError("The signed runtime or license hash did not match.")
        license_data.decode("utf-8", errors="strict")
        helper_slices = macho_slices(binary)
        if helper_slices != {entry["architecture"]: entry["minimumMacOS"]}:
            raise ValueError("The signed runtime CPU or minimum OS did not match.")
        check_minimum(helper_slices, declared)
        if signing_state(app / entry["path"], team, runner) != entitlements:
            raise ValueError("The helper entitlement signature did not match.")
        expected_probe = {"version": VERSION, "architecture": "x64" if entry["architecture"] == "x86_64" else "arm64", "jit": True}
        if entry.get("startupProbe") != expected_probe:
            raise ValueError("The signed runtime lacks its architecture's successful V8 startup receipt.")
    return {"version": VERSION, "teamIdentifier": team, "architectures": sorted(slices),
            "manifestSHA256": sha(read_regular(app / MANIFEST, 64 * 1024)),
            "signedSHA256": {entry["architecture"]: entry["signedSHA256"] for entry in entries}}

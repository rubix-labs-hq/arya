#!/usr/bin/env python3
"""Read one bounded regular file through pinned, no-follow directory handles."""
import json
import os
import stat
import sys

MAXIMUM = 2 * 1024 * 1024
REQUEST_LIMIT = 16 * 1024


def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)


def stamp(info):
    return identity(info) + (info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def components(path, absolute=False):
    if not isinstance(path, str) or not path or "\0" in path:
        raise ValueError("Invalid path.")
    if absolute:
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Invalid root.")
        path = path[1:]
        if not path:
            return []
    elif path.startswith("/"):
        raise ValueError("Invalid relative path.")
    parts = path.split("/")
    if len(parts) > 256 or any(part in ("", ".", "..") for part in parts):
        raise ValueError("Invalid path components.")
    return parts


def bounded_read(root, path, maximum=MAXIMUM):
    if type(maximum) is not int or not 0 < maximum <= MAXIMUM:
        raise ValueError("Invalid read limit.")
    root_parts, file_parts = components(root, True), components(path)
    if os.open not in os.supports_dir_fd or os.stat not in os.supports_dir_fd:
        raise OSError("Descriptor-relative operations unavailable.")
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
    directory_flags = flags | os.O_DIRECTORY
    descriptors, links = [], []
    try:
        parent = os.open("/", directory_flags)
        descriptors.append(parent)
        root_identity = identity(os.fstat(parent))
        if not stat.S_ISDIR(root_identity[2]):
            raise OSError("Non-directory root.")
        for name in root_parts + file_parts[:-1]:
            before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode):
                raise OSError("Non-directory ancestor.")
            child = os.open(name, directory_flags, dir_fd=parent)
            descriptors.append(child)
            opened = os.fstat(child)
            current = os.stat(name, dir_fd=parent, follow_symlinks=False)
            if identity(before) != identity(opened) or identity(opened) != identity(current):
                raise OSError("Ancestor changed.")
            links.append((parent, name, child, identity(opened)))
            parent = child
        leaf = file_parts[-1]
        before = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISREG(before.st_mode):
            raise OSError("Nonregular file.")
        source = os.open(leaf, flags, dir_fd=parent)
        descriptors.append(source)
        opened = os.fstat(source)
        if not stat.S_ISREG(opened.st_mode) or stamp(before) != stamp(opened):
            raise OSError("File changed before opening.")

        def verify():
            if identity(os.fstat(descriptors[0])) != root_identity:
                raise OSError("Root changed.")
            for owner, name, child, expected in links:
                if identity(os.fstat(child)) != expected or identity(
                    os.stat(name, dir_fd=owner, follow_symlinks=False)
                ) != expected:
                    raise OSError("Ancestor changed.")
            if stamp(os.fstat(source)) != stamp(opened) or stamp(
                os.stat(leaf, dir_fd=parent, follow_symlinks=False)
            ) != stamp(opened):
                raise OSError("File changed.")

        verify()
        if opened.st_size > maximum:
            return None
        chunks, total = [], 0
        while total <= maximum:
            chunk = os.read(source, min(64 * 1024, maximum + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        verify()
        if total > maximum:
            return None
        if total != opened.st_size:
            raise OSError("File size changed during reading.")
        return b"".join(chunks)
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError("Unexpected arguments.")
        request = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
        if len(request) > REQUEST_LIMIT:
            raise ValueError("Request too large.")
        decoded = json.loads(request)
        if type(decoded) is not dict or set(decoded) != {"root", "path", "maximum"}:
            raise ValueError("Invalid request.")
        result = bounded_read(decoded["root"], decoded["path"], decoded["maximum"])
        sys.stdout.buffer.write(b"ARYA_LIMIT\n" if result is None else b"ARYA_OK\n" + result)
        return 0
    except Exception:
        # Paths, exception text, and file content never enter failure output.
        sys.stderr.write("Working-file read rejected.\n")
        return 2


if __name__ == "__main__":
    sys.exit(main())

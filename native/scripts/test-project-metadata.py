#!/usr/bin/env python3
"""Exercise real project metadata code in macOS and Mac Catalyst executables."""
import platform
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "native/ReelKit/Sources/NativeProjectIO"
PROBE = r'''
#define _DARWIN_C_SOURCE 1
#include "NativeProjectIO.h"
#include <sys/stat.h>
#include <sys/xattr.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures, checks;
static void check(int ok, const char *label) {
    checks++;
    if (!ok) { failures++; fprintf(stderr, "FAIL: %s (errno=%d)\n", label, errno); }
}
static void put(int fd, const char *key, const char *value) {
    if (fsetxattr(fd, key, value, strlen(value), 0, 0)) { perror("fsetxattr fixture"); exit(2); }
}
static void same_value(int fd, const char *key, const char *value, const char *label) {
    char buffer[256];
    ssize_t length = fgetxattr(fd, key, buffer, sizeof(buffer), 0, 0);
    check(length == (ssize_t)strlen(value) && !memcmp(buffer, value, strlen(value)), label);
}
static void put_bytes(int fd, const char *key, const void *value, size_t size) {
    if (fsetxattr(fd, key, value, size, 0, 0)) { perror("fsetxattr fixture"); exit(2); }
}
static void pair(const char *name, int *original, int *staged) {
    char first[64], second[64];
    snprintf(first, sizeof(first), "%s-original", name); snprintf(second, sizeof(second), "%s-staged", name);
    *original = open(first, O_CREAT | O_EXCL | O_RDWR, 0600);
    *staged = open(second, O_CREAT | O_EXCL | O_RDWR, 0600);
    if (*original < 0 || *staged < 0) { perror("open fixture"); exit(2); }
    check(arya_clear_project_acl(*original) == 0 && arya_clear_project_acl(*staged) == 0, name);
    fremovexattr(*original, "com.apple.quarantine", 0); fremovexattr(*staged, "com.apple.quarantine", 0);
}
static int lacks_value(int fd, const char *key, const void *value, size_t size) {
    char buffer[256];
    ssize_t length = fgetxattr(fd, key, buffer, sizeof(buffer), 0, 0);
    return length != (ssize_t)size || memcmp(buffer, value, size);
}
#define UUID_A "3F1A2B3C-0000-4000-8000-123456789ABC"
#define UUID_B "0b5e2a9c-1111-4222-8333-444455556666"
// The App Sandbox kernel ORs flags 0x0086 into a quarantine a sandboxed app writes and keeps
// the stage's own time and creator. These values reproduce the save that failed for real users.
static void kernel_cases(void) {
    int original, staged;
    const char *key = "com.apple.quarantine";
    pair("sandbox-merge", &original, &staged);
    put(original, key, "0081;00000000;;");
    put(staged, key, "0087;6b020329;Arya;");
    check(arya_verify_project_metadata(original, staged) == 0, "accept sandbox flags merged into iCloud quarantine");
    check(arya_copy_project_metadata(original, staged) == 0, "copy accepts sandbox flags merged into iCloud quarantine");
    same_value(staged, key, "0087;6b020329;Arya;", "sandbox merged quarantine kept");
    same_value(original, key, "0081;00000000;;", "iCloud original quarantine unchanged");
    close(original); close(staged);

    pair("sandbox-download", &original, &staged);
    put(original, key, "0083;6b000000;Safari;" UUID_A);
    const struct { const char *value; int allowed; } cases[] = {
        {"0087;6b020329;Arya;" UUID_A, 1}, {"0087;6b020329;Arya;" UUID_B, 1},
        {"0087;6b020329;Arya;", 1}, {"0083;6b000000;Safari;" UUID_A, 1},
        {"0086;6b020329;Arya;" UUID_A, 0}, {"0082;6b020329;Arya;" UUID_A, 0},
        {"00c3;6b020329;Arya;" UUID_A, 0}, {"00a7;6b020329;Arya;" UUID_A, 0},
        {"0187;6b020329;Arya;" UUID_A, 0}, {"008f;6b020329;Arya;" UUID_A, 0},
        {"0087;6affffff;Arya;" UUID_A, 0}, {"0087;6b020329;Arya;event", 0},
        {"0087;6b020329;Arya;3F1A2B3C-0000-4000-8000-123456789ABZ", 0},
        {"0087;6b020329;Arya;3F1A2B3C00000-4000-8000-123456789ABC", 0},
        {"0087;6b020329;Arya;" UUID_A ";extra", 0}, {"0g87;6b020329;Arya;" UUID_A, 0}
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        put(staged, key, cases[i].value);
        int result = arya_verify_project_metadata(original, staged);
        check(cases[i].allowed ? result == 0 : result == -1 && errno == EINVAL, cases[i].value);
        same_value(original, key, "0083;6b000000;Safari;" UUID_A, "download restrictions unchanged");
    }
    close(original); close(staged);

    pair("custom-event", &original, &staged);
    put(original, key, "0083;6b000000;Safari;custom");
    put(staged, key, "0087;6b020329;Arya;" UUID_A);
    check(arya_verify_project_metadata(original, staged) == -1 && errno == EINVAL, "reject replaced non-UUID event");
    put(staged, key, "0087;6b020329;Arya;custom");
    check(arya_verify_project_metadata(original, staged) == 0, "accept identical non-UUID event");
    close(original); close(staged);

    const unsigned char macl[] = {4, 0, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99};
    const unsigned char other_macl[] = {4, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16};
    const unsigned char provenance[] = {1, 2, 0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88};
    const unsigned char other_provenance[] = {1, 2, 0, 0xf6, 0xbb, 0x28, 0xfa, 0xf4, 0x30, 0xa6, 0x62};
    pair("managed-added", &original, &staged);
    put_bytes(staged, "com.apple.macl", macl, sizeof(macl));
    put_bytes(staged, "com.apple.provenance", provenance, sizeof(provenance));
    put(staged, "com.apple.lastuseddate#PS", "0123456789abcdef");
    check(arya_verify_project_metadata(original, staged) == 0, "accept kernel attributes added to the stage");
    check(arya_copy_project_metadata(original, staged) == 0, "copy accepts kernel attributes added to the stage");
    close(original); close(staged);

    pair("managed-differs", &original, &staged);
    put_bytes(original, "com.apple.macl", macl, sizeof(macl));
    put_bytes(original, "com.apple.provenance", provenance, sizeof(provenance));
    put(original, "com.apple.lastuseddate#PS", "fedcba9876543210");
    put_bytes(staged, "com.apple.macl", other_macl, sizeof(other_macl));
    put_bytes(staged, "com.apple.provenance", other_provenance, sizeof(other_provenance));
    check(arya_verify_project_metadata(original, staged) == 0, "accept per-file kernel attributes that differ or are missing");
    check(arya_copy_project_metadata(original, staged) == 0, "copy accepts per-file kernel attributes that differ");
    put(original, "com.arya.required", "required");
    check(arya_verify_project_metadata(original, staged) == -1 && errno == EINVAL, "kernel attributes do not hide a missing custom attribute");
    check(arya_copy_project_metadata(original, staged) == 0, "copy custom attributes beside kernel attributes");
    same_value(staged, "com.arya.required", "required", "custom attribute copied beside kernel attributes");
    check(lacks_value(staged, "com.apple.macl", macl, sizeof(macl)), "original access label is not copied");
    check(lacks_value(staged, "com.apple.lastuseddate#PS", "fedcba9876543210", 16), "original last-used date is not copied");
    put(staged, "com.arya.required", "changed");
    check(arya_verify_project_metadata(original, staged) == -1 && errno == EINVAL, "reject changed custom attribute beside kernel attributes");
    close(original); close(staged);
}
int main(void) {
    int original = open("original", O_CREAT | O_EXCL | O_RDWR, 0600);
    int staged = open("staged", O_CREAT | O_EXCL | O_RDWR, 0600);
    if (original < 0 || staged < 0) { perror("open fixture"); return 2; }
    check(arya_clear_project_acl(original) == 0 && arya_clear_project_acl(staged) == 0, "prepare files");
    const char *key = "com.apple.quarantine";
    fremovexattr(original, key, 0); fremovexattr(staged, key, 0);
    put(staged, key, "0081;00000000;Arya;");
    check(arya_verify_project_metadata(original, staged) == 0, "allow new stage quarantine");
    check(arya_copy_project_metadata(original, staged) == 0, "copy retains new stage quarantine");
    same_value(staged, key, "0081;00000000;Arya;", "stage quarantine not removed");
    check(fgetxattr(original, key, NULL, 0, 0, 0) < 0 && errno == ENOATTR, "original remains unchanged");
    put(original, key, "0082;6ad1b39b;Arya;");
    const struct { const char *value; int allowed; } cases[] = {
        {"0082;6ad1b4b7;Arya;", 1}, {"0082;6ad1b4b7;Other;", 1},
        {"0080;6ad1b4b7;Arya;", 0}, {"0082;6ad1b4b7;Arya;event", 0},
        {"0082;6ad1b39a;Arya;", 0}, {"0082;6ad1b4bg;Arya;", 0},
        {"0082:6ad1b4b7;Arya;", 0}, {"0082;6ad1b4b7:Arya;", 0},
        {"0082;06ad1b4b7;Arya;", 0}
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
        put(staged, key, cases[i].value);
        int result = arya_verify_project_metadata(original, staged);
        check(cases[i].allowed ? result == 0 : result == -1 && errno == EINVAL, cases[i].value);
        if (cases[i].allowed) {
            check(arya_copy_project_metadata(original, staged) == 0, "copy accepts refreshed quarantine");
            same_value(staged, key, cases[i].value, "copy preserves refreshed quarantine");
        }
        same_value(original, key, "0082;6ad1b39b;Arya;", "original restrictions unchanged");
    }
    fremovexattr(staged, key, 0);
    check(arya_verify_project_metadata(original, staged) == -1 && errno == EINVAL, "reject removed quarantine");
    put(staged, key, "0082;6ad1b39b;Arya;");
    put(staged, "com.arya.unexpected", "extra");
    check(arya_verify_project_metadata(original, staged) == -1 && errno == EINVAL, "reject unexpected xattr");
    fremovexattr(staged, "com.arya.unexpected", 0);
    put(original, "com.arya.required", "required");
    check(arya_verify_project_metadata(original, staged) == -1 && errno == EINVAL, "reject missing xattr");
    check(arya_copy_project_metadata(original, staged) == 0, "copy required attributes");
    same_value(staged, "com.arya.required", "required", "required attribute retained");
    fchmod(staged, 0644);
    check(arya_verify_project_metadata(original, staged) == -1 && errno == EINVAL, "reject broader mode");
    fchmod(staged, 0600);
    check(link("staged", "alias") == 0, "prepare hard link");
    check(arya_verify_project_metadata(original, staged) == -1 && errno == EINVAL, "reject multiply linked project");
    close(original); close(staged);
    kernel_cases();
    printf("%d metadata checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
'''


def main():
    if platform.system() != "Darwin":
        raise SystemExit("This test needs macOS and the Xcode macOS SDK")
    sdk = subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], text=True).strip()
    arch = platform.machine()
    failures = []
    with tempfile.TemporaryDirectory(prefix="arya-project-metadata-") as directory:
        root = Path(directory)
        probe = root / "probe.c"
        probe.write_text(PROBE)
        for name, target in [("macOS", f"{arch}-apple-macos14.0"),
                             ("MacCatalyst", f"{arch}-apple-ios17.0-macabi")]:
            folder = root / name
            folder.mkdir()
            binary = folder / "probe"
            subprocess.run(["xcrun", "clang", "-target", target, "-isysroot", sdk,
                            "-I", str(SOURCE / "include"), str(probe),
                            str(SOURCE / "NativeProjectIO.c"), "-o", str(binary)], check=True)
            result = subprocess.run([str(binary)], cwd=folder, text=True, capture_output=True)
            print(name + ": " + result.stdout.strip(), flush=True)
            if result.returncode:
                print(result.stderr, end="", flush=True)
                failures.append(name)
    if failures:
        raise SystemExit("Metadata regression: " + ", ".join(failures))


if __name__ == "__main__":
    main()

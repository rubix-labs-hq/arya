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

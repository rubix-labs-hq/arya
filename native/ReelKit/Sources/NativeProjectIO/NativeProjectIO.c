#define _DARWIN_C_SOURCE 1
#include "NativeProjectIO.h"
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/acl.h>
#include <sys/xattr.h>
#include <copyfile.h>
#include <fcntl.h>
#include <TargetConditionals.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define MAX_METADATA (4ULL * 1024 * 1024)
static _Thread_local const char *failed_operation;
const char *arya_project_io_error_operation(void) { return failed_operation; }
static int failure(const char *operation) { failed_operation = operation; return -1; }
static int invalid(void) { errno = EINVAL; return failure("verify project metadata equality and limits"); }
// iOS, and macOS in iCloud-synced folders, mark documents with UF_TRACKED for document-ID tracking,
// including files this code just created. It changes no access rights, so it is the one flag allowed.
static int unsupported_flags(const struct stat *info) { return (info->st_flags & ~(uint32_t)UF_TRACKED) != 0; }
static acl_t get_acl(int fd) {
    acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
    if (!acl && errno == ENOENT) {
        acl = acl_init(0);
        if (!acl) failure("acl_init empty ACL");
    } else if (!acl) failure("acl_get_fd_np");
    return acl;
}
static void *acl_bytes(acl_t acl, size_t *size) {
    ssize_t required = acl_size(acl);
    if (required < 0) { failure("acl_size"); return NULL; }
    if (!required || (uint64_t)required > MAX_METADATA) { invalid(); return NULL; }
    void *bytes = calloc((size_t)required, 1);
    if (!bytes) { failure("allocate ACL bytes"); return NULL; }
    ssize_t count = acl_copy_ext(bytes, acl, required);
    if (count < 0) { int code = errno; free(bytes); errno = code; failure("acl_copy_ext"); return NULL; }
    if (count != required) { free(bytes); invalid(); return NULL; }
    *size = (size_t)required;
    return bytes;
}
static void *get_acl_bytes(int fd, size_t *size) {
    acl_t acl = get_acl(fd);
    if (!acl) return NULL;
    void *bytes = acl_bytes(acl, size);
    int code = errno; acl_free(acl); errno = code;
    return bytes;
}
#if TARGET_OS_IOS && !TARGET_OS_MACCATALYST
static int verify_protection_class(int original_fd, int staged_fd) {
    int original = fcntl(original_fd, F_GETPROTECTIONCLASS);
    if (original < 0) return failure("fcntl original Data Protection class");
    int staged = fcntl(staged_fd, F_GETPROTECTIONCLASS);
    if (staged < 0) return failure("fcntl staged Data Protection class");
    if (original != staged) {
        errno = EINVAL; return failure("verify project Data Protection class equality");
    }
    return 0;
}
#endif
static char *names(int fd, ssize_t *size) {
    *size = flistxattr(fd, NULL, 0, 0);
    if (*size < 0) { failure("flistxattr size"); return NULL; }
    if ((uint64_t)*size > MAX_METADATA) { invalid(); return NULL; }
    char *result = calloc((size_t)*size + 1, 1);
    if (!result) { failure("allocate xattr names"); return NULL; }
    if (*size) {
        ssize_t count = flistxattr(fd, result, (size_t)*size, 0);
        if (count < 0) { int code = errno; free(result); errno = code; failure("flistxattr names"); return NULL; }
        if (count != *size) { free(result); invalid(); return NULL; }
    }
    return result;
}
#if TARGET_OS_OSX
// macOS may regenerate the quarantine creator and timestamp for a new file.
// Keep the kernel's marker. Require identical flags and event identity, a valid
// bounded representation, and no timestamp rollback. Other attributes stay exact.
static int quarantine_restrictions_preserved(const void *original, size_t size, const void *staged, size_t other) {
    const unsigned char *a = original, *b = staged;
    if (size < 15 || other < 15 || size > 4096 || other > 4096 ||
        a[4] != ';' || b[4] != ';' || a[13] != ';' || b[13] != ';' ||
        memcmp(a, b, 5) || memchr(a, 0, size) || memchr(b, 0, other)) return 0;
    const unsigned char *ae = memchr(a + 14, ';', size - 14), *be = memchr(b + 14, ';', other - 14);
    if (!ae || !be || size - (size_t)(ae - a) != other - (size_t)(be - b) ||
        memcmp(ae, be, size - (size_t)(ae - a))) return 0;
    uint32_t before = 0, after = 0;
    for (size_t i = 0; i < 13; i++) {
        if (i == 4) continue;
        unsigned int x = a[i], y = b[i];
        x = x >= '0' && x <= '9' ? x - '0' : x >= 'a' && x <= 'f' ? x - 'a' + 10 : x >= 'A' && x <= 'F' ? x - 'A' + 10 : 16;
        y = y >= '0' && y <= '9' ? y - '0' : y >= 'a' && y <= 'f' ? y - 'a' + 10 : y >= 'A' && y <= 'F' ? y - 'A' + 10 : 16;
        if (x > 15 || y > 15) return 0;
        if (i > 4) { before = (before << 4) | x; after = (after << 4) | y; }
    }
    return after >= before;
}
#endif
// Returns one for unequal metadata, minus one for a failed read, and zero for equality.
static int compare_xattrs(int from, int to, int verify) {
    ssize_t source_size = 0, target_size = 0;
    char *source = names(from, &source_size);
    if (!source) return -1;
    char *target = verify ? names(to, &target_size) : NULL;
    if (verify && !target) { int code = errno; free(source); errno = code; return -1; }
    size_t source_count = 0, target_count = 0, total = 0;
    int result = -1;
    for (size_t p = 0; verify && p < (size_t)target_size;) {
        size_t length = strnlen(target + p, (size_t)target_size - p);
        if (length >= (size_t)target_size - p) { invalid(); goto done; }
#if TARGET_OS_OSX
        // App Sandbox can add quarantine to a new stage. Retain that marker when the
        // original has none; original quarantine restrictions remain unchanged.
        if (!strcmp(target + p, "com.apple.quarantine")) {
            ssize_t original = fgetxattr(from, target + p, NULL, 0, 0, 0);
            if (original < 0 && errno != ENOATTR) { failure("fgetxattr original quarantine size"); goto done; }
            if (original < 0) {
                ssize_t added = fgetxattr(to, target + p, NULL, 0, 0, 0);
                if (added < 0) { failure("fgetxattr staged quarantine size"); goto done; }
                if ((uint64_t)added > MAX_METADATA) { invalid(); goto done; }
                total += (size_t)added; p += length + 1; continue;
            }
        }
#endif
        target_count++; p += length + 1;
    }
    for (size_t p = 0; p < (size_t)source_size;) {
        size_t length = strnlen(source + p, (size_t)source_size - p);
        if (length >= (size_t)source_size - p || !strcmp(source + p, "com.apple.decmpfs")) { invalid(); goto done; }
        const char *name = source + p;
        ssize_t size = fgetxattr(from, name, NULL, 0, 0, 0);
        if (size < 0) { failure("fgetxattr original size"); goto done; }
        if ((uint64_t)size > MAX_METADATA || total + (uint64_t)size > MAX_METADATA) { invalid(); goto done; }
        total += (size_t)size;
        if (verify) {
            ssize_t other = fgetxattr(to, name, NULL, 0, 0, 0);
            if (other < 0) {
                if (errno == ENOATTR) { result = 1; goto done; }
                failure("fgetxattr staged size"); goto done;
            }
            int quarantine = 0;
#if TARGET_OS_OSX
            quarantine = !strcmp(name, "com.apple.quarantine");
#endif
            if (other != size && !quarantine) { result = 1; goto done; }
            if ((uint64_t)other > MAX_METADATA || (other > size && total + (uint64_t)(other - size) > MAX_METADATA)) { invalid(); goto done; }
            if (other > size) total += (size_t)(other - size);
            void *a = malloc((size_t)size + 1), *b = malloc((size_t)other + 1);
            if (!a || !b) { free(a); free(b); errno = ENOMEM; failure("allocate xattr values"); goto done; }
            ssize_t first = fgetxattr(from, name, a, (size_t)size, 0, 0);
            ssize_t second = first < 0 ? -1 : fgetxattr(to, name, b, (size_t)other, 0, 0);
            int code = errno;
            int equal = first == size && second == other && size == other && !memcmp(a, b, (size_t)size);
#if TARGET_OS_OSX
            if (!equal && first == size && second == other && quarantine)
                equal = quarantine_restrictions_preserved(a, (size_t)size, b, (size_t)other);
#endif
            free(a); free(b);
            if (first < 0 || second < 0) { errno = code; failure(first < 0 ? "fgetxattr original value" : "fgetxattr staged value"); goto done; }
            if (!equal) { result = 1; goto done; }
        }
        source_count++; p += length + 1;
    }
    if (verify && source_count != target_count) { result = 1; goto done; }
    result = 0;
done:
    { int code = errno; free(source); free(target); errno = code; return result; }
}
static int verify_xattrs(int from, int to, int verify) {
    int result = compare_xattrs(from, to, verify);
    return result > 0 ? invalid() : result;
}
int arya_try_lock_project_publication(int fd) {
    failed_operation = NULL;
    if (flock(fd, LOCK_EX | LOCK_NB)) return failure("flock project publication");
    return 0;
}
int arya_clear_project_acl(int fd) {
    failed_operation = NULL;
    acl_t empty = acl_init(0);
    if (!empty) return failure("acl_init empty ACL");
    size_t expected_size = 0, actual_size = 0;
    void *expected = acl_bytes(empty, &expected_size), *actual = NULL;
    int result = -1, code = 0;
    struct stat info;
    if (!expected) goto done;
    actual = get_acl_bytes(fd, &actual_size);
    if (!actual) goto done;
    // Compare complete ACL bytes, including header and entry flags, before skipping a setter.
    if ((expected_size != actual_size || memcmp(expected, actual, expected_size)) && acl_set_fd_np(fd, empty, ACL_TYPE_EXTENDED)) {
        failure("acl_set_fd_np clear ACL"); goto done;
    }
    if (fstat(fd, &info)) { failure("fstat private file mode"); goto done; }
    if (!S_ISREG(info.st_mode) || info.st_nlink != 1 || unsupported_flags(&info) || (info.st_mode & 07000)) { invalid(); goto done; }
    if ((info.st_mode & 0777) != 0600 && fchmod(fd, 0600)) { failure("fchmod private file mode"); goto done; }
    free(actual); actual = get_acl_bytes(fd, &actual_size);
    if (!actual) goto done;
    if (expected_size != actual_size || memcmp(expected, actual, expected_size)) { invalid(); goto done; }
    if (fstat(fd, &info)) { failure("fstat verify private file mode"); goto done; }
    if (!S_ISREG(info.st_mode) || info.st_nlink != 1 || unsupported_flags(&info) || (info.st_mode & 07777) != 0600) { invalid(); goto done; }
    result = 0;
done:
    code = errno; free(expected); free(actual); acl_free(empty); errno = code;
    if (!result) failed_operation = NULL;
    return result;
}
int arya_copy_project_metadata(int original_fd, int staged_fd) {
    failed_operation = NULL;
    struct stat original, staged;
    if (fstat(original_fd, &original)) return failure("fstat original metadata");
    if (fstat(staged_fd, &staged)) return failure("fstat staged metadata");
    if (!S_ISREG(original.st_mode) || !S_ISREG(staged.st_mode) || original.st_nlink != 1 || staged.st_nlink != 1 ||
        unsupported_flags(&original) || (original.st_mode & 07000)) return invalid();
    size_t expected_size = 0, actual_size = 0;
    void *expected_acl = get_acl_bytes(original_fd, &expected_size);
    if (!expected_acl) return -1;
    int result = -1, code = 0;
    if (verify_xattrs(original_fd, staged_fd, 0)) goto done;
    if ((staged.st_uid != original.st_uid || staged.st_gid != original.st_gid) &&
        fchown(staged_fd, original.st_uid, original.st_gid)) { failure("fchown staged metadata"); goto done; }
    void *actual_acl = get_acl_bytes(staged_fd, &actual_size);
    if (!actual_acl) goto done;
    copyfile_flags_t flags = 0;
    if (expected_size != actual_size || memcmp(expected_acl, actual_acl, expected_size)) flags |= COPYFILE_ACL;
    free(actual_acl);
    int xattrs = compare_xattrs(original_fd, staged_fd, 1);
    if (xattrs < 0) goto done;
    if (xattrs > 0) flags |= COPYFILE_XATTR;
    // Copy access restrictions before restoring a broader mode on populated bytes.
    if (flags && fcopyfile(original_fd, staged_fd, NULL, flags)) { failure("fcopyfile project access metadata"); goto done; }
    actual_acl = get_acl_bytes(staged_fd, &actual_size);
    if (!actual_acl) goto done;
    int equal_acl = expected_size == actual_size && !memcmp(expected_acl, actual_acl, expected_size); free(actual_acl);
    if (!equal_acl) { invalid(); goto done; }
    if (verify_xattrs(original_fd, staged_fd, 1)) goto done;
    if (fstat(staged_fd, &staged)) { failure("fstat staged mode before restoration"); goto done; }
    if ((staged.st_mode & 07777) != (original.st_mode & 0777) &&
        fchmod(staged_fd, original.st_mode & 0777)) { failure("fchmod staged original mode"); goto done; }
    actual_acl = get_acl_bytes(staged_fd, &actual_size);
    if (!actual_acl) goto done;
    equal_acl = expected_size == actual_size && !memcmp(expected_acl, actual_acl, expected_size); free(actual_acl);
    if (!equal_acl) { invalid(); goto done; }
    if (verify_xattrs(original_fd, staged_fd, 1)) goto done;
    if (fstat(staged_fd, &staged)) { failure("fstat verify staged metadata"); goto done; }
    if (staged.st_uid != original.st_uid || staged.st_gid != original.st_gid ||
        unsupported_flags(&staged) || (staged.st_mode & 07000) ||
        (staged.st_mode & 0777) != (original.st_mode & 0777)) { invalid(); goto done; }
#if TARGET_OS_IOS && !TARGET_OS_MACCATALYST
    if (verify_protection_class(original_fd, staged_fd)) goto done;
#endif
    result = 0;
done:
    code = errno; free(expected_acl); errno = code;
    if (!result) failed_operation = NULL;
    return result;
}

int arya_verify_project_metadata(int original_fd, int staged_fd) {
    failed_operation = NULL;
    struct stat original, staged;
    if (fstat(original_fd, &original)) return failure("fstat original metadata verification");
    if (fstat(staged_fd, &staged)) return failure("fstat staged metadata verification");
    if (!S_ISREG(original.st_mode) || !S_ISREG(staged.st_mode) || original.st_nlink != 1 || staged.st_nlink != 1 ||
        unsupported_flags(&original) || unsupported_flags(&staged) || (original.st_mode & 07000) || (staged.st_mode & 07000) ||
        original.st_uid != staged.st_uid || original.st_gid != staged.st_gid ||
        (original.st_mode & 0777) != (staged.st_mode & 0777)) return invalid();
    size_t expected_size = 0, actual_size = 0;
    void *expected_acl = get_acl_bytes(original_fd, &expected_size);
    if (!expected_acl) return -1;
    void *actual_acl = get_acl_bytes(staged_fd, &actual_size);
    if (!actual_acl) { int code = errno; free(expected_acl); errno = code; return -1; }
    int equal = expected_size == actual_size && !memcmp(expected_acl, actual_acl, expected_size);
    free(expected_acl); free(actual_acl);
    if (!equal) return invalid();
    int result = verify_xattrs(original_fd, staged_fd, 1);
#if TARGET_OS_IOS && !TARGET_OS_MACCATALYST
    if (!result) result = verify_protection_class(original_fd, staged_fd);
#endif
    if (!result) failed_operation = NULL;
    return result;
}

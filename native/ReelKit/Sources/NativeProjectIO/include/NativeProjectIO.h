#ifndef ARYA_NATIVE_PROJECT_IO_H
#define ARYA_NATIVE_PROJECT_IO_H
// Descriptors remain owned by the caller. Failures set errno and never publish a file.
// Read immediately after failure on the same thread. The next project I/O operation resets it.
const char *arya_project_io_error_operation(void);
int arya_try_lock_project_publication(int fd);
int arya_clear_project_acl(int fd);
int arya_copy_project_metadata(int original_fd, int staged_fd);
int arya_verify_project_metadata(int original_fd, int staged_fd);
#endif

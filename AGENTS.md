# Repository rules

Instructions for coding agents working in this repository. Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup and test commands.

## Build and test storage

The user requires cleanup at the end of every task. Remove the temporary artifacts you created after their processes stop. Keep compact logs, source hashes and result manifests. Preserve source tests, project files, media, backups and release installers.

- Use `build/DerivedData` for the checkout's development app and `native/ReelKit/.build` for package tests. Reuse them across retries.
- Use the default `build/local-verification` directory for the serial verifier. It automatically prunes bulky artifacts from finished runs older than seven days, while keeping the two newest runs and their logs.
- Run `python3 native/scripts/verify-arya-local.py --cleanup` to preview retention cleanup. Run it again with `--apply` at task completion. The command only handles verifier-owned runs.
- For temporary outputs outside that managed directory, use an owned temporary directory with `finally` or a shell trap. Delete it after reviewing the result. Do not leave dated build trees behind.
- A `.keep-artifacts` file in a verification run prevents pruning. Write the reason and an expiry date in that file, and remove it when the investigation ends.
- Never copy generated builds, package caches, dependencies or browser profiles into source snapshots. Keep only the source files and a manifest of their hashes.
- Remove disposable worktrees through their owning tool or `git worktree remove` after checking for uncommitted work. Keep the branch or commit when it contains useful changes.
- Before the final reply, check the size of the artifacts you created and Git status. Explain any large artifacts that remain.

## Required cleanup before handing work back

Cleanup is part of the task, not optional follow-up work. Do not finish a task with disposable output left behind.

- Before building or testing, inspect existing output and reuse the canonical directories above. Do not create dated or per-retry DerivedData directories, dependency copies, browser profiles or source snapshots containing generated files.
- Put one-off output in a task-owned temporary directory. Arrange cleanup with `finally` or a shell trap, after its processes stop. A failed or interrupted command does not make its output permanent.
- At task completion, remove idle disposable builds, caches, copied dependencies, temporary browser profiles and experiments created by the task. Check earlier interrupted attempts too. Preserve source, project data, media, backups, release installers and compact evidence.
- For any temporary artifact that must remain, record its exact path, owner, reason and expiry in a compact task receipt. Revisit expired entries at the next task. Keep reusable canonical build caches only when they support ongoing work.
- Run the managed verifier cleanup preview and apply commands at task completion. Do not bypass its ownership, lock, pin or retention checks. If unmanaged obsolete output remains, establish its ownership and confirm no process uses it before removing only the disposable files.
- Never remove active checkouts or unique work to meet a storage target. Check for uncommitted changes and preserve useful commits before removing an owned disposable worktree with its owning tool or `git worktree remove`.
- Before the final reply, check disk usage and Git status. Report the space reclaimed, the paths of large retained artifacts and why they remain. If cleanup is blocked, state the exact blocker instead of silently leaving the output.

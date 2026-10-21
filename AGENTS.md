# Notes for coding agents

Instructions for coding agents (Claude Code, Codex and similar) working in this repository. Read [CONTRIBUTING.md](CONTRIBUTING.md) first for setup and test commands. These rules also apply to people.

## Build output

Video builds and test runs produce large files. Reuse the standard locations and clean up what you create.

- Use `build/DerivedData` for the development app and `native/ReelKit/.build` for package tests. Reuse them across retries. Do not create dated or per-retry DerivedData folders.
- The release verifier (`native/scripts/verify-arya-local.py`) writes runs to `build/local-verification`. It prunes bulky artifacts from finished runs older than seven days and keeps the two newest runs. Preview with `--cleanup`, then apply with `--cleanup --apply`.
- A `.keep-artifacts` file in a verification run stops pruning. Write the reason and an expiry date in it, and delete it when you are done.
- Put one-off output in a temporary directory that a `finally` block or shell trap removes after its processes stop.
- Never copy builds, package caches, `node_modules` or browser profiles into source snapshots.

## Before you finish

- Stop any servers, browsers and helper processes you started.
- Remove disposable builds, copied dependencies, temporary browser profiles and experiments you created. Keep source, project files, media, backups, release installers and short logs.
- Remove disposable Git worktrees with `git worktree remove` after checking for uncommitted work. Keep the branch if it has useful commits.
- Check `git status` and the size of anything you leave behind, and say why it remains.

## Test media

Use generated clips (for example `ffmpeg -f lavfi -i testsrc2`) or the public-domain and Creative Commons media already in the repository. Never commit personal or client footage.

# Contributing to Arya

Thanks for helping. This guide covers setup, tests and what a pull request needs.

## Before you start

- Search [existing issues](https://github.com/rubix-labs-hq/arya/issues) first.
- For a larger change, open an issue to discuss it before writing code.
- Report security problems privately. See [SECURITY.md](SECURITY.md).
- Follow the [code of conduct](CODE_OF_CONDUCT.md).

## Setup

You need macOS 14 or newer, Node.js 22 or newer, ffmpeg and ffprobe, Google Chrome and the Xcode Command Line Tools. Native work needs Xcode 26.4.1 or newer. See the [README](README.md#prerequisites) for details.

From the repository root:

```bash
npm ci --prefix editor
npm run --prefix editor prepare:persistence
npm run --prefix editor check:persistence
```

Run the browser editor against a project folder:

```bash
node editor/server.mjs --root /path/to/your/project --port 4870
```

Build the native app with `native/Reel.xcodeproj` in Xcode, or run `./script/build_and_run.sh --verify`. Run `npm ci --prefix editor` first, because the build copies files from `editor/node_modules`. Use the `Reel` scheme for Mac and `Reel iOS` for iPhone and iPad.

## Tests

Run the checks that fit your change.

| Area | Command |
| --- | --- |
| Shared core, server and browser editor | `npm test --prefix editor` |
| Renderer output | `npm run --prefix editor renderer:regressions` and `npm run --prefix editor golden` |
| Media processing | `npm run --prefix editor processing:smoke` |
| Website | `npm test --prefix site` |
| Third-party notices | `node --test scripts/test-third-party-notices.mjs` and `node scripts/check-third-party-notices.mjs` |
| ReelKit (Swift) | `NODE="$(command -v node)" swift test --package-path native/ReelKit` |
| Release tooling | `python3 native/scripts/test-release.py` |
| Claude Code plugin | `claude plugin validate .` and `claude plugin test .` |

Focused native checks live in `native/scripts/` as `test-*.py` and `test-*.sh`. `python3 native/scripts/verify-arya-local.py --list` shows the phases of the full local verifier.

If you change the renderer on purpose, update golden frames with `npm run --prefix editor golden:update` and explain the change in the pull request. If you change shader equations in `editor/web/engine/compositor.js`, regenerate the Metal source with `node native/scripts/build-metal-shaders.mjs` and review the diff.

## Project rules

- New capabilities go into the project format and the shared operations in `editor/core/` first, with tests. UI comes after. See [docs/format.md](docs/format.md).
- The browser editor and the native app share one project format. A change to one backend should keep the other compatible.
- Keep the renderer deterministic: seeded noise and no wall-clock time.
- Keep compatibility identifiers. Arya was called Reel during development. Do not rename `reel.project.json`, the `/reel` command, `mcp__reel__*` tools, the `ReelKit` module, `native/Reel.xcodeproj`, bundle identifiers, Keychain service names or the `reelfigma` and `reelagent` callback schemes. Renaming them needs a tested migration.
- Never commit secrets, tokens, personal data or private media. Keep build output under the ignored `build/` folder.
- Third-party code, fonts and media need a compatible license and an entry in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Pull requests

- Keep each pull request focused on one change.
- Describe what changed and why. Link the related issue.
- List the tests you ran and their results.
- Include screenshots or a short recording for visible UI changes.
- Update the docs when behavior or the project format changes.

## License

Arya is released under the [MIT License](LICENSE). By submitting a contribution, you agree that it is licensed under the same MIT License (inbound equals outbound). Only submit work you have the right to license this way.

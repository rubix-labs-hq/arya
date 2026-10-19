# Security policy

## Supported versions

Security fixes go into the latest release. Please check that a problem still happens on the [latest release](https://github.com/rubix-labs-hq/arya/releases/latest) or the `main` branch before reporting it.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: [open a private vulnerability report](https://github.com/rubix-labs-hq/arya/security/advisories/new).

Include:

- The affected component, such as the Mac app, the browser editor, the local media server or the Claude Code plugin.
- The Arya version or commit, and your macOS or iOS version.
- Steps to reproduce, and a sample project if one helps. Remove private media first.
- What an attacker could do, and any conditions it needs.

## What to expect

Arya is maintained by a small team. We will try to acknowledge your report within a week and keep you updated in the advisory. We will credit you in the advisory unless you ask us not to.

## Scope

The local media server is designed to accept requests only from the same machine and the editor's own origin, and project expressions never run as JavaScript. The [security model](README.md#security-model) describes these boundaries. Reports that break them are in scope.

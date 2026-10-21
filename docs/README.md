# Arya documentation

Arya was called Reel during development. Some documents still use that name, and compatibility identifiers such as `reel.project.json` and `ReelKit` keep it.

## Using Arya

- [Install and first steps](https://arya-beta-delta.vercel.app/install/): download, project folders, permissions and assistant sign-in.
- [Your data](https://arya-beta-delta.vercel.app/privacy/): what stays on your device and what the optional connections send.
- [Figma account connection](figma-account-setup.md): import frames with your own access token.
- [Where each feature runs](../README.md#where-each-feature-runs): Mac app, local browser editor and hosted browser editor.

## Project format and architecture

- [Project format and backend API](format.md): the contract every backend implements.
- [Reusable creative components](creative-library.md): the project library of titles, effects, transitions and motion.
- [Native roadmap](native-roadmap.md): the path from the hybrid app to a full native Mac, iPad and iPhone editor.
- [Editor research](research.md): background research on Final Cut Pro, DaVinci Resolve and browser editors.

## Building and releasing

- [Native builds and distribution](native-release.md): clean-source setup, verification, archives and notarization.
- [Mac distribution and installation](arya-distribution.md): the DMG builder, install, update, rollback and uninstall.
- [UI and interaction QA](ui-qa.md): manual checks before a release.

## Assistant and integrations

- [Subscription agent bridge](subscription-agent-bridge.md): how the companion runs Claude Code, Codex and custom CLIs.
- [Assistant accounts and model routing](assistant-routing.md): provider status and model selection.
- [Figma account connection](figma-account-setup.md): the Figma sign-in broker and its setup.

## Design notes for contributors

- [Arya brand](design/arya-brand.md)
- [Product design system](design/arya-product-system.md)
- [Native editor parity](design/native-editor-parity.md)
- [Browser settings and panel access](design/browser-editor-settings.md)
- [Creative library and animation context](design/creative-library.md)

## Elsewhere in the repository

- [Website](../site/README.md)
- [Product images and footage credits](../site/assets/product/README.md)
- [Contributing](../CONTRIBUTING.md)
- [Third-party notices](../THIRD_PARTY_NOTICES.md)

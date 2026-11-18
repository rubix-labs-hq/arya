# Getting help

## Questions

Ask in [GitHub Discussions](https://github.com/rubix-labs-hq/arya/discussions).

## Bugs and feature requests

Use [GitHub Issues](https://github.com/rubix-labs-hq/arya/issues).

- Search existing issues first.
- For a bug, use the bug report form. Include your Arya version, your macOS or iOS version and the steps that cause the problem.
- For an idea, use the feature request form.

Do not post private media, account tokens or API keys in an issue.

## Export and render messages in the browser editor

The local browser editor renders exports, preview frames and mix measurements in a hidden copy of Google Chrome, the render worker. Arya checks it every 10 seconds. A worker that has stopped sending progress is closed, and the next export, frame or measurement starts a new one. You do not need to restart Arya. An export that waits behind another export, other processing or a starting worker needs nothing from you. It starts when its turn comes.

| Message starts with | What to do |
|---|---|
| "Arya could not start Google Chrome to render" | Install Google Chrome in Applications, then try again. |
| "The render worker did not start" | Try again. Arya starts a new worker, and after each worker that fails to start it gives the next one longer, up to 80 seconds. |
| "The render worker closed while…" | Export, render the frame or measure again. |
| "The render worker sent nothing for…" or "The render worker was still preparing…" | Export or measure again. A new worker starts, and an export starts again from the first frame. The message names the last step the worker reported, such as loading LUTs or rendering the audio mix. Include it if you report the problem. |
| "This frame waited 5 minutes behind other processing" | Wait for the running export to finish, then try again. |
| "The render worker did not finish this frame in 30 s" or "The preview renderer restarted" | Try again. |
| "Too many thumbnails are waiting" or "Thumbnails are waiting behind other processing" | Wait for the import or export to finish, then try again. |

## Security problems

Report them privately. See [SECURITY.md](SECURITY.md).

## Your data

The [data guide](https://editwitharya.app/privacy/) explains where Arya keeps projects and media, and what a connected assistant or a Figma import receives.

## Documentation

Start with the [README](README.md) and the [docs index](docs/README.md).

#!/bin/sh
# Copies the web editor into the app bundle, where the reel:// scheme serves it:
#
#   editor/web/          editor/web (index.html, main.js, host.js, engine/, ui/)  -> /
#   editor/core/         editor/core ES modules                                   -> /core/
#   editor/vendor/       preact, htm and mediabunny from editor/node_modules      -> /vendor/
#   editor/reel-core.js  editor/core bundled for JavaScriptCore (bundle-core.mjs)
#
# /ui/plugins-index.js is generated at request time from editor/web/ui/plugins, as the Node
# server does, so it always matches the bundled plugins.
#
# In an Xcode build phase it writes into the product's resources folder. By hand:
#   native/scripts/bundle-editor.sh <destination folder>
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
EDITOR="$REPO/editor"
NOTICES="$REPO/THIRD_PARTY_NOTICES.md"
if [ ! -f "$NOTICES" ] || [ -L "$NOTICES" ]; then
  echo "error: a reviewed regular THIRD_PARTY_NOTICES.md is required before bundling" >&2
  exit 1
fi
if [ $# -ge 1 ]; then
  DEST=$1
else
  DEST="${TARGET_BUILD_DIR:?run from Xcode or pass a destination}/${UNLOCALIZED_RESOURCES_FOLDER_PATH:?}/editor"
fi

# Xcode runs scripts with a minimal PATH; look for Node where installers put it.
NODE=${NODE:-}
if [ -z "$NODE" ]; then
  for candidate in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.local/bin/node" "$HOME/.volta/bin/node"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE=$candidate; break; fi
  done
fi
if [ -z "$NODE" ]; then
  echo "error: bundle-editor.sh needs Node.js 22+ to bundle editor/core (install it, or set NODE=/path/to/node)" >&2
  exit 1
fi

MODULES="$EDITOR/node_modules"
for f in preact/dist/preact.module.js preact/hooks/dist/hooks.module.js htm/dist/htm.module.js mediabunny/dist/bundles/mediabunny.min.mjs; do
  if [ ! -f "$MODULES/$f" ]; then
    echo "error: $MODULES/$f is missing: run 'npm ci --prefix editor' from the repository root" >&2
    exit 1
  fi
done

mkdir -p "$DEST/web" "$DEST/core" "$DEST/vendor"
cp "$NOTICES" "$DEST/THIRD_PARTY_NOTICES.md"
cp "$REPO/LICENSE" "$DEST/LICENSE"
rsync -a --delete --exclude '.DS_Store' "$EDITOR/web/" "$DEST/web/"
rsync -a --delete --delete-excluded --include '*.js' --include '*.mjs' --exclude '*' "$EDITOR/core/" "$DEST/core/"
if [ -d "$EDITOR/agent" ]; then
  mkdir -p "$DEST/agent"
  rsync -a --delete --exclude '.DS_Store' "$EDITOR/agent/" "$DEST/agent/"
fi

# Only the vendor files the editor imports (see the import map in index.html and engine/decoder.js).
rm -rf "$DEST/vendor"
for f in preact/dist/preact.module.js preact/hooks/dist/hooks.module.js preact/LICENSE \
         htm/dist/htm.module.js htm/LICENSE \
         mediabunny/dist/bundles/mediabunny.min.mjs mediabunny/LICENSE; do
  mkdir -p "$DEST/vendor/$(dirname "$f")"
  cp "$MODULES/$f" "$DEST/vendor/$f"
done

mkdir -p "$DEST/scripts"
cp "$EDITOR/scripts/prepare-project-writer.mjs" "$DEST/scripts/prepare-project-writer.mjs"
if [ "${PLATFORM_NAME:-${ARYA_BUNDLE_PLATFORM:-}}" = "macosx" ]; then
  # These are generated build-product files, never source or a user project.
  # Signing occurs after this phase; each rebuilt app gets a newly generated pin.
  rm -f "$DEST/core/project-writer.prepared.json" "$DEST/../../Helpers/project-writer"
  "$NODE" "$EDITOR/scripts/prepare-project-writer.mjs" prepare "$DEST/core" --native
fi
"$NODE" "$HERE/bundle-core.mjs" --out "$DEST/reel-core.js"
"$NODE" "$HERE/bundle-music.mjs" --out "$DEST/arya-music.js"
echo "bundled the editor into $DEST"

#!/bin/sh
# Xcode Cloud runs this after cloning, before it resolves packages or builds.
# The app build copies the web editor from editor/node_modules (see
# native/scripts/bundle-editor.sh), so install Node and the locked editor packages.
set -eu

REPO="${CI_PRIMARY_REPOSITORY_PATH:?run by Xcode Cloud}"

if ! command -v node >/dev/null 2>&1; then
  export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
  brew install node
fi
node --version

npm ci --prefix "$REPO/editor" --no-audit --no-fund

#!/bin/sh
# Xcode Cloud runs this after cloning, before it resolves packages or builds.
# The app build copies the web editor from editor/node_modules (see
# native/scripts/bundle-editor.sh), so install Node and the locked editor packages.
set -eu

REPO="${CI_PRIMARY_REPOSITORY_PATH:?run by Xcode Cloud}"

# A release tag must match the version it builds, so v1.4.1 cannot ship 1.4.0.
if [ -n "${CI_TAG:-}" ]; then
  VERSION=$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([0-9.]*\)"\{0,1\}.*/\1/p' "$REPO/native/project.yml" | head -1)
  [ -n "$VERSION" ] && [ "$CI_TAG" = "v$VERSION" ] || { echo "error: tag $CI_TAG does not match MARKETING_VERSION $VERSION in native/project.yml" >&2; exit 1; }
  echo "tag $CI_TAG matches version $VERSION"
fi

if ! command -v node >/dev/null 2>&1; then
  export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1
  brew install node
fi
node --version

npm ci --prefix "$REPO/editor" --no-audit --no-fund

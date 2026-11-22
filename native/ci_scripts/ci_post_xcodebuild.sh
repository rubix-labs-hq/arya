#!/bin/sh
# Xcode Cloud runs this after each xcodebuild action. For archives, check the
# App Store build with the same validator the manual release uses
# (docs/app-store-release.md) before it reaches TestFlight.
set -eu

[ "${CI_XCODEBUILD_ACTION:-}" = "archive" ] || exit 0
SIGNED="${CI_APP_STORE_SIGNED_APP_PATH:-}"
[ -n "$SIGNED" ] && [ -d "$SIGNED" ] || { echo "No App Store export to validate"; exit 0; }

REPO="${CI_PRIMARY_REPOSITORY_PATH:?run by Xcode Cloud}"
VERSION=$(sed -n 's/^ *MARKETING_VERSION: *"\{0,1\}\([0-9.]*\)"\{0,1\}.*/\1/p' "$REPO/native/project.yml" | head -1)

# iOS exports an .ipa, Mac Catalyst a .pkg.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
APP=$(find "$SIGNED" -maxdepth 3 -name '*.app' -type d | head -1)
IPA=$(find "$SIGNED" -maxdepth 2 -name '*.ipa' | head -1)
PKG=$(find "$SIGNED" -maxdepth 2 -name '*.pkg' | head -1)
if [ -z "$APP" ] && [ -n "$IPA" ]; then
  ditto -x -k "$IPA" "$WORK"
  APP=$(find "$WORK/Payload" -maxdepth 1 -name '*.app' -type d | head -1)
elif [ -z "$APP" ] && [ -n "$PKG" ]; then
  pkgutil --expand-full "$PKG" "$WORK/pkg"
  APP=$(find "$WORK/pkg" -maxdepth 4 -name '*.app' -type d | head -1)
fi
[ -n "$APP" ] || { echo "error: no .app, .ipa or .pkg in $SIGNED" >&2; ls -la "$SIGNED" >&2; exit 1; }

python3 "$REPO/native/scripts/validate-app-store.py" "$APP" --version "$VERSION"
echo "validated $APP for App Store version $VERSION"

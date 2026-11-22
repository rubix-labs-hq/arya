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

APP=$(find "$SIGNED" -maxdepth 3 -name '*.app' -type d | head -1)
if [ -z "$APP" ]; then
  IPA=$(find "$SIGNED" -maxdepth 2 -name '*.ipa' | head -1)
  [ -n "$IPA" ] || { echo "error: no .app or .ipa in $SIGNED" >&2; exit 1; }
  WORK=$(mktemp -d)
  trap 'rm -rf "$WORK"' EXIT
  ditto -x -k "$IPA" "$WORK"
  APP=$(find "$WORK/Payload" -maxdepth 1 -name '*.app' -type d | head -1)
fi

python3 "$REPO/native/scripts/validate-app-store.py" "$APP" --version "$VERSION"
echo "validated $APP for App Store version $VERSION"

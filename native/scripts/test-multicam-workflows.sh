#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NATIVE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/reel-multicam-workflows.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
printf 'import Foundation\nimport CryptoKit\n' > "$TEST_DIR/helpers.swift"
awk '/^\/\/ BEGIN MULTICAM PLANNING/ { copy = 1; next } /^\/\/ END MULTICAM PLANNING/ { copy = 0 } copy' "$NATIVE_DIR/App/Shared/NativeEditor/NativeMulticamPanel.swift" >> "$TEST_DIR/helpers.swift"
cp "$SCRIPT_DIR/multicam-workflow-tests.swift" "$TEST_DIR/main.swift"
node "$SCRIPT_DIR/bundle-core.mjs" --out "$TEST_DIR/reel-core.js"
swiftc -module-cache-path "$TEST_DIR/module-cache" "$TEST_DIR/helpers.swift" "$NATIVE_DIR/ReelKit/Sources/ReelKit/JSON.swift" "$NATIVE_DIR/ReelKit/Sources/ReelKit/ReelCore.swift" "$TEST_DIR/main.swift" -o "$TEST_DIR/tests"
"$TEST_DIR/tests" "$TEST_DIR/reel-core.js"
python3 "$SCRIPT_DIR/test-multicam-commit.py" "$TEST_DIR/reel-core.js"

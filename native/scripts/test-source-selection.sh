#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NATIVE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/reel-source-selection.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
printf 'import Foundation\nimport Darwin\n' > "$TEST_DIR/helpers.swift"
awk '/^struct NativeEditorSelection:/ { copy = 1 } copy { print } copy && /^\}$/ { copy = 0 }' "$NATIVE_DIR/App/Shared/NativeEditor/NativeEditorModel.swift" >> "$TEST_DIR/helpers.swift"
awk '/^struct NativeSourceRange:/ { copy = 1 } copy { print } copy && /^\}$/ { copy = 0 }' "$NATIVE_DIR/App/Shared/NativeEditor/NativeEditorModel.swift" >> "$TEST_DIR/helpers.swift"
awk '/^struct NativeSourceFileIdentity:/ { copy = 1 } copy { print } copy && /^\}$/ { copy = 0 }' "$NATIVE_DIR/App/Shared/NativeEditor/NativeEditorModel.swift" >> "$TEST_DIR/helpers.swift"
cp "$SCRIPT_DIR/source-selection-tests.swift" "$TEST_DIR/main.swift"
swiftc -module-cache-path "$TEST_DIR/module-cache" "$TEST_DIR/helpers.swift" "$TEST_DIR/main.swift" -o "$TEST_DIR/check"
"$TEST_DIR/check" "$TEST_DIR/operations.json"
node "$SCRIPT_DIR/source-placement-check.mjs" "$TEST_DIR/operations.json"

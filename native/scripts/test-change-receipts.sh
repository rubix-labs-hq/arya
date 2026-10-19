#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NATIVE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/reel-change-receipts.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT HUP INT TERM
printf 'import Foundation\nimport CoreFoundation\n' > "$TEST_DIR/NativeChangeReceipt.swift"
awk '/^struct NativeChangeReceipt: Identifiable/ { copy = 1 } copy' \
    "$NATIVE_DIR/App/Shared/NativeEditor/NativeProject.swift" >> "$TEST_DIR/NativeChangeReceipt.swift"
cp "$SCRIPT_DIR/change-receipt-tests.swift" "$TEST_DIR/main.swift"
swiftc -module-cache-path "$TEST_DIR/module-cache" "$TEST_DIR/NativeChangeReceipt.swift" \
    "$TEST_DIR/main.swift" -o "$TEST_DIR/change-receipt-tests"
"$TEST_DIR/change-receipt-tests"

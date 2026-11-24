#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC="$ROOT/test.x"
OUT_DIR="$(cd "$ROOT/.." && pwd)/dylib"
OUT="$OUT_DIR/AdBlockConfig.dylib"
MIN_IOS="${IPHONEOS_DEPLOYMENT_TARGET:-14.0}"

mkdir -p "$OUT_DIR"

copy_theos_dylib() {
  local found=""
  found="$(find "$ROOT/.theos/obj" -name 'AdBlockConfig.dylib' -type f 2>/dev/null | head -n 1 || true)"
  if [[ -n "$found" ]]; then
    cp -f "$found" "$OUT"
    echo "Built with Theos: $OUT"
    ls -lh "$OUT"
    return 0
  fi
  return 1
}

if [[ -n "${THEOS:-}" && -f "${THEOS}/makefiles/common.mk" ]]; then
  make -C "$ROOT" clean || true
  make -C "$ROOT"
  if copy_theos_dylib; then
    exit 0
  fi
  echo "Theos finished, but AdBlockConfig.dylib was not found under .theos/obj"
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "Need macOS + Xcode (xcrun) or a Theos environment (THEOS)." >&2
  exit 1
fi

SDK="$(xcrun --sdk iphoneos --show-sdk-path)"
CLANG="$(xcrun --sdk iphoneos --find clang)"
TMPDIR_BUILD="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_BUILD"' EXIT

build_arch() {
  local arch="$1"
  local dest="$2"
  "$CLANG" \
    -x objective-c \
    -isysroot "$SDK" \
    -arch "$arch" \
    -miphoneos-version-min="$MIN_IOS" \
    -fobjc-arc \
    -fPIC \
    -dynamiclib \
    -install_name /Library/MobileSubstrate/DynamicLibraries/AdBlockConfig.dylib \
    -framework Foundation \
    -framework UIKit \
    -framework WebKit \
    -o "$dest" \
    "$SRC"
}

ARM64="$TMPDIR_BUILD/AdBlockConfig.arm64.dylib"
ARM64E="$TMPDIR_BUILD/AdBlockConfig.arm64e.dylib"

build_arch arm64 "$ARM64"

if build_arch arm64e "$ARM64E"; then
  xcrun lipo -create "$ARM64" "$ARM64E" -output "$OUT"
else
  echo "arm64e build skipped, using arm64 only"
  cp -f "$ARM64" "$OUT"
fi

if command -v ldid >/dev/null 2>&1; then
  ldid -S "$OUT"
elif command -v codesign >/dev/null 2>&1; then
  codesign --force --sign - "$OUT" >/dev/null 2>&1 || true
fi

echo "Built with clang: $OUT"
ls -lh "$OUT"
xcrun lipo -info "$OUT" || true

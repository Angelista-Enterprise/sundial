#!/bin/zsh
# Build the Phase 0 Sundial.app (docs/release/06-mac-app-plan.md) from this checkout.
#
#   zsh apps/macos/build.sh [out-dir]          app only; helpers off unless copied
#   WITH_HELPERS=1 zsh apps/macos/build.sh     also copy the helpers from $SUNDIAL_HOME/Sundial.app
#   BUNDLE_ID=dev.sundial.apptest APP_NAME="Sundial Test" DSH_REPO=~/Projects/sundial ...
#       a test identity with its own TCC rows (the live grants stay untouched),
#       running dsh from another checkout
#
# The app runs dsh from DSH_REPO (default: this checkout) with the Node on PATH,
# both written into Resources. Ad-hoc signed; every binary gets BUNDLE_ID as its
# identifier, like the helpers. Output defaults to apps/macos/build/.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="${1:-$REPO/apps/macos/build}"
BUNDLE_ID="${BUNDLE_ID:-dev.sundial.daemon}"
APP_NAME="${APP_NAME:-Sundial}"
DSH_REPO="${DSH_REPO:-$REPO}"
APP="$OUT/$APP_NAME.app"
NODE_BIN="${SUNDIAL_NODE:-$(command -v node)}"
SUNDIAL_HOME="${SUNDIAL_HOME:-$HOME/.sundial}"
case "$APP" in "$SUNDIAL_HOME"/*) echo "refusing to build into the data folder $SUNDIAL_HOME" >&2; exit 1 ;; esac

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -o "$APP/Contents/MacOS/Sundial" "$REPO/apps/macos/Sundial.swift" -framework AppKit -framework WebKit -framework ServiceManagement
printf '%s\n' "$DSH_REPO" > "$APP/Contents/Resources/repo-path"
printf '%s\n' "$NODE_BIN" > "$APP/Contents/Resources/node-path"

# The live bundle's plist (usage strings and all), with this app as the executable.
PLIST="$APP/Contents/Info.plist"
sed -n "/^NEW_PLIST='/,/^<\/plist>'/p" "$REPO/apps/daemon/scripts/app.sh" \
  | sed -e "1s/^NEW_PLIST='//" -e "\$s/'\$//" -e "s/'\"\$BUNDLE_ID\"'/x/" > "$PLIST"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"
plutil -replace CFBundleExecutable -string Sundial "$PLIST"
plutil -replace CFBundleName -string "$APP_NAME" "$PLIST"
plutil -lint "$PLIST" >/dev/null

if [ "${WITH_HELPERS:-0}" = "1" ]; then
  cp "$SUNDIAL_HOME"/Sundial.app/Contents/MacOS/sundial-* "$APP/Contents/MacOS/"
fi

for BIN in "$APP"/Contents/MacOS/*; do
  codesign --sign - --force --identifier "$BUNDLE_ID" "$BIN"
done
codesign --sign - --force "$APP"
echo "Built $APP"

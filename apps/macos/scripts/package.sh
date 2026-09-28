#!/bin/zsh
# Build a self-contained Sundial.app (docs/release/06-mac-app-plan.md, Phase 3):
# the built Node side, a pinned Node and the Swift helpers, all inside the
# bundle. The app runs them when no app.env names a checkout.
#
#   zsh apps/macos/scripts/package.sh [out-dir]       default apps/macos/build/
#   BUNDLE_ID=dev.sundial.apptest APP_NAME="Sundial Test" zsh apps/macos/scripts/package.sh ~/Applications
#       a test identity with its own TCC rows (the live grants stay untouched)
#   SUNDIAL_NODE=/path/to/node   the Node to ship; it must be NODE_VERSION
#   SUNDIAL_FEED_URL=https://…/appcast.xml  SUNDIAL_ED_PUBLIC_KEY=<base64>
#       turn updates on (Phase 4, Sparkle); without a feed the app never checks
#   SUNDIAL_BUILD=<n>            CFBundleVersion, what Sparkle compares (default: commit count)
#
#   Contents/MacOS/      Sundial, sundial-daemon, the helpers
#   Contents/Frameworks/ Sparkle.framework (fetched once, checked by SHA-256)
#   Contents/Helpers/    SundialBrowserHelper.app: an app of its own, because
#                        macOS raises the Automation prompt only for an app
#   Contents/Resources/  node, and app/: a checkout's shape, so bin/sundial runs
#                        unchanged from it (`prepare` writes the dsh profile)
#     app/apps/harness/  `pnpm deploy --prod`: dsh and every plugin with its deps
#     app/plugins/*      links into app/apps/harness/node_modules
#
# Native addons ship as pnpm installed them: this Mac's architecture only (v0).
# Ad-hoc signed; every Mach-O in MacOS/ gets BUNDLE_ID as its identifier.
set -euo pipefail
REPO=${0:A:h:h:h:h}
OUT=${1:-$REPO/apps/macos/build}
BUNDLE_ID=${BUNDLE_ID:-dev.sundial.daemon}
APP_NAME=${APP_NAME:-Sundial}
NODE_VERSION=24.19.0
SPARKLE_VERSION=2.10.0
SPARKLE_SHA256=c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c
SPARKLE=$HOME/Library/Caches/sundial-build/Sparkle-$SPARKLE_VERSION
NODE_BIN=${SUNDIAL_NODE:-$(command -v node)}
APP="$OUT/$APP_NAME.app"
RES="$APP/Contents/Resources"
SUNDIAL_HOME=${SUNDIAL_HOME:-$HOME/.sundial}
case "$APP" in "$SUNDIAL_HOME"/*) echo "refusing to build into the data folder $SUNDIAL_HOME" >&2; exit 1 ;; esac
[ "$("$NODE_BIN" --version)" = "v$NODE_VERSION" ] || { echo "ship Node v$NODE_VERSION: set SUNDIAL_NODE (found $("$NODE_BIN" --version) at $NODE_BIN)" >&2; exit 1; }

cd "$REPO"
if [ ! -d "$SPARKLE/Sparkle.framework" ]; then
  mkdir -p "$SPARKLE"
  curl -fsSL -o "$SPARKLE.tar.xz" "https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz"
  [ "$(shasum -a 256 "$SPARKLE.tar.xz" | cut -d' ' -f1)" = "$SPARKLE_SHA256" ] || { echo "Sparkle download does not match its SHA-256" >&2; rm -rf "$SPARKLE" "$SPARKLE.tar.xz"; exit 1; }
  tar -xJf "$SPARKLE.tar.xz" -C "$SPARKLE"
fi
npx tsc -b tsconfig.json
bash apps/daemon/scripts/swift.sh
DIST=apps/daemon/dist/daemon

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks" "$RES/app/bin" "$RES/app/plugins" "$RES/app/packages/sensors"
cp "$DIST"/sundial-daemon "$DIST"/sundial-*-helper "$APP/Contents/MacOS/"
# The app itself, with Sparkle: swift.sh's copy (for a checkout) has none.
swiftc -O -o "$APP/Contents/MacOS/Sundial" apps/macos/Sundial.swift -F "$SPARKLE" -framework Sparkle \
  -framework AppKit -framework WebKit -framework ServiceManagement -Xlinker -rpath -Xlinker @executable_path/../Frameworks
ditto "$SPARKLE/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
# The browser helper is an app of its own (see app.sh), nested here with its
# own identity; a test build gets its own, so it never shares Automation rows.
rm -f "$APP/Contents/MacOS/sundial-browser-helper"
BH_ID=dev.sundial.browser-helper
[ "$BUNDLE_ID" = dev.sundial.daemon ] || BH_ID="$BUNDLE_ID.browser-helper"
BH="$APP/Contents/Helpers/SundialBrowserHelper.app"
mkdir -p "$BH/Contents/MacOS"
cp "$DIST/sundial-browser-helper" "$BH/Contents/MacOS/"
sed -n "/^  BH_NEW_PLIST='/,/^<\/plist>'/p" apps/daemon/scripts/app.sh \
  | sed -e "1s/^  BH_NEW_PLIST='//" -e "\$s/'\$//" -e "s/'\"\$BH_ID\"'/x/" > "$BH/Contents/Info.plist"
plutil -replace CFBundleIdentifier -string "$BH_ID" "$BH/Contents/Info.plist"
plutil -lint "$BH/Contents/Info.plist" >/dev/null

pnpm --filter @sundial/harness deploy --prod --legacy "$RES/app/apps/harness" >/dev/null
# pnpm links the deployed package back to its checkout; codesign refuses a link out of the bundle.
rm "$RES/app/apps/harness/node_modules/.pnpm/node_modules/@sundial/harness"
# The plugins import each other by relative path (../sundial-web-browser/…), so
# each one moves to app/plugins/ as in a checkout, with its pnpm dependency
# folder linked in as its node_modules and a link left where pnpm put it.
for DIR in plugins/sundial-*; do
  PKG=$(node -p "require('./$DIR/package.json').name")
  STORE=$(cd "$RES/app/apps/harness/node_modules/$PKG" && pwd -P)   # …/.pnpm/<entry>/node_modules/@sundial/<name>
  ENTRY=${${STORE%/node_modules/*}:t}
  mv "$STORE" "$RES/app/plugins/${DIR:t}"
  ln -s "../../../../../../../plugins/${DIR:t}" "$STORE"
  ln -s "../../apps/harness/node_modules/.pnpm/$ENTRY/node_modules" "$RES/app/plugins/${DIR:t}/node_modules"
done
cp bin/sundial "$RES/app/bin/"
cp env.example "$RES/app/"
cp packages/sensors/shell-hook.zsh "$RES/app/packages/sensors/"
cp "$NODE_BIN" "$RES/node"

# The live bundle's plist (usage strings and all), as build.sh takes it.
PLIST="$APP/Contents/Info.plist"
sed -n "/^NEW_PLIST='/,/^<\/plist>'/p" apps/daemon/scripts/app.sh \
  | sed -e "1s/^NEW_PLIST='//" -e "\$s/'\$//" -e "s/'\"\$BUNDLE_ID\"'/x/" > "$PLIST"
plutil -replace CFBundleIdentifier -string "$BUNDLE_ID" "$PLIST"
plutil -replace CFBundleName -string "$APP_NAME" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$(node -p "require('./package.json').version")" "$PLIST"
plutil -replace CFBundleVersion -string "${SUNDIAL_BUILD:-$(git rev-list --count HEAD)}" "$PLIST"
if [ -n "${SUNDIAL_FEED_URL:-}" ]; then
  plutil -replace SUFeedURL -string "$SUNDIAL_FEED_URL" "$PLIST"
  plutil -replace SUPublicEDKey -string "${SUNDIAL_ED_PUBLIC_KEY:?an update feed needs SUNDIAL_ED_PUBLIC_KEY}" "$PLIST"
  # Check daily and download in the background; the app installs once Node is up.
  plutil -replace SUEnableAutomaticChecks -bool true "$PLIST"
  plutil -replace SUAutomaticallyUpdate -bool true "$PLIST"
fi
plutil -lint "$PLIST" >/dev/null

xattr -cr "$APP"
# Inside out: the nested app is sealed before the bundle that holds it.
codesign --sign - --force --identifier "$BH_ID" "$BH/Contents/MacOS/sundial-browser-helper" 2>/dev/null
codesign --sign - --force --identifier "$BH_ID" "$BH" 2>/dev/null
for BIN in "$APP"/Contents/MacOS/*; do
  codesign --sign - --force --identifier "$BUNDLE_ID" "$BIN" 2>/dev/null
done
codesign --sign - --force "$APP"
codesign --verify --strict "$APP"
echo "Built $APP ($(du -sh "$APP" | cut -f1))"

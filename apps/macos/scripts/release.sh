#!/bin/zsh
# Turn a built Sundial.app into an update (docs/release/06-mac-app-plan.md, Phase 4):
# a zip, its EdDSA signature, and an appcast.xml that lists it. Nothing is
# uploaded; the folder is what goes to the feed host.
#
#   zsh apps/macos/scripts/release.sh <app> <feed-dir> <download-url-prefix>
#   SUNDIAL_ED_KEY_FILE=<file>   the private key (default: Sparkle's key in the login Keychain)
#
# Put "what's new" for version N next to it as <feed-dir>/<zip name>.html: Sparkle
# embeds it in the appcast, and the app shows it after the update.
# Older zips left in <feed-dir> stay listed, and generate_appcast makes deltas from them.
set -euo pipefail
APP=${1:?the built .app}
FEED=${2:?the feed folder}
PREFIX=${3:?the URL the zips are downloaded from}
SPARKLE=$HOME/Library/Caches/sundial-build/Sparkle-2.10.0   # package.sh fetches it
VERSION=$(plutil -extract CFBundleVersion raw "$APP/Contents/Info.plist")
mkdir -p "$FEED"
ZIP="$FEED/${APP:t:r}-$VERSION.zip"
# ditto keeps the symlinks and the signature intact; plain zip does not.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
KEY=()
[ -n "${SUNDIAL_ED_KEY_FILE:-}" ] && KEY=(--ed-key-file "$SUNDIAL_ED_KEY_FILE")
"$SPARKLE/bin/generate_appcast" "${KEY[@]}" --embed-release-notes --download-url-prefix "$PREFIX" "$FEED"
echo "Wrote $ZIP and $FEED/appcast.xml"

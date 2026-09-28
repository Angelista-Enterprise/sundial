#!/bin/bash
# Create the macOS .app bundle during build.
# This pre-stages the bundle so `sundial install` only needs to update paths.
# Called as part of `npm run build` on macOS.
#
# Wave 3b adds calendar/input/notification helpers (see scripts/swift.sh).

set -e
# The bundle and everything staged next to it are private to this user.
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DIST_DIR="$PROJECT_ROOT/apps/daemon/dist/daemon"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[build-bundle] Skipping .app bundle (not macOS)"
  exit 0
fi

# The real install keeps the app in /Applications (SUNDIAL_APP_PATH, from bin/sundial); a test install in its data folder.
APP_DIR="${SUNDIAL_APP_PATH:-${SUNDIAL_HOME:-$HOME/.sundial}/Sundial.app}"
CONTENTS_DIR="$APP_DIR/Contents"
MACOS_DIR="$CONTENTS_DIR/MacOS"
HELPER_SRC="$DIST_DIR/sundial-window-helper"
# A test install passes its own id, so it never shares TCC rows or a login item with the real one.
BUNDLE_ID="${SUNDIAL_BUNDLE_ID:-dev.sundial.daemon}"

mkdir -p "$MACOS_DIR"

# --- Info.plist ---
#
# Written HERE, not only by `sundial install`'s ensureAppBundle(). Under dsh the
# legacy CLI start path never runs, so a bundle staged by this script alone kept
# whatever plist happened to be on disk from an older build — which is how the
# notification work first shipped into a bundle still marked LSBackgroundOnly and
# silently could not present a banner.
#
# LSUIElement WITHOUT LSBackgroundOnly is deliberate and load-bearing: an agent
# app with no Dock icon can post UNUserNotificationCenter banners, and a
# background-only one cannot reliably authorize or present them at all.
PLIST_PATH="$CONTENTS_DIR/Info.plist"
NEW_PLIST='<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>Sundial</string>
  <key>CFBundleIdentifier</key>
  <string>'"$BUNDLE_ID"'</string>
  <key>CFBundleName</key>
  <string>Sundial</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Sundial listens so it can keep a transcript of what is said around you, as context for what you were doing. Speech is transcribed on this Mac by a local model; the audio itself is never written to disk and never leaves the machine.</string>
  <key>NSAudioCaptureUsageDescription</key>
  <string>During a call, Sundial transcribes what the other people say, so the transcript has both sides. Only while hearing is on; transcribed on this Mac by a local model; the audio itself is never written to disk and never leaves the machine.</string>
  <key>NSCalendarsUsageDescription</key>
  <string>Sundial reads your calendar to know when you are in a meeting, and writes an event only when you approve one.</string>
  <key>NSContactsUsageDescription</key>
  <string>Sundial reads contact names so the people in your calendar appear by name instead of as an anonymous id.</string>
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>Sundial reads your calendar to know when you are in a meeting, and writes an event only when you approve one.</string>
</dict>
</plist>'

# Only rewrite on a real change: the plist is inside the signed bundle, so an
# unconditional write would invalidate the signature — and with it every
# cdhash-anchored TCC grant — on every single build.
if [ ! -f "$PLIST_PATH" ] || [ "$(cat "$PLIST_PATH")" != "$NEW_PLIST" ]; then
  printf '%s\n' "$NEW_PLIST" > "$PLIST_PATH"
  echo "[build-bundle] Wrote Info.plist"
  xattr -cr "$APP_DIR"
  # The executable is staged below; until it is there the bundle cannot be signed,
  # and staging signs it anyway.
  if [ -f "$MACOS_DIR/Sundial" ]; then
    codesign --sign - --force "$APP_DIR"
    echo "[build-bundle] Re-signed bundle after plist change (re-grant TCC permissions)"
  fi
fi

# Whether a staged binary is behind its freshly built source.
#
# NEITHER mtime NOR a direct byte compare works here:
#  - mtime lies. Rewriting Info.plist re-signs the whole bundle, which rewrites
#    every binary inside it, so a staged copy can be NEWER than the build that
#    should replace it. Measured: a launcher that had just gained the audio
#    sidecar never reached the bundle and the running one was six days old.
#  - `cmp` always differs, because staging SIGNS the copy. It would restage on
#    every build, and every restage changes the cdhash and voids the TCC grants
#    anchored to it — the one thing this script must not do casually.
# So the stamp records a hash of the SOURCE, which signing never touches.
# Stamps live OUTSIDE the bundle. A file inside Contents/MacOS that is not
# code makes the whole bundle unsignable ("code object is not signed at all"),
# which `|| true` on codesign used to hide.
STAMP_DIR="${SUNDIAL_HOME:-$HOME/.sundial}/.daemon/stage-stamps"
mkdir -p "$STAMP_DIR"
rm -f "$MACOS_DIR"/.*.src-sha 2>/dev/null

stage_needed() {
  local src="$1" dst="$2" stamp="$3"
  [ -f "$dst" ] || return 0
  [ -f "$stamp" ] || return 0
  [ "$(shasum -a 256 "$src" | cut -d" " -f1)" != "$(cat "$stamp")" ]
}

stage_stamp() {
  shasum -a 256 "$1" | cut -d" " -f1 > "$2"
}

LAUNCHER_SRC="$DIST_DIR/sundial-daemon"
if [ -f "$LAUNCHER_SRC" ]; then
  LAUNCHER_DST="$MACOS_DIR/sundial-daemon"
  # CONTENT, not mtime. A freshly built launcher can be OLDER than the copy in
  # the bundle: rewriting Info.plist re-signs the whole bundle, and that rewrites
  # every binary inside it — so `-nt` says "up to date" about a staged launcher
  # the signature bumped seconds after the build wrote the new one. Measured: a
  # launcher that had gained the audio sidecar never reached the bundle, and the
  # running one was six days old.
  if stage_needed "$LAUNCHER_SRC" "$LAUNCHER_DST" "$STAMP_DIR/.sundial-daemon.src-sha"; then
    cp "$LAUNCHER_SRC" "$LAUNCHER_DST"
    chmod 755 "$LAUNCHER_DST"
    stage_stamp "$LAUNCHER_SRC" "$STAMP_DIR/.sundial-daemon.src-sha"
    echo "[build-bundle] Copied daemon launcher to $LAUNCHER_DST"
    xattr -cr "$APP_DIR"
    codesign --sign - --force --identifier "$BUNDLE_ID" "$LAUNCHER_DST"
    codesign --sign - --force "$APP_DIR"
    echo "[build-bundle] Signed daemon launcher"
  fi
else
  echo "[build-bundle] No daemon launcher found at $LAUNCHER_SRC (run build-swift first)"
fi

if [ -f "$HELPER_SRC" ]; then
  HELPER_DST="$MACOS_DIR/sundial-window-helper"
  if stage_needed "$HELPER_SRC" "$HELPER_DST" "$STAMP_DIR/.sundial-window-helper.src-sha"; then
    cp "$HELPER_SRC" "$HELPER_DST"
    chmod 755 "$HELPER_DST"
    stage_stamp "$HELPER_SRC" "$STAMP_DIR/.sundial-window-helper.src-sha"
    echo "[build-bundle] Copied helper to $HELPER_DST"
    xattr -cr "$APP_DIR"
    codesign --sign - --force --identifier "$BUNDLE_ID" "$HELPER_DST"
    codesign --sign - --force "$APP_DIR"
    echo "[build-bundle] Signed .app bundle"
  fi
else
  echo "[build-bundle] No helper binary found at $HELPER_SRC (run build-swift first)"
fi

# --- Calendar / input / notification helpers (Wave 3b) ---
for NAME in Sundial sundial-calendar-helper sundial-input-helper sundial-notification-helper sundial-screen-ocr-helper sundial-audio-helper; do
  SRC="$DIST_DIR/$NAME"
  if [ -f "$SRC" ]; then
    DST="$MACOS_DIR/$NAME"
    if stage_needed "$SRC" "$DST" "$STAMP_DIR/.$NAME.src-sha"; then
      cp "$SRC" "$DST"
      chmod 755 "$DST"
      stage_stamp "$SRC" "$STAMP_DIR/.$NAME.src-sha"
      echo "[build-bundle] Copied $NAME to $DST"
      xattr -cr "$APP_DIR"
      codesign --sign - --force --identifier "$BUNDLE_ID" "$DST"
      codesign --sign - --force "$APP_DIR"
      echo "[build-bundle] Signed $NAME"
    fi
  fi
done


# --- Browser helper: its OWN app bundle ---
#
# Apple Events (Automation) is the one TCC service that never prompted for a
# bare Mach-O, however its usage string was embedded — measured 2026-09-04: the
# disclaimed helper got -1743 with no dialog, three times, after a tccutil
# reset. tccd only raises the Automation prompt for a requester it can show as
# an app. So the browser helper lives in a minimal bundle of its own, with its
# own identifier, outside Sundial.app so re-signing it never touches the
# grants anchored on the main bundle's helpers.
BROWSER_SRC="$DIST_DIR/sundial-browser-helper"
if [ -f "$BROWSER_SRC" ]; then
  BH_APP="${SUNDIAL_HOME:-$HOME/.sundial}/SundialBrowserHelper.app"
  BH_MACOS="$BH_APP/Contents/MacOS"
  BH_ID="dev.sundial.browser-helper"
  mkdir -p "$BH_MACOS"
  BH_PLIST="$BH_APP/Contents/Info.plist"
  BH_NEW_PLIST='<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>sundial-browser-helper</string>
  <key>CFBundleIdentifier</key>
  <string>'"$BH_ID"'</string>
  <key>CFBundleName</key>
  <string>Sundial Browser Helper</string>
  <key>CFBundleDisplayName</key>
  <string>Sundial Browser Helper</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Sundial asks your browser which page is open, so it knows what you are reading. It keeps only the site and path — never a query string, never a private window.</string>
</dict>
</plist>'
  CHANGED=0
  if [ ! -f "$BH_PLIST" ] || [ "$(cat "$BH_PLIST")" != "$BH_NEW_PLIST" ]; then
    printf '%s\n' "$BH_NEW_PLIST" > "$BH_PLIST"
    CHANGED=1
  fi
  BH_DST="$BH_MACOS/sundial-browser-helper"
  if [ ! -f "$BH_DST" ] || [ "$BROWSER_SRC" -nt "$BH_DST" ]; then
    cp "$BROWSER_SRC" "$BH_DST"
    chmod 755 "$BH_DST"
    CHANGED=1
  fi
  if [ "$CHANGED" = "1" ]; then
    xattr -cr "$BH_APP"
    codesign --sign - --force --identifier "$BH_ID" "$BH_DST"
    codesign --sign - --force --identifier "$BH_ID" "$BH_APP"
    echo "[build-bundle] Staged and signed $BH_APP (re-grant Automation if it was granted before)"
  fi
fi

echo "[build-bundle] App Bundle: $APP_DIR"

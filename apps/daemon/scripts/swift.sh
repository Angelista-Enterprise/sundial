#!/bin/bash
# Compile the macOS Swift helper binaries + daemon-launcher.
# Called by `sundial install` and `pnpm run sidecars:build`.
#
# Wave 3b adds calendar/input/notification helpers and extends the launcher
# to also compile FocusModeCapture.swift (co-located in macos-window-helper/,
# matching WCS's own layout — it's compiled into both the window-helper
# binary via the wildcard below, unused there, and the launcher explicitly;
# same harmless duplication WCS already has, not introduced here).

set -e
# The bundle and everything staged next to it are private to this user.
umask 077

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DAEMON_DIR="$PROJECT_ROOT/apps/daemon/src/daemon"
SWIFT_DIR="$DAEMON_DIR/macos-window-helper"
LAUNCHER_DIR="$DAEMON_DIR/macos-daemon-launcher"
OUT_DIR="$PROJECT_ROOT/apps/daemon/dist/daemon"
OUT_BIN="$OUT_DIR/sundial-window-helper"
LAUNCHER_OUT="$OUT_DIR/sundial-daemon"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "[build-swift] Skipping Swift compilation (not macOS)"
  exit 0
fi

mkdir -p "$OUT_DIR"

window_helper_needs_build() {
  if [ ! -f "$OUT_BIN" ]; then
    return 0
  fi
  for src in "$SWIFT_DIR"/*.swift; do
    if [ "$src" -nt "$OUT_BIN" ]; then
      return 0
    fi
  done
  return 1
}

if window_helper_needs_build; then
  echo "[build-swift] Compiling macos-window-helper/*.swift..."
  swiftc -O -o "$OUT_BIN" "$SWIFT_DIR"/*.swift \
    -framework AppKit \
    -framework ApplicationServices
  echo "[build-swift] Built: $OUT_BIN"
else
  echo "[build-swift] Up to date: $OUT_BIN"
fi

# --- Calendar helper (on-demand CLI, not a persistent sidecar) ---
CAL_SRC="$DAEMON_DIR/macos-calendar-helper.swift"
CAL_OUT="$OUT_DIR/sundial-calendar-helper"

if [ ! -f "$CAL_OUT" ] || [ "$CAL_SRC" -nt "$CAL_OUT" ]; then
  echo "[build-swift] Compiling macos-calendar-helper.swift..."
  # The helper is a BARE Mach-O, not a bundle, so `Info.plist=not bound`: TCC
  # finds no usage string and denies EventKit outright — the consent prompt
  # either never appears or is attributed to whatever spawned it, and accepting
  # it grants the wrong process. Embedding the plist as a __TEXT,__info_plist
  # section is how a non-bundled binary carries its own usage strings, and is
  # what makes the prompt name Gnomon and the grant stick to this helper.
  CAL_PLIST="$(mktemp -t sundial-cal-plist).plist"
  cat > "$CAL_PLIST" <<'CALPLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.sundial.daemon</string>
  <key>CFBundleName</key>
  <string>Sundial</string>
  <key>NSCalendarsUsageDescription</key>
  <string>Sundial reads your calendar to know when you are in a meeting, and writes an event only when you approve one.</string>
  <key>NSCalendarsFullAccessUsageDescription</key>
  <string>Sundial reads your calendar to know when you are in a meeting, and writes an event only when you approve one.</string>
  <!-- EventKit hands some attendees over with no name at all (Google invitees,
       chiefly), even though Calendar.app shows their names by looking them up
       in Contacts. Without this grant those attendees reach the log as bare
       addresses, get hashed to `person-<hash>`, and the record cannot say who
       the owner met. Read-only, and only to put a name to someone already in
       the owner's own calendar. -->
  <key>NSContactsUsageDescription</key>
  <string>Sundial reads contact names so the people in your calendar appear by name instead of as an anonymous id.</string>
</dict>
</plist>
CALPLIST
  swiftc -O -o "$CAL_OUT" "$CAL_SRC" -framework EventKit -framework Contacts -framework Foundation \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$CAL_PLIST"
  rm -f "$CAL_PLIST"
  echo "[build-swift] Built: $CAL_OUT"
else
  echo "[build-swift] Up to date: $CAL_OUT"
fi

# --- Browser helper (persistent, spawned by the node `browser` sensor, disclaimed) ---
BROWSER_SRC="$DAEMON_DIR/macos-browser-helper.swift"
BROWSER_OUT="$OUT_DIR/sundial-browser-helper"

if [ ! -f "$BROWSER_OUT" ] || [ "$BROWSER_SRC" -nt "$BROWSER_OUT" ]; then
  echo "[build-swift] Compiling macos-browser-helper.swift..."
  # Same reasoning as the calendar helper: a bare Mach-O needs its usage string
  # embedded, or the Automation prompt names the wrong process or never shows.
  BROWSER_PLIST="$(mktemp -t sundial-browser-plist).plist"
  cat > "$BROWSER_PLIST" <<'BROWSERPLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>dev.sundial.browser-helper</string>
  <key>CFBundleName</key>
  <string>Sundial Browser Helper</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>Sundial asks your browser which page is open, so it knows what you are reading. It keeps only the site and path — never a query string, never a private window.</string>
</dict>
</plist>
BROWSERPLIST
  swiftc -O -o "$BROWSER_OUT" "$BROWSER_SRC" -framework AppKit -framework Foundation \
    -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$BROWSER_PLIST"
  rm -f "$BROWSER_PLIST"
  echo "[build-swift] Built: $BROWSER_OUT"
else
  echo "[build-swift] Up to date: $BROWSER_OUT"
fi

# --- Input-activity helper (persistent sidecar) ---
INPUT_SRC="$DAEMON_DIR/macos-input-helper.swift"
INPUT_OUT="$OUT_DIR/sundial-input-helper"

if [ ! -f "$INPUT_OUT" ] || [ "$INPUT_SRC" -nt "$INPUT_OUT" ]; then
  echo "[build-swift] Compiling macos-input-helper.swift..."
  swiftc -O -o "$INPUT_OUT" "$INPUT_SRC" -framework ApplicationServices -framework Foundation
  echo "[build-swift] Built: $INPUT_OUT"
else
  echo "[build-swift] Up to date: $INPUT_OUT"
fi

# --- Notification-badge helper (persistent sidecar) ---
NOTIF_SRC="$DAEMON_DIR/macos-notification-helper.swift"
NOTIF_OUT="$OUT_DIR/sundial-notification-helper"

if [ ! -f "$NOTIF_OUT" ] || [ "$NOTIF_SRC" -nt "$NOTIF_OUT" ]; then
  echo "[build-swift] Compiling macos-notification-helper.swift..."
  swiftc -O -o "$NOTIF_OUT" "$NOTIF_SRC" -framework ApplicationServices -framework AppKit -framework Foundation
  echo "[build-swift] Built: $NOTIF_OUT"
else
  echo "[build-swift] Up to date: $NOTIF_OUT"
fi

# --- Screen-OCR helper (P7, persistent sidecar — spawned only when ocr.enabled) ---
OCR_SRC="$DAEMON_DIR/macos-screen-ocr-helper.swift"
OCR_OUT="$OUT_DIR/sundial-screen-ocr-helper"

if [ ! -f "$OCR_OUT" ] || [ "$OCR_SRC" -nt "$OCR_OUT" ]; then
  echo "[build-swift] Compiling macos-screen-ocr-helper.swift..."
  swiftc -O -o "$OCR_OUT" "$OCR_SRC" -framework ScreenCaptureKit -framework Vision -framework CoreGraphics -framework AppKit -framework Foundation
  echo "[build-swift] Built: $OCR_OUT"
else
  echo "[build-swift] Up to date: $OCR_OUT"
fi

# --- Audio helper (persistent sidecar — spawned only when audio.enabled) ---
AUDIO_SRC="$DAEMON_DIR/macos-audio-helper.swift"
AUDIO_OUT="$OUT_DIR/sundial-audio-helper"

if [ ! -f "$AUDIO_OUT" ] || [ "$AUDIO_SRC" -nt "$AUDIO_OUT" ]; then
  echo "[build-swift] Compiling macos-audio-helper.swift..."
  swiftc -O -o "$AUDIO_OUT" "$AUDIO_SRC" -framework AVFoundation -framework Foundation
  echo "[build-swift] Built: $AUDIO_OUT"
else
  echo "[build-swift] Up to date: $AUDIO_OUT"
fi

# --- Daemon launcher (CFBundleExecutable — also reads focus mode with FDA,
# and AV/mic-camera state — see AvCamera.swift's comment for why AV capture
# lives here and not in window-helper) ---
FOCUS_SRC="$SWIFT_DIR/FocusModeCapture.swift"

launcher_needs_build() {
  if [ ! -f "$LAUNCHER_OUT" ]; then
    return 0
  fi
  if [ "$FOCUS_SRC" -nt "$LAUNCHER_OUT" ]; then
    return 0
  fi
  for src in "$LAUNCHER_DIR"/*.swift; do
    if [ "$src" -nt "$LAUNCHER_OUT" ]; then
      return 0
    fi
  done
  return 1
}

if launcher_needs_build; then
  echo "[build-swift] Compiling macos-daemon-launcher..."
  swiftc -O -o "$LAUNCHER_OUT" "$LAUNCHER_DIR"/*.swift "$FOCUS_SRC" \
    -framework Foundation \
    -framework AppKit \
    -framework AVFoundation \
    -framework CoreAudio \
    -framework UserNotifications
  echo "[build-swift] Built: $LAUNCHER_OUT"
else
  echo "[build-swift] Up to date: $LAUNCHER_OUT"
fi

# --- The app itself (apps/macos): the bundle's executable, the menu bar, the supervisor ---
APP_SRC="$PROJECT_ROOT/apps/macos/Sundial.swift"
APP_OUT="$OUT_DIR/Sundial"
if [ ! -f "$APP_OUT" ] || [ "$APP_SRC" -nt "$APP_OUT" ]; then
  echo "[build-swift] Compiling the Sundial app..."
  swiftc -O -o "$APP_OUT" "$APP_SRC" -framework AppKit -framework WebKit -framework ServiceManagement
  echo "[build-swift] Built: $APP_OUT"
else
  echo "[build-swift] Up to date: $APP_OUT"
fi

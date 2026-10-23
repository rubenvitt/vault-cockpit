#!/usr/bin/env bash
# Archiviert die App signiert und lädt sie zu TestFlight hoch (App Store Connect API-Key).
#
# Umgebung:
#   ASC_KEY_ID, ASC_ISSUER_ID   Pflicht
#   ASC_KEY_PATH                Standard ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8
#   APPLE_TEAM_ID               Standard H95J852PKP
#   BUILD_NUMBER                Standard UTC-Zeitstempel JJJJMMTT.HHMM (steigt mit jedem Lauf)
#   EXPORT_DESTINATION          upload (Standard) oder export: nur signieren, nichts hochladen
set -euo pipefail

cd "$(dirname "$0")/.."

: "${ASC_KEY_ID:?ASC_KEY_ID fehlt}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID fehlt}"
ASC_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
TEAM_ID="${APPLE_TEAM_ID:-H95J852PKP}"
# Zwei Zahlen statt einer, damit jede Komponente in 32 Bit passt.
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d.%H%M)}"
EXPORT_DESTINATION="${EXPORT_DESTINATION:-upload}"

[[ -f "$ASC_KEY_PATH" ]] || { echo "API-Key nicht gefunden: $ASC_KEY_PATH" >&2; exit 1; }
[[ "$EXPORT_DESTINATION" == upload || "$EXPORT_DESTINATION" == export ]] \
  || { echo "EXPORT_DESTINATION muss upload oder export sein" >&2; exit 1; }

OUT="build/testflight"
ARCHIVE="$OUT/Cockpit.xcarchive"
rm -rf "$OUT"
mkdir -p "$OUT"

AUTH=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$ASC_KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
)

cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$EXPORT_DESTINATION</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
PLIST

echo "Build $BUILD_NUMBER, Team $TEAM_ID, Ziel $EXPORT_DESTINATION"

xcodegen generate

xcodebuild -project Cockpit.xcodeproj -scheme Cockpit -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM_ID" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  "${AUTH[@]}" archive

xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" \
  "${AUTH[@]}"

echo "Fertig: Build $BUILD_NUMBER ($EXPORT_DESTINATION)"

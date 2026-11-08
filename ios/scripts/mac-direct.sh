#!/usr/bin/env bash
# Baut die macOS-App (Mac Catalyst) für den Direktvertrieb außerhalb des App Stores: signiert mit
# Developer ID, ohne App Sandbox, mit Selbst-Update (siehe ios/README.md, „Direktvertrieb“),
# notarisiert und geheftet. Ergebnis unter ios/build/mac-direct/:
#   Cockpit-<VERSION>.dmg   zum Installieren (Cockpit in „Programme“ ziehen)
#   Cockpit-mac.zip         für das Update in der App (MacUpdater lädt genau diesen Namen)
#
# Umgebung:
#   VERSION                     Pflicht, X.Y.Z (CFBundleShortVersionString, vgl. mac-release.js)
#   ASC_KEY_ID, ASC_ISSUER_ID   Pflicht: automatisches Signieren und Notarisieren mit dem API-Key
#   ASC_KEY_PATH                Standard ~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8
#   APPLE_TEAM_ID               Standard H95J852PKP
#   BUILD_NUMBER                Standard UTC-Zeitstempel JJJJMMTT.HHMM
#   DEVELOPER_ID_P12_BASE64     optional: Zertifikat „Developer ID Application“ (.p12, base64);
#   DEVELOPER_ID_P12_PASSWORD   ohne nutzt der Export das von Apple verwaltete Zertifikat (Cloud).
#                               Mit Zertifikat wird auch die DMG selbst signiert.
#   NOTARIZE=0                  nicht notarisieren (nur zum Ausprobieren; Gatekeeper sperrt dann)
set -euo pipefail

cd "$(dirname "$0")/.."

: "${VERSION:?VERSION fehlt (X.Y.Z)}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "VERSION muss X.Y.Z sein: $VERSION" >&2; exit 1; }
: "${ASC_KEY_ID:?ASC_KEY_ID fehlt}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID fehlt}"
ASC_KEY_PATH="${ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8}"
[[ -f "$ASC_KEY_PATH" ]] || { echo "API-Key nicht gefunden: $ASC_KEY_PATH" >&2; exit 1; }
TEAM_ID="${APPLE_TEAM_ID:-H95J852PKP}"
BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d.%H%M)}"
NOTARIZE="${NOTARIZE:-1}"

OUT="build/mac-direct"
ARCHIVE="$OUT/Cockpit.xcarchive"
APP="$OUT/export/Cockpit.app"
DMG="$OUT/Cockpit-$VERSION.dmg"
ZIP="$OUT/Cockpit-mac.zip"
rm -rf "$OUT"
mkdir -p "$OUT"

AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
NOTARY=(--key "$ASC_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID")

# Eigenes Zertifikat in einen Wegwerf-Schlüsselbund, sonst signiert der Export über Apples Cloud.
KEYCHAIN=""
SIGN_IDENTITY=""
cleanup() {
  [[ -n "$KEYCHAIN" ]] && security delete-keychain "$KEYCHAIN" 2>/dev/null || true
}
trap cleanup EXIT
if [[ -n "${DEVELOPER_ID_P12_BASE64:-}" ]]; then
  KEYCHAIN="$PWD/$OUT/signing.keychain-db"
  KEYCHAIN_PASSWORD="$(uuidgen)"
  P12="$OUT/developer-id.p12"
  (umask 077; printf '%s' "$DEVELOPER_ID_P12_BASE64" | base64 --decode > "$P12")
  security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  security set-keychain-settings -lut 3600 "$KEYCHAIN"
  security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN"
  security import "$P12" -k "$KEYCHAIN" -P "${DEVELOPER_ID_P12_PASSWORD:-}" -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/xcodebuild
  rm -f "$P12"
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN" > /dev/null
  # Vorne in die Suchliste, damit xcodebuild und codesign das Zertifikat finden. Die Pfade der
  # vorhandenen Schlüsselbünde absichtlich ungequotet (je einer pro Wort; Bash 3.2 kennt kein mapfile).
  # shellcheck disable=SC2046
  security list-keychains -d user -s "$KEYCHAIN" $(security list-keychains -d user | tr -d '"')
  SIGN_IDENTITY="$(security find-identity -v -p codesigning "$KEYCHAIN" | awk -F'"' '/Developer ID Application/ { print $2; exit }')"
  # shellcheck disable=SC1111
  [[ -n "$SIGN_IDENTITY" ]] || { echo "Kein „Developer ID Application“-Zertifikat im .p12" >&2; exit 1; }
  echo "Signiere mit: $SIGN_IDENTITY"
fi

cat > "$OUT/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>developer-id</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
</dict>
</plist>
PLIST

echo "Cockpit $VERSION ($BUILD_NUMBER) für den Direktvertrieb, Team $TEAM_ID"

xcodegen generate

# COCKPIT_MAC_ENTITLEMENTS: ohne Sandbox (die App ersetzt sich beim Update selbst); die Share
# Extension behält ihre Sandbox. COCKPIT_SELF_UPDATE schaltet MacUpdater ein. Notarisieren
# verlangt die Hardened Runtime.
xcodebuild -project Cockpit.xcodeproj -scheme Cockpit -configuration Release \
  -destination 'generic/platform=macOS,variant=Mac Catalyst' -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM_ID" MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  COCKPIT_MAC_ENTITLEMENTS=Cockpit/Cockpit-macOS-direct.entitlements COCKPIT_SELF_UPDATE=YES \
  ENABLE_HARDENED_RUNTIME=YES \
  "${AUTH[@]}" archive

xcodebuild -exportArchive -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" -exportPath "$OUT/export" \
  "${AUTH[@]}"

[[ -d "$APP" ]] || { echo "Export ohne Cockpit.app" >&2; ls -la "$OUT/export" >&2; exit 1; }
codesign --verify --deep --strict --verbose=2 "$APP"
actual="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
[[ "$actual" == "$VERSION" ]] || { echo "Version im Bundle ist $actual statt $VERSION" >&2; exit 1; }

# Reicht eine Datei zur Notarisierung ein und bricht ab, wenn Apple sie nicht annimmt.
notarize() {
  local file="$1" result id status
  result="$(xcrun notarytool submit "$file" "${NOTARY[@]}" --wait --output-format json)"
  id="$(node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).id' <<< "$result")"
  status="$(node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).status' <<< "$result")"
  echo "Notarisierung $id: $status"
  if [[ "$status" != Accepted ]]; then
    xcrun notarytool log "$id" "${NOTARY[@]}" >&2 || true
    exit 1
  fi
}

if [[ "$NOTARIZE" == 1 ]]; then
  ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
  notarize "$OUT/notarize.zip"
  rm -f "$OUT/notarize.zip"
  xcrun stapler staple "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
fi

# Für das Update in der App: die geheftete App, damit sie auch ohne Netz startet.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"

# DMG mit Verknüpfung auf „Programme“ zum Hineinziehen.
STAGE="$OUT/dmg"
mkdir -p "$STAGE"
ditto "$APP" "$STAGE/Cockpit.app"
ln -s /Applications "$STAGE/Programme"
hdiutil create -volname "Cockpit $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG"
rm -rf "$STAGE"
if [[ -n "$SIGN_IDENTITY" ]]; then
  codesign --sign "$SIGN_IDENTITY" --timestamp --keychain "$KEYCHAIN" "$DMG"
fi
if [[ "$NOTARIZE" == 1 ]]; then
  notarize "$DMG"
  xcrun stapler staple "$DMG"
fi

shasum -a 256 "$DMG" "$ZIP"
echo "Fertig: $DMG, $ZIP"

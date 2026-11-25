#!/usr/bin/env bash
# Richtet Cockpit Sync als launchd-Agent ein (VCP-152) oder entfernt ihn.
#   desktop-sync/install.sh <cockpit-url> [vault-pfad]   einrichten bzw. aktualisieren
#   desktop-sync/install.sh --uninstall                   entfernen (Zustand und Token bleiben)
# Der Token (Recht „Sync“, eigener Gerätename) kommt in den Schlüsselbund; fehlt er, wird gefragt.
set -euo pipefail

LABEL=dev.rubeen.cockpit-sync
APP="$HOME/Library/Application Support/cockpit-sync/app"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/cockpit-sync"
DOMAIN="gui/$(id -u)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Cockpit Sync entfernt (Zustand unter ~/Library/Application Support/cockpit-sync, Token im Schlüsselbund bleiben)."
  exit 0
fi

URL="${1:?Cockpit-URL fehlt, z. B. https://cockpit.example.org}"
VAULT="$(cd "${2:-$HOME/rnotes}" && pwd)"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(node -p process.execPath)" # echter Pfad, launchd kennt mise/pnpm-Shims nicht

if ! security find-generic-password -s "$LABEL" -a token >/dev/null 2>&1; then
  echo "Sync-Token für dieses Gerät eingeben (Cockpit → Einstellungen → API-Tokens, Recht „Sync“):"
  security add-generic-password -U -s "$LABEL" -a token -w
fi

# Eigene Kopie des Codes: ein Branchwechsel im Repo ändert den laufenden Dienst nicht.
mkdir -p "$APP/desktop-sync" "$APP/obsidian-plugin" "$LOGS" "$(dirname "$PLIST")"
cp "$REPO/desktop-sync/cockpit-sync.mjs" "$APP/desktop-sync/"
cp "$REPO/obsidian-plugin/main.js" "$REPO/obsidian-plugin/package.json" "$APP/obsidian-plugin/"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$APP/desktop-sync/cockpit-sync.mjs</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COCKPIT_URL</key><string>$URL</string>
    <key>VAULT_PATH</key><string>$VAULT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOGS/cockpit-sync.log</string>
  <key>StandardErrorPath</key><string>$LOGS/cockpit-sync.log</string>
</dict>
</plist>
EOF

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Cockpit Sync läuft: $VAULT ↔ $URL"
echo "Log: tail -f \"$LOGS/cockpit-sync.log\""

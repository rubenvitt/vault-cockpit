#!/bin/sh
# Signiert die Kurzbefehle für den Import auf iOS. Läuft nur auf macOS (`shortcuts sign`).
#
#   scripts/kurzbefehle/sign.sh
#
# Liest docs/kurzbefehle/unsigniert/*.shortcut und schreibt die signierten Dateien
# nach docs/kurzbefehle/. `--mode anyone` erlaubt den Import auf jedem Gerät (mit
# dem eigenen Apple-Account signiert, braucht Netz).
set -eu
cd "$(dirname "$0")/../.."
command -v shortcuts >/dev/null || { echo "shortcuts fehlt: Das Skript läuft nur auf macOS." >&2; exit 1; }
for f in docs/kurzbefehle/unsigniert/*.shortcut; do
  out="docs/kurzbefehle/$(basename "$f")"
  shortcuts sign --mode anyone --input "$f" --output "$out"
  echo "$out"
done

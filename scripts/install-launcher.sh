#!/bin/bash
# Creates ~/Applications/CTT.AY.app: a normal double-click app (put it in the Dock) that runs scripts/launch.sh.
# Safe to re-run (e.g. after upgrading Node or moving the project).
#   scripts/install-launcher.sh              # install the app
#   scripts/install-launcher.sh --login      # also start the server automatically at login (launchd)
#   scripts/install-launcher.sh --no-login   # remove that login item again

set -eu
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
LAUNCH="$APP_DIR/scripts/launch.sh"
APP="$HOME/Applications/CTT.AY.app"
PLIST="$HOME/Library/LaunchAgents/nl.cttay.server.plist"

# Pin this machine's node path into the launcher (launch.sh ships with a placeholder).
sed -i '' "s|^NODE_BIN=\"\${NODE_BIN:-.*}\"\$|NODE_BIN=\"\${NODE_BIN:-$NODE_BIN}\"|" "$LAUNCH"
chmod +x "$LAUNCH"

if [ "${1:-}" = "--no-login" ]; then
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Login item removed."
  exit 0
fi

mkdir -p "$HOME/Applications"
rm -rf "$APP"
osacompile -o "$APP" -e "do shell script \"'$LAUNCH' >/dev/null 2>&1 &\""
echo "Installed $APP — double-click it, or drag it to the Dock."

if [ "${1:-}" = "--login" ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>nl.cttay.server</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>-c</string><string>NO_OPEN=1 '$LAUNCH'</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "The server will now start at every login (without opening a window)."
fi

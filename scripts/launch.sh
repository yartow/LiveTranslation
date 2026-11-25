#!/bin/bash
# One-click launcher for CTT.AY: starts the production server if it isn't running, then opens the page.
# Used by the "CTT.AY" app that scripts/install-launcher.sh creates; also fine to run by hand.
# The node path is filled in by the installer (NODE_BIN), so no shell profile / nvm is needed.

set -u
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-/Users/andrewyong/.nvm/versions/node/v24.14.1/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node || true)"
[ -x "$NODE_BIN" ] || { osascript -e 'display alert "CTT.AY" message "Node.js was not found. Re-run scripts/install-launcher.sh."'; exit 1; }
export PATH="$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

cd "$APP_DIR" || exit 1
mkdir -p data
LOG="$APP_DIR/data/launcher.log"

# Port: the environment's PORT, else .env's (PORT=...), else 5001 — the same order server/index.ts ends up with
# (node's --env-file never overrides a variable that is already set). A restart from the Settings page passes
# the running server's PORT through the environment, so the new server comes up where the old one was.
PORT="${PORT:-$(grep -E '^PORT=' .env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"' | tr -d "'" | tr -d '[:space:]')}"
PORT="${PORT:-5001}"
URL="http://localhost:$PORT/"

is_up() { /usr/bin/nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; }

if ! is_up; then
  # Build once, and again only when the source is newer than the build.
  if [ ! -f dist/index.js ] || [ -n "$(find client/src server shared package.json vite.config.ts -newer dist/index.js -type f 2>/dev/null | head -1)" ]; then
    "$(dirname "$NODE_BIN")/npm" run build >>"$LOG" 2>&1 \
      || { osascript -e 'display alert "CTT.AY" message "The build failed. See data/launcher.log."'; exit 1; }
  fi
  # --env-file makes node exit when the file is missing, so it is only passed when there is one.
  ENV_FLAG=""; [ -f .env ] && ENV_FLAG="--env-file=.env"
  NODE_ENV=production PORT="$PORT" nohup "$NODE_BIN" $ENV_FLAG dist/index.js >>"$LOG" 2>&1 &
  disown
  # Wait until it answers (max ~30 s), polling fast so a normal start feels instant.
  for _ in $(seq 1 150); do is_up && break; sleep 0.2; done
  is_up || { osascript -e 'display alert "CTT.AY" message "The server did not start. See data/launcher.log."'; exit 1; }
fi

[ -n "${NO_OPEN:-}" ] || open "$URL"

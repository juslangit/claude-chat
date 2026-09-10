#!/bin/bash
# One-time setup for claude-chat. Safe to run again after changes.
#   1. runs the server now, and again every time the Mac logs in (a macOS LaunchAgent)
#   2. adds the `cchat` command for starting phone-visible chats from the Mac
#   3. publishes the app on your private Tailscale network so the phone can reach it
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL=com.juslangit.claude-chat
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || echo /opt/homebrew/bin/node)"
mkdir -p "$DIR/data"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>LANG</key><string>en_US.UTF-8</string>
    <key>LC_CTYPE</key><string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/data/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/server.log</string>
</dict></plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && sleep 1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ server running at http://127.0.0.1:4477 (log: data/server.log)"

chmod +x "$DIR/bin/cchat"
mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/bin/cchat" "$HOME/.local/bin/cchat"
echo "✓ 'cchat' command installed"

# Tailscale: this main Mac runs it in userspace mode with its own socket (D-004); other Macs use the app.
SOCK="$HOME/Library/Application Support/tailscale-user/tailscaled.sock"
if [ -S "$SOCK" ]; then TS=(/opt/homebrew/opt/tailscale/bin/tailscale --socket="$SOCK")
elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then TS=(/Applications/Tailscale.app/Contents/MacOS/Tailscale)
else TS=(tailscale); fi
if "${TS[@]}" status >/dev/null 2>&1; then
  "${TS[@]}" serve --bg 4477
else
  echo "! Tailscale isn't signed in yet — sign in, then run ./install.sh again."
fi

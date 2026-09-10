#!/bin/bash
# Set up claude-chat on another Mac, so your iPhone can use Claude Code on it too.
#
# On that Mac: install Tailscale from the App Store and sign in with the same account as your
# iPhone. Then open Terminal and paste:
#
#   curl -fsSL __HOME_URL__/setup/mac | bash
#
# It installs what's needed (Homebrew, tmux, Node, GitHub's tool, Syncthing, Claude Code), copies
# your projects from GitHub into ~/Desktop/project, installs claude-chat so it starts at login and
# shows up on the phone, and pairs Syncthing with your main Mac so your Claude notes match.
# Safe to run again — it skips anything already done.
set -euo pipefail

HOME_URL="__HOME_URL__"   # your main Mac, filled in when this script is downloaded from it
PROJECTS="$HOME/Desktop/project"
step() { printf '\n\033[1;32m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
say()  { printf '    %s\n' "$*"; }

step "Checking Tailscale"
curl -fsS --max-time 10 "$HOME_URL/api/whoami" >/dev/null || {
  say "Can't reach your main Mac at $HOME_URL."
  say "Is Tailscale signed in on this Mac with the same account, and is the main Mac switched on?"
  exit 1
}
say "Main Mac found."

step "Homebrew and tools (may ask for your Mac password)"
if ! command -v brew >/dev/null; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi
brew install --quiet tmux node gh jq syncthing
brew services start syncthing >/dev/null 2>&1 || true

step "Claude Code"
[ -x "$HOME/.local/bin/claude" ] || curl -fsSL https://claude.ai/install.sh | bash
# Phone chats run in bypass-permissions mode (D-006); don't let its warning stop a chat starting.
node -e '
  const fs = require("fs"), f = require("os").homedir() + "/.claude/settings.json";
  let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  s.skipDangerousModePermissionPrompt = true;
  fs.mkdirSync(require("path").dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s, null, 2));'

step "GitHub (opens your browser to sign in, once)"
gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https </dev/tty
gh auth setup-git

step "Your projects → $PROJECTS"
mkdir -p "$PROJECTS"
curl -fsS "$HOME_URL/api/projects" | jq -r '.[] | select(.remote) | "\(.name) \(.remote)"' | while read -r name remote; do
  if [ -d "$PROJECTS/$name/.git" ]; then say "$name — already here"
  else git clone -q "$remote" "$PROJECTS/$name" && say "$name — copied"; fi
done

step "claude-chat"
"$PROJECTS/claude-chat/install.sh"

step "Syncthing (keeps your Claude notes the same on every computer)"
mkdir -p "$HOME/.claude/knowledge"
MY_ID=""
for _ in $(seq 1 30); do MY_ID=$(syncthing device-id 2>/dev/null) && [ -n "$MY_ID" ] && break; sleep 1; done
for _ in $(seq 1 30); do syncthing cli show system >/dev/null 2>&1 && break; sleep 1; done
HOME_ID=$(curl -fsS -X POST -H 'content-type: application/json' \
  -d "$(jq -n --arg id "$MY_ID" --arg n "$(scutil --get ComputerName)" '{id: $id, name: $n}')" \
  "$HOME_URL/api/sync/pair" | jq -r .id)
syncthing cli config devices list | grep -q "$HOME_ID" || syncthing cli config devices add --device-id "$HOME_ID" --name "Main Mac"
syncthing cli config folders list | grep -q claude-knowledge || \
  syncthing cli config folders add --id claude-knowledge --label "Claude notes" --path "$HOME/.claude/knowledge"
syncthing cli config folders claude-knowledge devices list | grep -q "$HOME_ID" || \
  syncthing cli config folders claude-knowledge devices add --device-id "$HOME_ID"
say "Paired with the main Mac."

step "Done"
say "This Mac ($(scutil --get ComputerName)) now shows on your iPhone: Chats → ⋯ → Computers."
say "Last step, once: log in to Claude Code and trust your project folder. Paste:"
say "    cd ~/Desktop/project && claude"
say "Log in, choose 'Yes, I trust this folder', then type /exit."

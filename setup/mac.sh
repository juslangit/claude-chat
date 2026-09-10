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
# Your settings (including the bypass-permissions ones, D-006) arrive from the main Mac by Syncthing below.

step "GitHub (opens your browser to sign in, once)"
gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https </dev/tty
gh auth setup-git

step "Your projects → $PROJECTS"
mkdir -p "$PROJECTS"
# Name and address are split by a tab, so a project called "TODAK ACADEMY" stays in one piece.
curl -fsS "$HOME_URL/api/projects" | jq -r '.[] | select(.remote) | "\(.name)\t\(.remote)"' | while IFS=$'\t' read -r name remote; do
  if [ -d "$PROJECTS/$name/.git" ]; then say "$name — already here"
  elif git clone -q "$remote" "$PROJECTS/$name"; then say "$name — copied"
  else say "$name — couldn't copy it (see git's message above); carrying on with the rest"; fi
done

step "claude-chat"
"$PROJECTS/claude-chat/install.sh"

step "Your Claude setup: instructions, settings, keys, memory tool, notes (Syncthing)"
for _ in $(seq 1 30); do syncthing cli show system >/dev/null 2>&1 && break; sleep 1; done
if syncthing cli config folders list | grep -q claude-home; then
  say "Already paired with the main Mac."
else
  read -r -p "    Pairing code from your iPhone (Chats → ⋯ → Computers → Add a computer): " CODE </dev/tty
  MY_ID=$(syncthing device-id)
  RESP=$(curl -sS -X POST -H 'content-type: application/json' \
    -d "$(jq -n --arg id "$MY_ID" --arg n "$(scutil --get ComputerName)" --arg c "$CODE" '{id: $id, name: $n, code: $c}')" \
    "$HOME_URL/api/sync/pair")
  HOME_ID=$(echo "$RESP" | jq -r '.id // empty')
  [ -n "$HOME_ID" ] || { say "Pairing didn't work: $(echo "$RESP" | jq -r '.error // .')"; say "Get a new code on your iPhone and run this again."; exit 1; }
  # Put aside anything this Mac already had, so the main Mac's copies arrive cleanly instead of clashing.
  mkdir -p "$HOME/.claude"
  for f in CLAUDE.md settings.json .env; do [ -e "$HOME/.claude/$f" ] && mv "$HOME/.claude/$f" "$HOME/.claude/$f.before-sync"; done
  cat > "$HOME/.claude/.stignore" <<'EOF'
// Shared between your computers by Syncthing (claude-chat D-014): only these parts of ~/.claude.
(?d).DS_Store
!/CLAUDE.md
!/settings.json
!/.env
!/.freesound-token.json
!/knowledge
!/knowledge/**
!/skybrain
!/skybrain/**
*
EOF
  syncthing cli config devices list | grep -q "$HOME_ID" || syncthing cli config devices add --device-id "$HOME_ID" --name "Main Mac"
  syncthing cli config folders add --id claude-home --label "Claude setup" --path "$HOME/.claude"
  syncthing cli config folders claude-home devices add --device-id "$HOME_ID"
  say "Paired. Your setup arrives from the main Mac within a minute or two."
fi
mkdir -p "$HOME/.local/bin"
ln -sf "$HOME/.claude/skybrain/bin/mem" "$HOME/.local/bin/mem"   # the Sky AI Brain memory tool

step "Done"
say "This Mac ($(scutil --get ComputerName)) now shows on your iPhone: Chats → ⋯ → Computers."
say "Last step, once: log in to Claude Code and trust your project folder. Paste:"
say "    cd ~/Desktop/project && claude"
say "Log in, choose 'Yes, I trust this folder', then type /exit."

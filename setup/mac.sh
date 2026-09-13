#!/bin/bash
# Set up claude-chat on a Mac, so your iPhone can use Claude Code on it.
#
# First install Tailscale from the App Store and sign in — the same account on the Mac and the iPhone.
# Then open Terminal and paste one of these:
#
#   your first computer:     curl -fsSL https://raw.githubusercontent.com/juslangit/claude-chat/main/setup/mac.sh | bash
#   adding another computer: curl -fsSL __HOME_URL__/setup/mac | bash
#                            (your iPhone shows this line: Chats → ⋯ → Computers → Add a computer)
#
# It installs what's needed (Homebrew, tmux, Node, Syncthing, Claude Code) and claude-chat itself, so it
# starts at login and shows up on the phone. When it's adding a computer, it also copies your projects
# from GitHub into ~/Desktop/project and pairs Syncthing with the first computer, so your Claude setup
# matches. Safe to run again — it skips anything already done.
set -euo pipefail

HOME_URL="__HOME_URL__"   # filled in when this script is downloaded from one of your computers
REPO="https://github.com/juslangit/claude-chat.git"
PROJECTS="$HOME/Desktop/project"
# Straight from GitHub, the address above is never filled in: this is your first computer, with nothing to
# join. (Checked by its shape — the line that fills it in replaces every copy of the placeholder.)
case "$HOME_URL" in https://*) FIRST=false ;; *) FIRST=true ;; esac
step() { printf '\n\033[1;32m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
say()  { printf '    %s\n' "$*"; }
# Tailscale's command-line tool, wherever this Mac keeps it (the same order install.sh uses).
tailscale_cli() {
  local sock="$HOME/Library/Application Support/tailscale-user/tailscaled.sock"
  if [ -S "$sock" ]; then /opt/homebrew/opt/tailscale/bin/tailscale --socket="$sock" "$@"
  elif [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then /Applications/Tailscale.app/Contents/MacOS/Tailscale "$@"
  else tailscale "$@"; fi
}

step "Checking Tailscale"
if $FIRST; then
  tailscale_cli status >/dev/null 2>&1 || {
    say "Tailscale isn't installed or signed in on this Mac yet."
    say "Install it from the App Store, sign in (the same account as on your iPhone), then run this again."
    exit 1
  }
  say "Tailscale is on. This will be your first claude-chat computer."
else
  curl -fsS --max-time 10 "$HOME_URL/api/whoami" >/dev/null || {
    say "Can't reach your other computer at $HOME_URL."
    say "Is Tailscale signed in on this Mac with the same account, and is that computer switched on?"
    exit 1
  }
  say "Your other computer found."
fi

step "Homebrew and tools (may ask for your Mac password)"
if ! command -v brew >/dev/null; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/tty
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
fi
brew install --quiet tmux node gh jq syncthing
brew services start syncthing >/dev/null 2>&1 || true

step "Claude Code"
[ -x "$HOME/.local/bin/claude" ] || curl -fsSL https://claude.ai/install.sh | bash
# When adding a computer, your settings (including the permission mode chats use) arrive by Syncthing below.

if $FIRST; then
  step "claude-chat → $PROJECTS/claude-chat"
  mkdir -p "$PROJECTS"
  if [ -d "$PROJECTS/claude-chat/.git" ]; then say "already here"
  else git clone -q "$REPO" "$PROJECTS/claude-chat" && say "downloaded"; fi
else
  step "GitHub (opens your browser to sign in, once)"
  gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https </dev/tty
  gh auth setup-git

  step "Your projects → $PROJECTS"
  mkdir -p "$PROJECTS"
  # Name and address are split by a tab, so a project called "TODAK ACADEMY" stays in one piece.
  curl -fsS "$HOME_URL/api/projects" | jq -r '.[] | select(.remote) | "\(.name)\t\(.remote)"' | while IFS=$'\t' read -r name remote; do
    # Projects can sit in subject folders ("ai/claude-chat"); claude-chat itself always goes where setup put it.
    dest="$PROJECTS/$name"; [ "${name##*/}" = claude-chat ] && dest="$PROJECTS/claude-chat"
    if [ -d "$dest/.git" ]; then say "$name — already here"
    elif git clone -q "$remote" "$dest"; then say "$name — copied"
    else say "$name — couldn't copy it (see git's message above); carrying on with the rest"; fi
  done
fi

step "Starting claude-chat (it starts by itself from now on, whenever you log in)"
say "The first time, Tailscale may show a link to switch on HTTPS for your network: open it, press Enable, and it carries on."
"$PROJECTS/claude-chat/install.sh"

if ! $FIRST; then
  step "Your Claude setup: instructions, settings, keys, notes (Syncthing)"
  for _ in $(seq 1 30); do syncthing cli show system >/dev/null 2>&1 && break; sleep 1; done
  if syncthing cli config folders list | grep -q claude-home; then
    say "Already paired with your other computer."
  else
    read -r -p "    Pairing code from your iPhone (Chats → ⋯ → Computers → Add a computer): " CODE </dev/tty
    MY_ID=$(syncthing device-id)
    RESP=$(curl -sS -X POST -H 'content-type: application/json' \
      -d "$(jq -n --arg id "$MY_ID" --arg n "$(scutil --get ComputerName)" --arg c "$CODE" '{id: $id, name: $n, code: $c}')" \
      "$HOME_URL/api/sync/pair")
    HOME_ID=$(echo "$RESP" | jq -r '.id // empty')
    [ -n "$HOME_ID" ] || { say "Pairing didn't work: $(echo "$RESP" | jq -r '.error // .')"; say "Get a new code on your iPhone and run this again."; exit 1; }
    # Put aside anything this Mac already had, so the other computer's copies arrive cleanly instead of clashing.
    mkdir -p "$HOME/.claude"
    for f in CLAUDE.md settings.json .env; do [ -e "$HOME/.claude/$f" ] && mv "$HOME/.claude/$f" "$HOME/.claude/$f.before-sync"; done
    # The same list as server.mjs's STIGNORE and setup/wsl.sh.
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
    say "Paired. Your setup arrives from your other computer within a minute or two."
  fi
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.claude/skybrain/bin/mem" "$HOME/.local/bin/mem"   # the Sky AI Brain memory tool, if you have it
fi

step "Done"
if $FIRST; then
  ADDRESS="https://$(tailscale_cli status --json | jq -r '.Self.DNSName' | sed 's/\.$//')"
  say "Two last steps."
  say ""
  say "1. Once, log in to Claude Code and trust your project folder. Paste:"
  say "       cd ~/Desktop/project && ~/.local/bin/claude"
  say "   Log in, choose 'Yes, I trust this folder', then type /exit."
  say ""
  say "2. On your iPhone, open this address in Safari, then Share → Add to Home Screen:"
  say "       $ADDRESS"
else
  say "This Mac ($(scutil --get ComputerName)) now shows on your iPhone: Chats → ⋯ → Computers."
  say "Last step, once: log in to Claude Code and trust your project folder. Paste:"
  say "    cd ~/Desktop/project && ~/.local/bin/claude"
  say "Log in, choose 'Yes, I trust this folder', then type /exit."
fi

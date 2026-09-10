#!/bin/bash
# The Linux half of the Windows setup — windows.ps1 runs this inside WSL. Two jobs:
#
#   wsl.sh install <projects folder> <setup folder> <PC name>
#       tools, Claude Code, your projects, claude-chat, Syncthing; writes this PC's Syncthing ID
#       to <setup folder>/sync-id.txt for windows.ps1
#   wsl.sh pair <main Mac's Syncthing ID>
#       shares the Claude notes folder with the main Mac
set -euo pipefail
step() { printf '\n\033[1;32m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
say()  { printf '    %s\n' "$*"; }
sync_id() { syncthing device-id 2>/dev/null || syncthing --device-id 2>/dev/null; }
start_syncthing() {
  pgrep -x syncthing >/dev/null || (nohup syncthing serve --no-browser --no-restart >/dev/null 2>&1 &)
  for _ in $(seq 1 30); do syncthing cli show system >/dev/null 2>&1 && return; sleep 1; done
}

if [ "${1:-}" = pair ]; then
  HOME_ID="$2"
  start_syncthing
  syncthing cli config devices list | grep -q "$HOME_ID" || syncthing cli config devices add --device-id "$HOME_ID" --name "Main Mac"
  syncthing cli config folders claude-knowledge devices list | grep -q "$HOME_ID" || \
    syncthing cli config folders claude-knowledge devices add --device-id "$HOME_ID"
  exit 0
fi

PROJECTS="$2"; WORK="$3"; PC_NAME="${4:-Windows PC}"

step "Linux tools (asks for your Linux password)"
sudo apt-get update -qq
sudo apt-get install -y -qq tmux git curl jq ca-certificates gnupg >/dev/null
if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v gh >/dev/null; then
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg status=none
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq gh >/dev/null
fi
if ! command -v syncthing >/dev/null; then
  sudo mkdir -p /etc/apt/keyrings
  sudo curl -fsSL -o /etc/apt/keyrings/syncthing-archive-keyring.gpg https://syncthing.net/release-key.gpg
  echo "deb [signed-by=/etc/apt/keyrings/syncthing-archive-keyring.gpg] https://apt.syncthing.net/ syncthing stable" \
    | sudo tee /etc/apt/sources.list.d/syncthing.list >/dev/null
  sudo apt-get update -qq && sudo apt-get install -y -qq syncthing >/dev/null
fi

step "Claude Code"
[ -x "$HOME/.local/bin/claude" ] || curl -fsSL https://claude.ai/install.sh | bash
node -e '
  const fs = require("fs"), f = require("os").homedir() + "/.claude/settings.json";
  let s = {}; try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch {}
  s.skipDangerousModePermissionPrompt = true;
  fs.mkdirSync(require("path").dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s, null, 2));'
# Files written from Linux keep Linux line endings, so git doesn't see every file as changed.
git config --global core.autocrlf input

step "GitHub (opens your browser to sign in, once)"
gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https
gh auth setup-git

step "Your projects → $PROJECTS"
tr -d '\r' < "$WORK/projects.txt" | while read -r name remote; do
  [ -n "$name" ] || continue
  if [ -d "$PROJECTS/$name/.git" ]; then say "$name — already here"
  else git clone -q "$remote" "$PROJECTS/$name" && say "$name — copied"; fi
done

step "claude-chat"
DATA="$HOME/.claude-chat/data"
mkdir -p "$DATA"
cat > "$HOME/.claude-chat/start.sh" <<EOF
#!/bin/bash
# Started by Windows when you log in (Task Scheduler → claude-chat): keeps Syncthing and the
# claude-chat server running, and restarts the server if it ever stops.
export PATH="\$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
export CLAUDE_CHAT_WORKDIR="$PROJECTS" CLAUDE_CHAT_DATA="$DATA" LANG=C.UTF-8
pgrep -x syncthing >/dev/null || (nohup syncthing serve --no-browser --no-restart >/dev/null 2>&1 &)
cd "$PROJECTS/claude-chat"
while true; do node server.mjs >> "$DATA/server.log" 2>&1; sleep 2; done
EOF
chmod +x "$HOME/.claude-chat/start.sh"
mkdir -p "$HOME/.local/bin"
ln -sf "$PROJECTS/claude-chat/bin/cchat" "$HOME/.local/bin/cchat"
grep -q CLAUDE_CHAT_WORKDIR "$HOME/.bashrc" 2>/dev/null || echo "export CLAUDE_CHAT_WORKDIR=\"$PROJECTS\"" >> "$HOME/.bashrc"
say "Starts with Windows; 'cchat' works in the Ubuntu window."

step "Syncthing (keeps your Claude notes the same on every computer)"
mkdir -p "$HOME/.claude/knowledge"
start_syncthing
syncthing cli config folders list | grep -q claude-knowledge || \
  syncthing cli config folders add --id claude-knowledge --label "Claude notes" --path "$HOME/.claude/knowledge"
sync_id > "$WORK/sync-id.txt"
say "This PC's Syncthing ID: $(cat "$WORK/sync-id.txt")"

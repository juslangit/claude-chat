# claude-chat

Use Claude Code on the home Mac from your iPhone, like WhatsApp.

- Each chat on the phone **is** a Claude Code session running on the Mac, and each one is also a
  Terminal window on the Mac. Type in either place; both stay in sync.
- Tap **+** on the phone and pick a project, the way you'd pick a contact in WhatsApp. A new Terminal
  window with Claude Code opens on the Mac inside that project (or in `~/Desktop/project/` itself if
  you pick "Whole project folder") — so whatever you build lands in the project folder.
- Chats run in **bypass permissions** mode, the same as plain `claude` on this Mac: commands and file
  edits go ahead without asking. The deny list in `~/.claude/settings.json` (sudo, `rm -rf`, force-push…)
  still blocks those. If Claude Code does stop to ask something, the phone shows **Approve / Deny**
  (and the Mac's Terminal shows its usual prompt at the same time; either can answer).
- The **screen** button (top right of a chat) shows exactly what the Mac's Terminal shows, with keys
  for menus (1–4, arrows, Enter, Esc).
- It looks like WhatsApp on the iPhone: grey ticks mean Claude got your message, blue means it has
  answered or is working on it. Claude's steps (commands, file edits) fold into one "N steps" bubble —
  tap it to see them all.

## How it works, in one picture

```
 iPhone  ──Tailscale──▶  server.mjs  ──tmux──▶  claude  (one per chat)  ◀──  Terminal window
                            ▲   ▲                  │
                            │   └── hook.mjs ◀─────┤  "Claude wants to run X" / "Claude finished"
                            └────── transcript ◀───┘  everything that was said
```

- **tmux** keeps each Claude session alive in the background, so the phone can type into it and a
  Terminal window can show it at the same time.
- **The transcript** is the file Claude Code already writes for every session. The server reads it to
  show the conversation on the phone.
- **Hooks** are Claude Code's way of telling other programs what it's doing. `hook.mjs` passes those
  messages to the server, and waits for your answer when Claude asks permission.
- **Tailscale** is a private network of your own devices. Only your phone and your Mac are on it, so
  nobody else can reach the app.

## Files

| File | What it does |
|---|---|
| `server.mjs` | The middleman on the Mac. Starts chats, sends your messages in, sends replies out. |
| `hook.mjs` | Claude Code runs this on events; it forwards them and carries back approvals. |
| `public/` | The phone app — `index.html` (layout), `style.css` (look), `app.js` (behaviour). |
| `bin/cchat` | Type `cchat` in any Mac Terminal to start a chat that also shows on the phone. |
| `tmux.conf` | Makes the tmux windows look like a plain Terminal. |
| `install.sh` | One-time setup (start at login, `cchat` command, Tailscale). Safe to re-run. |
| `data/` | Created when it runs: list of chats, the hook password, the log. Not in git. |
| `dev/` | For testing changes to the phone page: a read-only test copy on port 4478 and iPhone-size screenshots. |

## Everyday use

| I want to… | Do this |
|---|---|
| Start a chat from the phone | Tap **+**, then pick a project |
| Start a chat from the Mac that shows on the phone | `cchat` or `cchat my chat name` — run inside a project folder and the chat starts in that project |
| Keep a chat private to the Mac | Plain `claude`, as before |
| Stop Claude mid-answer | Red **■** button (same as pressing Esc) |
| Rename a chat, end it, or open it on the Mac | Tap the chat's name at the top (Chat info) |
| Bring back a stopped chat (e.g. after a restart) | Open it, tap **Resume on the Mac** |
| See the server's log | `tail -f ~/Desktop/project/claude-chat/data/server.log` |
| Restart the server after changing code | `launchctl kickstart -k gui/$(id -u)/com.juslangit.claude-chat` |

Running chats are not affected by restarting the server — they live in tmux.

## Setup (already done on this Mac)

1. `brew install tmux tailscale`
2. Tailscale runs as a login item in userspace mode (`~/Library/LaunchAgents/com.juslangit.tailscaled.plist`)
   and is signed in once.
3. `./install.sh`
4. On the iPhone: install **Tailscale** from the App Store, sign in with the same account, open the
   address `install.sh` printed, then Share → **Add to Home Screen**.

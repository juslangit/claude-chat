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

- **Voice.** Hold 🎤 in the typing bar, talk, and let go to send (slide left to cancel). Or tap 📞 at
  the top of a chat for a call: you talk, Claude answers out loud in a few short sentences, then it
  listens again. Speech uses the iPhone's own recognition and voice, like Sky — works in Safari and
  the Home Screen app.
- While Claude works, the "typing…" bubble shows its latest progress note and step. Steps read in
  plain English ("Edited style.css"), with the raw command in small print underneath.

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
| `notes.mjs` | Reads Claude's progress notes off the Terminal screen, so the phone can show them while it works. |
| `public/` | The phone app — `index.html` (layout), `style.css` (look), `app.js` (behaviour). |
| `bin/cchat` | Type `cchat` in any Mac Terminal to start a chat that also shows on the phone. |
| `tmux.conf` | Makes the tmux windows look like a plain Terminal. |
| `install.sh` | One-time setup (start at login, `cchat` command, Tailscale). Safe to re-run. |
| `setup/` | One-line setup for another Mac (`mac.sh`) or a Windows PC (`windows.ps1` + `wsl.sh`), downloaded from this Mac. |
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
| Talk instead of typing | Hold 🎤, talk, let go. Slide left to cancel |
| Have a voice call with Claude | Tap 📞 at the top of the chat; the red button hangs up |
| Send a common reply in one tap | The buttons above the typing bar ("Yes, go ahead", "Explain simpler"…) |
| Turn the reply sound off | ⋯ on the Chats screen → Reply sound |
| Bring back a stopped chat (e.g. after a restart) | Open it, tap **Resume on the Mac** |
| See the server's log | `tail -f ~/Desktop/project/claude-chat/data/server.log` |
| Restart the server after changing code | `launchctl kickstart -k gui/$(id -u)/com.juslangit.claude-chat` |

Running chats are not affected by restarting the server — they live in tmux.

## More than one computer

The iPhone app shows the chats of every computer running claude-chat on your Tailscale network, each
labelled with its computer, and **+** asks which computer to start on (⋯ → Computers lists them).
To add a computer:

1. Install Tailscale on it and sign in with the same account as your iPhone.
2. On the iPhone: Chats → ⋯ → Computers → **Add a computer**. It shows the line to paste and a
   one-time pairing code (works once, for 30 minutes).
3. Paste the line on the new computer — it installs everything, copies your projects from GitHub,
   and asks for the code:
   - another Mac, in Terminal: `curl -fsSL https://luqman-mac.tail8806f8.ts.net/setup/mac | bash`
   - a Windows PC, in PowerShell: `irm https://luqman-mac.tail8806f8.ts.net/setup/windows | iex`
     (Claude Code runs in WSL, Windows' built-in Linux; projects stay in `Desktop\project`)
4. Log in to Claude Code there once and trust the project folder, as the script says at the end.

Projects move between computers through **GitHub**: when a chat starts in a project, the app first
fetches the newest version (as long as nothing is unsaved on that computer). When you stop on one
computer, ask Claude to save your work to GitHub. Your Claude setup — instructions (`CLAUDE.md`),
settings, keys (`.env`), the Sky AI Brain memory tool and your notes — stays the same everywhere
through **Syncthing**. Only those parts of `~/.claude` are shared (the list is in `~/.claude/.stignore`);
chat history stays on each computer.

## Setup (already done on this Mac)

1. `brew install tmux tailscale`
2. Tailscale runs as a login item in userspace mode (`~/Library/LaunchAgents/com.juslangit.tailscaled.plist`)
   and is signed in once.
3. `./install.sh`
4. On the iPhone: install **Tailscale** from the App Store, sign in with the same account, open the
   address `install.sh` printed, then Share → **Add to Home Screen**.

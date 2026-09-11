# claude-chat

Use Claude Code on your computer at home — a **Mac or a Windows PC** — from your iPhone, like WhatsApp.

> **Status:** a personal tool, in testing. It runs on Luqman's own Mac and Windows PC. It is **not ready
> for other people to install yet** — see [Can someone else use it?](#can-someone-else-use-it)

## What you need

| | |
|---|---|
| **A computer** | A Mac, or a Windows 10/11 PC (Windows 10 also needs **Windows Terminal** from the Microsoft Store). You can have several — the phone shows the chats of all of them. |
| **Claude Code** | On that computer, logged in with a Claude account that includes it (Pro or Max). The setup installs it if it isn't there yet. |
| **Tailscale** | Free. On the computer and on the iPhone, both signed in to the same account. |
| **An iPhone** | Safari is enough. Notifications need iOS 16.4 or later. |

On a **Windows PC**, Claude Code runs inside **WSL** (Windows' own built-in Linux), because claude-chat
needs tmux and tmux only runs on Linux and Mac. You don't have to work in Linux yourself: your projects
stay in a normal Windows folder (`Desktop\project`), so Unreal, Blender and other Windows apps open them
directly, and each chat opens as a **Windows Terminal** tab.

## What it does

- Each chat on the phone **is** a Claude Code session running on the computer, and each one is also a
  window on the computer — a Terminal window on a Mac, a Windows Terminal tab on a PC. Type in either
  place; both stay in sync.
- Tap **+** on the phone, pick the computer, then pick a project, the way you'd pick a contact in
  WhatsApp. A new window with Claude Code opens on that computer inside that project (or in the project
  folder itself if you pick "Whole project folder") — so whatever you build lands in the project folder.
- Chats run in **bypass permissions** mode, the same as plain `claude` on the Mac: commands and file
  edits go ahead without asking. The deny list in `~/.claude/settings.json` (sudo, `rm -rf`, force-push…)
  still blocks those. If Claude Code does stop to ask something, the phone shows **Approve / Deny**
  (and the computer's window shows its usual prompt at the same time; either can answer).
- When Claude asks you a **multiple-choice question**, it arrives as a message with a reply button for
  each answer. Tap one, or type or say your own answer instead. Several questions come one at a time.
  On a call, Claude reads the question and its choices out loud and you answer by talking.
- The **screen** button (top right of a chat) shows exactly what the computer's window shows, with keys
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

On a Windows PC, everything to the right of Tailscale runs inside WSL, and the window is a Windows
Terminal tab.

- **tmux** keeps each Claude session alive in the background, so the phone can type into it and a
  window on the computer can show it at the same time.
- **The transcript** is the file Claude Code already writes for every session. The server reads it to
  show the conversation on the phone.
- **Hooks** are Claude Code's way of telling other programs what it's doing. `hook.mjs` passes those
  messages to the server, and waits for your answer when Claude asks permission.
- **Tailscale** is a private network of your own devices. Only your phone and your computers are on it,
  so nobody else can reach the app.

## Mac and Windows side by side

| | Mac | Windows PC |
|---|---|---|
| Where Claude Code runs | macOS itself | Ubuntu, inside WSL |
| A chat's window on the computer | a Terminal window | a Windows Terminal tab |
| Project folder | `~/Desktop/project` | `Desktop\project` (or `%USERPROFILE%\project` if the Desktop is kept in OneDrive) |
| Where `cchat` works | any Terminal window | the **Ubuntu** window (Start menu → Ubuntu) |
| Starts by itself at login | a LaunchAgent (`com.juslangit.claude-chat`) | a Task Scheduler task called `claude-chat` |
| The server's log | `~/Desktop/project/claude-chat/data/server.log` | `~/.claude-chat/data/server.log`, in the Ubuntu window |
| Restart the server after changing code | `launchctl kickstart -k gui/$(id -u)/com.juslangit.claude-chat` | `pkill -f "node server.mjs"` in the Ubuntu window — it comes back by itself in a couple of seconds |

## Files

| File | What it does |
|---|---|
| `server.mjs` | The middleman on each computer. Starts chats, sends your messages in, sends replies out. |
| `hook.mjs` | Claude Code runs this on events; it forwards them and carries back approvals. |
| `notes.mjs` | Reads Claude's progress notes off the chat's screen, so the phone can show them while it works. |
| `push.mjs` | Sends notifications to the iPhone: encrypts them for the phone and signs them, with Node's own crypto. |
| `accounts.mjs` | Switching between Claude accounts (e.g. Pro and Max) from the phone. |
| `public/` | The phone app — `index.html` (layout), `style.css` (look), `app.js` (behaviour), `sw.js` (shows notifications). |
| `bin/cchat` | Type `cchat` on the computer to start a chat that also shows on the phone. `cchat send <file>` shows a file on the phone from inside a chat — this is what Claude uses to send you a render. |
| `tmux.conf` | Makes the tmux windows look like a plain Terminal. |
| `install.sh` | One-time setup on the first Mac (start at login, `cchat` command, Tailscale). Safe to re-run. |
| `setup/` | One-line setup for another Mac (`mac.sh`) or a Windows PC (`windows.ps1`, which runs `wsl.sh` inside WSL), downloaded from the first Mac. |
| `data/` | Created when it runs: list of chats, the hook password, the log. Not in git. |
| `dev/checks/` | The automated checks — see "Checking a change" below. |
| `dev/` | Tools for working on it: `reach.mjs` (reach a computer the way the phone does), `update-computer.mjs` (pull and restart another computer), `stage.mjs` / `shot.mjs` (a read-only copy of the page on port 4478, and screenshots), `video-frames.mjs` (stills out of a reference video). |

## Everyday use

| I want to… | Do this |
|---|---|
| Start a chat from the phone | Tap **+**, pick the computer, then pick a project |
| Start a chat on the computer that shows on the phone | `cchat` or `cchat my chat name` — run inside a project folder and the chat starts in that project (on Windows, in the Ubuntu window) |
| Keep a chat private to the computer | Plain `claude`, as before |
| Stop Claude mid-answer | Red **■** button (same as pressing Esc) |
| Run a Claude Code command (`/usage`, `/model`, `/context`…) | The **⌘** button at the top of a chat; what the computer's window shows comes back as a card |
| See how full a chat is, and free it up | The line under the chat's name, once it's half full. Tap it to compact — Claude keeps a summary and lets go of the rest |
| Rename a chat, end it, or open its window on the computer | Tap the chat's name at the top (Chat info) → **Open on Mac** / **Open on PC** |
| Talk instead of typing | Hold 🎤, talk, let go. Slide left to cancel |
| Have a voice call with Claude | Tap 📞 at the top of the chat; the red button hangs up |
| Send a common reply in one tap | The buttons above the typing bar ("Yes, go ahead", "Explain simpler"…) |
| Turn the reply sound off | ⋯ on the Chats screen → Reply sound |
| Send Claude a photo | **+** next to the typing box → pick or take one, add a caption if you like, send |
| Get a render, screenshot or file **from** Claude | Ask for it. Claude runs `cchat send <file> "caption"` and it appears in the chat; just naming a file's path in its reply shows it too |
| Reply to one particular message | Swipe it to the right — it's quoted above the typing box |
| Pin, archive, rename or delete chats | Hold a chat in the list for its menu. Archived chats sit behind the **Archived** row at the top and stop notifying you; **Delete** stops Claude and removes the conversation and its photos |
| Clear out everything that has stopped | ⚙ Settings → **Delete stopped chats** (it says how many and asks first) |
| Find something in a chat | Chat info → **Search**; the arrows jump between matches |
| Get a notification when Claude finishes or needs you | ⋯ → **Notifications** (Home Screen app only — see below) |
| Bring back a stopped chat (e.g. after a restart) | Open it, tap **Resume on the computer** |
| See the server's log, or restart it | See [Mac and Windows side by side](#mac-and-windows-side-by-side) |

Running chats are not affected by restarting the server — they live in tmux.

## Checking a change

```bash
node dev/checks/run.mjs            # every suite, one after another (about 18 minutes)
node dev/checks/run.mjs --quick    # only the ones that don't need Claude to answer
node dev/checks/run.mjs archive    # just one, by name
node dev/checks/screenshots.mjs    # iPhone-size pictures of every screen, light and dark
```

| Suite | What it covers | Checks |
|---|---|---|
| `commands` | Claude Code's own commands from the phone, the result cards, menus, the risky ones | 31 |
| `archive` | archiving and unarchiving, staying quiet while archived, deleting the stopped ones | 27 |
| `features` | photos, pins, search in a chat, swipe to reply, notifications end to end | 43 |
| `fixes` | reconnecting, "offline since", the Host and Origin checks, stuck "typing…" | 47 |

Each suite starts **its own** claude-chat on port 4479 — its own data folder, its own tmux server, its own
`.env` file, and Haiku as the model — so none of it touches the app you actually use. They run one at a
time because they share that port. Whatever they leave behind sits in `dev/checks/.work/`, which git
ignores. Some of them let Claude answer for real, so they use a little of your weekly limit; `--quick`
skips those.

Two helpers for the computers themselves:

```bash
node dev/reach.mjs luqman-mac GET /api/whoami     # reach a computer exactly as the phone does
node dev/update-computer.mjs desktop-k2m7l30      # have that computer pull and restart itself
```

## Notifications

The iPhone only allows notifications for apps on the Home Screen (iOS 16.4 or later). Open Claude Chats
from the Home Screen, then ⋯ → **Notifications** → Allow; a test one arrives straight away. From then on,
every computer — Mac or PC — sends one when Claude finishes a reply or needs you (a question or an
approval) — but not while you have the app open in front of you. Tap one to open that chat.

They travel through Apple's push service, encrypted so only your iPhone can read them. The key that signs
them is `CLAUDE_CHAT_VAPID_PUBLIC` / `CLAUDE_CHAT_VAPID_PRIVATE` in `~/.claude/.env`: made the first time
you turn notifications on, and copied to your other computers by Syncthing.

## Setting it up

### The first computer: a Mac (already done on Luqman's Mac)

The first computer has to be a Mac for now — the other computers download their setup from it.

1. `brew install tmux tailscale`
2. Tailscale runs as a login item in userspace mode (`~/Library/LaunchAgents/com.juslangit.tailscaled.plist`)
   and is signed in once.
3. `./install.sh`
4. On the iPhone: install **Tailscale** from the App Store, sign in with the same account, open the
   address `install.sh` printed, then Share → **Add to Home Screen**.

### More computers: another Mac or a Windows PC

The iPhone app shows the chats of every computer running claude-chat on your Tailscale network, each
labelled with its computer, and **+** asks which computer to start on (⋯ → Computers lists them).
To add a computer:

1. Install Tailscale on it and sign in with the same account as your iPhone
   (Windows: [tailscale.com/download/windows](https://tailscale.com/download/windows)).
2. On the iPhone: Chats → ⋯ → Computers → **Add a computer**. It shows the line to paste and a
   one-time pairing code (works once, for 30 minutes).
3. Paste the line on the new computer — it installs everything (Claude Code included), copies your
   projects from GitHub, and asks for the code:
   - **another Mac**, in Terminal: `curl -fsSL https://luqman-mac.tail8806f8.ts.net/setup/mac | bash`
   - **a Windows PC**, in PowerShell: `irm https://luqman-mac.tail8806f8.ts.net/setup/windows | iex`
     - The first time, it installs Ubuntu (WSL) and asks you to **restart the PC**. After the restart,
       Ubuntu opens by itself and asks you to pick a Linux username and password — then paste the same
       line again and it carries on.
     - It asks for that Linux password once more while it installs the Linux tools, and opens your
       browser once to sign in to GitHub.
4. Log in to Claude Code there once and trust the project folder, as the script says at the end:
   - Mac, in Terminal: `cd ~/Desktop/project && claude`
   - Windows, in the **Ubuntu** window (Start menu → Ubuntu): the `cd … && claude` line the script
     prints, which points at your `Desktop\project` folder

   Log in, choose "Yes, I trust this folder", then type `/exit`.

Projects move between computers through **GitHub**: when a chat starts in a project, the app first
fetches the newest version (as long as nothing is unsaved on that computer). When you stop on one
computer, ask Claude to save your work to GitHub. Your Claude setup — instructions (`CLAUDE.md`),
settings, keys (`.env`), the Sky AI Brain memory tool and your notes — stays the same everywhere
through **Syncthing**. Only those parts of `~/.claude` are shared (the list is in `~/.claude/.stignore`);
chat history stays on each computer.

## Can someone else use it?

**Not yet.** It works well on Luqman's own computers, but it was built for one person, and these stop
anyone else from using it today:

1. **They can't download it.** The code is in a private GitHub repository (`juslangit/claude-chat`).
2. **They'd need a Mac to start.** A Windows PC can only *join* a Mac that already runs claude-chat — its
   setup line is downloaded from that Mac. Someone with only a Windows PC has no way in.
3. **Adding a computer copies your whole Claude setup onto it** — your instructions, settings, keys and
   notes. That's right for your own computers, and must never happen on someone else's.
4. **Every chat is tied to Sky AI Brain.** Chats switch Claude Code's own memory off and tell Claude to
   save memories with `mem` into your Supabase. Someone else has no `mem`, so their chats would
   remember nothing.
5. **Chats skip the permission questions** (bypass permissions). The safety net is the deny list in
   *your* `~/.claude/settings.json`; someone else's may have none.
6. **Some messages say "Luqman"** — e.g. "Luqman denied this from his phone."
7. **Still in testing.** iPhone notifications haven't been tried for real yet, and it has only been
   used on an iPhone (the voice features rely on the iPhone's own speech).

Once these are fixed, this section becomes a step-by-step guide for a new person, starting from
installing Claude Code on their own Mac or PC.

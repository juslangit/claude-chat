# claude-chat

Use Claude Code on your computer at home — a **Mac or a Windows PC** — from your iPhone, like WhatsApp.

> **Status: early.** Built by one person for their own Mac, Windows PC and iPhone, and open for anyone to
> try. It's free: it runs Claude Code on your own computer, on your own Claude plan. Nothing goes through
> anyone else's server. Jump to **[Install it](#install-it)**.

## What you need

| | |
|---|---|
| **A computer** | A Mac, or a Windows 10/11 PC (Windows 10 also needs **Windows Terminal** from the Microsoft Store). You can have several — the phone shows the chats of all of them. |
| **A Claude plan** | **Pro** or **Max**, for Claude Code. |
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
- When Claude wants to run a command, the phone shows **Approve / Deny** (and the computer's window shows
  its usual prompt at the same time; either can answer). File edits go ahead without asking. You can
  change how much it asks — see [Permissions and memory](#permissions-and-memory).
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
  listens again. Speech uses the iPhone's own recognition and voice — works in Safari and the Home
  Screen app.
- While Claude works, the "typing…" bubble shows its latest progress note and step. Steps read in
  plain English ("Edited style.css"), with the raw command in small print underneath.

## Install it

About 20 minutes, once per computer. You'll paste a few lines into Terminal (Mac) or PowerShell (Windows);
each one is shown in full below.

### Step 1 — Claude Code

You need a Claude **Pro** or **Max** plan ([claude.ai](https://claude.ai) → Upgrade).

- **Mac:** open **Terminal** (press ⌘ Space, type *Terminal*, press Enter) and paste:

  ```bash
  curl -fsSL https://claude.ai/install.sh | bash
  ```

  Then start it once and log in with your Claude account:

  ```bash
  ~/.local/bin/claude
  ```

  Follow what it says on screen: pick a colour theme, choose to log in with your Claude account, and
  finish logging in in the browser window it opens. When it's ready for you to type, type `/exit`.

- **Windows:** nothing to do yet. claude-chat needs Claude Code to run inside Ubuntu (WSL), and the setup
  in step 3 installs it there for you. If you already use Claude Code on Windows, that copy keeps working;
  you'll just log in once more inside Ubuntu, in step 4.

### Step 2 — Tailscale, on the computer and the iPhone

Tailscale is a free private network made of your own devices, so only your iPhone can reach claude-chat —
nobody else on the internet can.

1. On the **computer**, install Tailscale — Mac: from the **App Store**; Windows:
   [tailscale.com/download/windows](https://tailscale.com/download/windows) — and sign in. Signing in
   with Google, Microsoft, GitHub or Apple is fine.
2. On the **iPhone**, install **Tailscale** from the App Store, sign in with the **same account**, and
   switch it on.

### Step 3 — Set up claude-chat

- **Mac**, in Terminal:

  ```bash
  curl -fsSL https://raw.githubusercontent.com/juslangit/claude-chat/main/setup/mac.sh | bash
  ```

  It installs Homebrew (asks for your Mac password, which doesn't show as you type — that's normal),
  then tmux, Node, Syncthing and claude-chat itself, and sets it to start whenever you log in. If your Mac
  asks whether Node or tmux may use files in your Desktop folder, click **Allow**.

- **Windows**, in PowerShell (Start menu → type *PowerShell* → open it; no need for administrator):

  ```powershell
  irm https://raw.githubusercontent.com/juslangit/claude-chat/main/setup/windows.ps1 | iex
  ```

  The first time, it installs Ubuntu (WSL): Windows asks for permission, then you **restart the PC**.
  After the restart, an Ubuntu window opens by itself and asks you to pick a Linux username and password
  (they can be anything — just remember the password). Then open PowerShell again and **paste the same
  line again**. This time it carries on: it asks for that Linux password while it installs tools, then
  installs Claude Code and claude-chat inside Ubuntu, and sets it to start whenever you log in.

**Both:** the first time, Tailscale may print a link to switch on HTTPS for your network. Open it, press
**Enable**, and the setup carries on by itself.

### Step 4 — Log in to Claude Code there, and trust your project folder

The setup ends by showing you one line to paste — on a Mac, in Terminal:

```bash
cd ~/Desktop/project && ~/.local/bin/claude
```

On Windows, open **Ubuntu** from the Start menu and paste the line the setup showed (it goes to your
`Desktop\project` folder). Log in if it asks, choose **Yes, I trust this folder**, then type `/exit`.
This only happens once.

### Step 5 — Open it on the iPhone

1. The setup's last line is your computer's address, like `https://my-mac.tail1234.ts.net`. Open it in
   **Safari** on the iPhone (with Tailscale switched on).
2. Tap **Share → Add to Home Screen**. From now on, open it from your Home Screen — it's called **Claude Mac** or **Claude PC**, after the computer.
3. Tap **+**, choose **Whole project folder**, and ask Claude for something — "make me a small web page
   about cats" is a good first try. The new project appears in `Desktop/project` on your computer.

That's it. Two optional extras: [notifications](#notifications) and
[more than one computer](#more-than-one-computer).

**If something goes wrong:** run the same setup line again — it's safe, and it skips what's already done.
The server's log (see [Mac and Windows side by side](#mac-and-windows-side-by-side)) says what happened.

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
| Send to a computer that's off | Just send it — it waits on the phone with a clock, and goes by itself when that computer is back. Tap it to throw it away |
| Have a voice call with Claude | Tap 📞 at the top of the chat; the red button hangs up |
| Send a common reply in one tap | The buttons above the typing bar ("Yes, go ahead", "Explain simpler"…) |
| Turn the reply sound off | ⋯ on the Chats screen → Reply sound |
| Send Claude a photo | **+** next to the typing box → pick or take one, add a caption if you like, send |
| Get a render, screenshot or file **from** Claude | Ask for it. Claude runs `cchat send <file> "caption"` and it appears in the chat; just naming a file's path in its reply shows it too |
| Reply to one particular message | Swipe it to the right — it's quoted above the typing box |
| Pin, archive, rename or delete chats | Hold a chat in the list for its menu. Archived chats sit behind the **Archived** row at the top and stop notifying you; **Delete** stops Claude and removes the conversation and its photos. Pins and unread counts are kept on the computers, so every link shows the same |
| Go to another computer's own app | ⚙ Settings → your face (top right) → tap that computer. The first time, add its page to your Home Screen — it's called **Claude PC** or **Claude Mac** |
| Clear out everything that has stopped | ⚙ Settings → **Delete stopped chats** (it says how many and asks first) |
| Find something in a chat | Chat info → **Search**; the arrows jump between matches |
| Switch between two Claude accounts (e.g. Pro and Max) | ⚙ Settings → the round button at the top right. Adding a second account is done from the phone too |
| Get a notification when Claude finishes or needs you | ⋯ → **Notifications** (Home Screen app only — see below) |
| Bring back a stopped chat (e.g. after a restart) | Open it, tap **Resume on the computer** |
| See the server's log, or restart it | See [Mac and Windows side by side](#mac-and-windows-side-by-side) |

Running chats are not affected by restarting the server — they live in tmux.

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

## Permissions and memory

**How much chats ask** follows Claude Code's own setting on that computer — `permissions.defaultMode` in
`~/.claude/settings.json` (on Windows, the one inside Ubuntu). With nothing set, as after a fresh install,
file edits go ahead and every command waits for **Approve** on the phone (`acceptEdits`). To have chats
just run, the way plain `claude` does with the same setting, add this to that file:

```json
{
  "permissions": {
    "defaultMode": "bypassPermissions",
    "deny": ["Bash(sudo*)", "Bash(rm -rf*)", "Bash(git push --force*)"]
  }
}
```

The `deny` list still blocks what's on it, even then. The first time you use bypass mode, run plain
`claude` once in a Terminal and accept its warning, so new chats don't stop on it. The change applies to
chats started after it.

**Memory:** chats use Claude Code's own memory, as usual. The exception is a computer that has the `mem`
tool (`~/.local/bin/mem`, from Luqman's Sky AI Brain): there, chats turn Claude Code's memory off and are
told to save with `mem remember` instead.

## Notifications

The iPhone only allows notifications for apps on the Home Screen (iOS 16.4 or later). Open the app (**Claude Mac** or
**Claude PC**) from the Home Screen, then ⋯ → **Notifications** → Allow; a test one arrives straight away. From then on,
every computer — Mac or PC — sends one when Claude finishes a reply or needs you (a question or an
approval) — but not while you have the app open in front of you. Tap one to open that chat. Each computer's own app asks for
notifications separately.

They travel through Apple's push service, encrypted so only your iPhone can read them. The key that signs
them is `CLAUDE_CHAT_VAPID_PUBLIC` / `CLAUDE_CHAT_VAPID_PRIVATE` in `~/.claude/.env`: made the first time
you turn notifications on, and copied to your other computers by Syncthing.

## More than one computer

The iPhone app shows the chats of every computer running claude-chat on your Tailscale network, each
labelled with its computer, and **+** asks which computer to start on (⋯ → Computers lists them).
Your first computer is set up as in [Install it](#install-it). To add another Mac or Windows PC:

1. Install Tailscale on it and sign in with the same account as your iPhone.
2. On the iPhone: Chats → ⋯ → Computers → **Add a computer**. It shows the line to paste and a
   one-time pairing code (works once, for 30 minutes).
3. Paste the line on the new computer — Terminal on a Mac, PowerShell on Windows. It's like the one in
   step 3 of the install, but downloaded from your first computer, so it also copies your projects from
   GitHub (it opens your browser once to sign in to GitHub) and asks for the code.
4. Log in to Claude Code there once and trust the project folder, as in step 4.

Projects move between computers through **GitHub**: when a chat starts in a project, the app first
fetches the newest version (as long as nothing is unsaved on that computer). When you stop on one
computer, ask Claude to save your work to GitHub. Your Claude setup — instructions (`CLAUDE.md`),
settings, keys (`.env`) and notes — stays the same everywhere through **Syncthing**, peer to peer and
encrypted, which is why adding a computer needs the code from your phone. Only those parts of `~/.claude`
are shared (the list is in `~/.claude/.stignore`); chat history stays on each computer.

## Updating and removing

**Update** to the newest claude-chat:

- Mac, in Terminal: `cd ~/Desktop/project/claude-chat && git pull && ./install.sh`
- Windows, in the Ubuntu window: `cd ~/Desktop/project/claude-chat && git pull && pkill -f "node server.mjs"`

An open phone app notices and reloads itself.

**Remove** it (your projects and chats' history stay where they are):

- Mac, in Terminal:
  `launchctl bootout gui/$(id -u)/com.juslangit.claude-chat; rm ~/Library/LaunchAgents/com.juslangit.claude-chat.plist ~/.local/bin/cchat`
- Windows, in PowerShell: `Unregister-ScheduledTask claude-chat -Confirm:$false`, then restart the PC
- Both: `tailscale serve reset` stops publishing it (on Windows, in PowerShell:
  `& "C:\Program Files\Tailscale\tailscale.exe" serve reset`). Then delete the `claude-chat` folder in
  your project folder.

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
  so nobody else can reach the app. Each computer's server also refuses any request that wasn't sent to
  its own name on your Tailscale network, so a website open on the phone or the computer can't reach it.

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
| `install.sh` | The Mac's part of the setup (start at login, `cchat` command, Tailscale). Safe to re-run. |
| `setup/` | The one-line setups: `mac.sh`, and `windows.ps1`, which runs `wsl.sh` inside WSL. Downloaded from GitHub for your first computer, or from that computer when you add another. |
| `data/` | Created when it runs: list of chats, the hook password, the log. Not in git. |
| `dev/checks/` | The automated checks — see "Checking a change" below. |
| `dev/` | Tools for working on it: `reach.mjs` (reach a computer the way the phone does), `update-computer.mjs` (pull and restart another computer), `stage.mjs` / `shot.mjs` (a read-only copy of the page on port 4478, and screenshots), `video-frames.mjs` (stills out of a reference video). |

## Checking a change

```bash
node dev/checks/run.mjs            # every suite, one after another (about 20 minutes)
node dev/checks/run.mjs --quick    # only the ones that don't need Claude to answer
node dev/checks/run.mjs setup      # just one, by name
node dev/checks/screenshots.mjs    # iPhone-size pictures of every screen, light and dark
```

| Suite | What it covers | Checks |
|---|---|---|
| `commands` | Claude Code's own commands from the phone, the result cards, menus, the risky ones | 31 |
| `archive` | archiving and unarchiving, staying quiet while archived, deleting the stopped ones | 62 |
| `links` | each computer's own link from Settings, and pins and read marks kept on the computers | 30 |
| `accounts` | which Claude account a chat runs as, adding and switching | 40 |
| `setup` | a new person's computer (permission mode, memory, first pairing), and the Mac and Linux setup scripts run in a sandbox | 38 |
| `files` | files coming back from Claude to the phone | 22 |
| `context` | how full a chat is, and compacting | 12 |
| `features` | photos, pins, search in a chat, swipe to reply, notifications end to end | 43 |
| `fixes` | reconnecting, "offline since", the Host and Origin checks, stuck "typing…" | 47 |

Each suite starts **its own** claude-chat on port 4479 — its own data folder, its own tmux server, its own
`.env` file, and Haiku as the model — so none of it touches the app you actually use. They run one at a
time because they share that port. Whatever they leave behind sits in `dev/checks/.work/`, which git
ignores. Some of them let Claude answer for real, so they use a little of your weekly limit; `--quick`
skips those. The Windows half of the setup (`windows.ps1`) can only be tried on a real PC.

Two helpers for the computers themselves:

```bash
node dev/reach.mjs luqman-mac GET /api/whoami     # reach a computer exactly as the phone does
node dev/update-computer.mjs desktop-k2m7l30      # have that computer pull and restart itself
```

// claude-chat — use Claude Code on this Mac from a phone, like a chat app.
//
// How the pieces fit:
//
//   phone (web page) <── live updates ──  server.mjs  ── tmux ──>  claude   (one per chat)
//                    ─── messages ──────>      ▲                     │
//                                              ├── hook.mjs  <───────┤   Claude Code hooks: status + permission requests
//                                              └── transcript.jsonl <┘   everything that was said
//
// Every chat is a tmux session running the normal interactive `claude`. tmux is what lets the
// same session show in a Terminal window on the Mac AND be typed into from the phone.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { notesFromScreen, noteKey } from "./notes.mjs";
import * as push from "./push.mjs";
import * as accounts from "./accounts.mjs";

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url)); // decoded, so folder names with spaces work ("TODAK ACADEMY")
const HOME = os.homedir();
const PORT = Number(process.env.PORT || 4477);
const WORKDIR = process.env.CLAUDE_CHAT_WORKDIR || path.join(HOME, "Desktop/project");
const CLAUDE = process.env.CLAUDE_BIN || path.join(HOME, ".local/bin/claude");
const TMUX = process.env.TMUX_BIN || ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => fs.existsSync(p)) || "tmux";
const DATA = process.env.CLAUDE_CHAT_DATA || path.join(ROOT, "data");
const SOCKET = process.env.CLAUDE_CHAT_SOCKET || "claude-chat"; // the tmux server's name; a test copy uses another
// Windows runs claude-chat inside WSL (Windows' built-in Linux), with the projects in the normal Windows folder.
const IS_WSL = os.release().toLowerCase().includes("microsoft");
const OS = process.platform === "darwin" ? "mac" : IS_WSL ? "windows" : "linux";
const CHATS_FILE = path.join(DATA, "chats.json");
const SECRET_FILE = path.join(DATA, "secret");
const HOOKS_FILE = path.join(DATA, "hooks.json");
const TERM_DIR = path.join(DATA, "terminal");
const PHOTO_DIR = path.join(DATA, "photos");  // photos sent from the phone, one folder per chat
const PUSH_FILE = path.join(DATA, "push.json"); // the phone's push addresses
const ACCOUNTS_FILE = path.join(DATA, "accounts.json"); // only which Claude account this computer uses
// The notification signing key is kept with your other keys, which Syncthing shares (push.mjs).
const ENV_FILE = process.env.CLAUDE_CHAT_ENV_FILE || path.join(HOME, ".claude/.env");
// How much Claude can hold in mind at once. Every current model is 200k tokens; a long chat creeping
// towards it is what makes sessions expensive, so the phone shows it and offers to compact.
const CONTEXT_LIMIT = Number(process.env.CLAUDE_CHAT_CONTEXT_LIMIT || 200000);
// The permission hook is allowed 30 minutes; give up a little before Claude Code does.
const APPROVAL_WAIT_MS = 29 * 60 * 1000;

fs.mkdirSync(TERM_DIR, { recursive: true });

// The log only ever grows (launchd on a Mac and start.sh on a PC add to it). Past 5 MB, keep its last
// 1 MB. Both open it in append mode, so they carry on writing at the new end.
const LOG_FILE = path.join(DATA, "server.log");
function trimLog() {
  try {
    const size = fs.statSync(LOG_FILE).size;
    if (size < 5e6) return;
    const tail = Buffer.alloc(1e6), fd = fs.openSync(LOG_FILE, "r");
    fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    fs.closeSync(fd);
    fs.truncateSync(LOG_FILE, 0);
    fs.appendFileSync(LOG_FILE, tail.subarray(tail.indexOf(10) + 1)); // from the first whole line
  } catch {}
}
trimLog();
setInterval(trimLog, 60 * 60 * 1000);

// A random password shared only with hook.mjs, so nothing else can pretend to be Claude Code.
if (!fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(24).toString("hex"), { mode: 0o600 });
const SECRET = fs.readFileSync(SECRET_FILE, "utf8").trim();

// Hooks given to every chat's claude via --settings. They add to your own hooks, they don't replace them.
// Homebrew's stable node path, so running chats survive a Node update.
const NODE = fs.existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath;
const hook = (timeout) => [{ matcher: "", hooks: [{ type: "command", command: `"${NODE}" "${path.join(ROOT, "hook.mjs")}"`, timeout }] }];
fs.writeFileSync(HOOKS_FILE, JSON.stringify({
  hooks: { PermissionRequest: hook(1800), SessionStart: hook(10), UserPromptSubmit: hook(10), Stop: hook(10), Notification: hook(10) },
}, null, 2));

// ── helpers ────────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const tmux = async (...args) => (await run(TMUX, ["-L", SOCKET, "-f", path.join(ROOT, "tmux.conf"), ...args], { encoding: "utf8" })).stdout;
const until = async (check, ms, every = 250) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) if (await check()) return true;
  return false;
};
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
// Claude Code files each session under the folder it was started in.
const transcriptPath = (sessionId, cwd = WORKDIR) => path.join(HOME, ".claude/projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);

// ── chats ──────────────────────────────────────────────────────────────────────────────────

// Saved to disk: which chats exist. { id, sessionId, name, autoName, tmux, cwd, transcript, createdAt }
// cwd is the folder claude runs in; chats from before it existed have none and use WORKDIR.
let chats = {};
try { chats = JSON.parse(fs.readFileSync(CHATS_FILE, "utf8")); }
catch (e) {
  // A list that can't be read is put aside rather than overwritten, so it can still be recovered by hand.
  if (e.code !== "ENOENT") {
    const aside = `${CHATS_FILE}.unreadable-${Date.now()}`;
    try { fs.renameSync(CHATS_FILE, aside); } catch {}
    console.error(`chats.json couldn't be read (${e.message}), so it was kept as ${path.basename(aside)} and the list starts empty`);
  }
}
let saveTimer;
// Written to a spare file first and then swapped in, so a power cut in the middle of a save leaves the
// old list whole instead of half a file.
function writeChats() {
  saveTimer = null;
  try {
    fs.writeFileSync(`${CHATS_FILE}.tmp`, JSON.stringify(chats, null, 2));
    fs.renameSync(`${CHATS_FILE}.tmp`, CHATS_FILE);
  } catch (e) { console.error("couldn't save the chat list:", e.message); }
}
// A save waits 200 ms in case more changes are coming. Anything still waiting is written out when the
// server is asked to stop, so a chat ended a moment before a restart doesn't come back afterwards.
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(writeChats, 200); };
const saveNow = () => saveTimer && writeChats();
process.on("exit", saveNow);
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => { saveNow(); process.exit(0); });

// ── which Claude account new chats run as ──────────────────────────────────────────────────

// The accounts themselves live in ~/.claude/.env (accounts.mjs); all this computer keeps is which
// one it starts new chats with. An account whose token has since been taken out of .env falls back
// to the signed-in one rather than starting chats that can't authenticate.
let currentAccount = "signed-in";
try { currentAccount = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8")).current || currentAccount; } catch {}
// Every chat's summary names its account, so the answer is kept for a few seconds rather than
// re-reading two files each time the list is sent to the phone.
let knownAccounts = { at: 0, list: [] };
function allAccounts() {
  if (Date.now() - knownAccounts.at > 5000) knownAccounts = { at: Date.now(), list: accounts.allAccounts(ENV_FILE, HOME) };
  return knownAccounts.list;
}
function accountList() {
  const list = allAccounts();
  if (!list.some((a) => a.id === currentAccount)) currentAccount = list[0]?.id || "signed-in";
  return { accounts: list, current: currentAccount };
}
function useAccount(id) {
  knownAccounts.at = 0;
  if (!allAccounts().some((a) => a.id === id)) throw fail("That account isn't set up on this computer.");
  currentAccount = id;
  try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ current: id }, null, 2)); }
  catch (e) { console.error("couldn't save the chosen account:", e.message); }
  return accountList();
}
const accountLabel = (id) => allAccounts().find((a) => a.id === id)?.label || null;

// Adding an account means running `claude setup-token` on this computer: it prints a claude.com link,
// waits for the code that link gives back, and answers with a token that lasts a year. All three
// steps are driven from the phone — the link is tapped there, the code is pasted there — so the only
// thing that has to happen at a computer is nothing at all.
const LOGIN_SESSION = "cc-account-login";
let adding = null; // { label, plan, startedAt, url, state, error, account }

const loginRunning = async () => !!(await tmux("has-session", "-t", LOGIN_SESSION).then(() => true).catch(() => false));
const loginScreen = () => tmux("capture-pane", "-p", "-J", "-t", LOGIN_SESSION).catch(() => "");

async function stopAdding() {
  await tmux("kill-session", "-t", LOGIN_SESSION).catch(() => {});
  adding = null;
}

async function startAdding({ label, plan }) {
  if (adding?.state === "waiting" || adding?.state === "starting") throw fail("You're already adding an account.");
  label = String(label || "").trim().slice(0, 40);
  if (!label) throw fail("Give the account a name, so you can tell the two apart.");
  await tmux("kill-session", "-t", LOGIN_SESSION).catch(() => {});
  adding = { label, plan: plan || null, startedAt: Date.now(), url: null, state: "starting", error: null, account: null };
  await tmux("new-session", "-d", "-s", LOGIN_SESSION, "-c", HOME, "-x", "120", "-y", "40",
    ...(IS_WSL ? ["-e", `PATH=${WSL_PATH}`] : []), `${shq(CLAUDE)} setup-token`);
  return addingState();
}

// Reads the sign-in screen: the link while it's waiting, the token once it's there.
async function addingState() {
  if (!adding) return { adding: false };
  if (adding.state === "starting" || adding.state === "waiting") {
    const screen = await loginScreen();
    adding.url ||= screen.match(/https:\/\/claude\.com\/\S+/)?.[0] || null;
    const token = screen.match(/sk-ant-oat[\w-]+/)?.[0];
    if (token) {
      adding.state = "saving";
      try {
        // The token may not be allowed to read the profile, in which case what was typed on the
        // phone stands. When it is allowed, the real name, email and plan win.
        const real = await accounts.fetchProfile(token);
        const id = accounts.addAccount(ENV_FILE, {
          label: adding.label, plan: real?.plan || adding.plan, email: real?.email || null, token,
        });
        knownAccounts.at = 0;
        adding.account = allAccounts().find((a) => a.id === id) || null;
        adding.state = "added";
        useAccount(id); // switching is the whole point of adding one
      } catch (e) {
        adding.state = "failed";
        adding.error = e.message;
      }
      await tmux("kill-session", "-t", LOGIN_SESSION).catch(() => {});
    } else if (adding.url) adding.state = "waiting";
    else if (!(await loginRunning())) { adding.state = "failed"; adding.error = "Claude stopped before it gave a link. Is it installed on this computer?"; }
    else if (Date.now() - adding.startedAt > 15 * 60 * 1000) { adding.state = "failed"; adding.error = "Nothing came back for fifteen minutes."; await stopAdding(); }
  }
  return { adding: true, label: adding.label, state: adding.state, url: adding.url, error: adding.error, account: adding.account };
}

// The code claude.com hands back after signing in, typed into the waiting prompt.
async function sendLoginCode(code) {
  code = String(code || "").trim();
  if (!/^[\w#.=/+-]{4,400}$/.test(code)) throw fail("That doesn't look like the code from the sign-in page.");
  if (!(await loginRunning())) throw fail("The sign-in isn't running any more. Start it again.");
  await tmux("send-keys", "-t", LOGIN_SESSION, "-l", code);
  await tmux("send-keys", "-t", LOGIN_SESSION, "Enter");
  return addingState();
}

// Only in memory: what is happening in each chat right now.
const runtime = {};
const rt = (id) => (runtime[id] ||= { messages: [], offset: 0, count: 0, status: "idle", alive: false, pending: null, lastText: "", lastAt: 0 });

function summary(c) {
  const r = rt(c.id);
  return {
    id: c.id, name: c.name, createdAt: c.createdAt, alive: r.alive, archived: !!c.archived,
    project: c.cwd && c.cwd !== WORKDIR ? path.basename(c.cwd) : null,
    status: r.alive ? r.status : "ended",
    lastText: r.lastText, lastAt: r.lastAt || c.createdAt, count: r.count,
    note: r.status === "working" || r.status === "approval" ? r.note || null : null, // Claude's latest progress note
    context: { used: r.tokens || 0, limit: CONTEXT_LIMIT }, // how full Claude's memory is in this chat
    account: c.account ? accountLabel(c.account) : null, // the Claude account it was started on
    pending: r.pending && { reqId: r.pending.reqId, tool: r.pending.tool, detail: r.pending.detail, why: r.pending.why, questions: r.pending.questions },
  };
}

// ── live updates to the phone (Server-Sent Events) ─────────────────────────────────────────

const clients = new Set();
const broadcast = (event) => { const line = `data: ${JSON.stringify(event)}\n\n`; for (const res of clients) res.write(line); };
function chatChanged(id) {
  if (!chats[id]) return;
  broadcast({ type: "chat", chat: summary(chats[id]) });
  watchTurn(id);
}
// A ping every 20 seconds the phone can see, so it can tell a connection that died without saying so.
setInterval(() => { for (const res of clients) res.write("event: ping\ndata: {}\n\n"); }, 20000);

// ── reading what was said, from Claude Code's transcript file ──────────────────────────────

// A step Claude took, in plain English ("Edited style.css"), plus the raw command or path
// underneath for anyone who wants the detail.
function describeTool(name, input = {}) {
  const rel = (p) => (p?.startsWith(WORKDIR + "/") ? p.slice(WORKDIR.length + 1) : p?.startsWith(HOME + "/") ? `~${p.slice(HOME.length)}` : p) || "";
  const file = input.file_path || input.notebook_path;
  const base = path.basename(file || "") || "a file";
  const host = (u) => { try { return new URL(u).hostname; } catch { return u || "a web page"; } };
  switch (name) {
    case "Bash": return { text: input.description || "Ran a command", detail: input.command || "" };
    case "Read": return { text: `Read ${base}`, detail: rel(file) };
    case "Write": return { text: `Wrote ${base}`, detail: rel(file) };
    case "Edit": case "MultiEdit": case "NotebookEdit": return { text: `Edited ${base}`, detail: rel(file) };
    case "Glob": return { text: "Looked for files", detail: input.pattern || "" };
    case "Grep": return { text: `Searched the code for “${input.pattern || ""}”`, detail: rel(input.path) };
    case "WebFetch": return { text: `Opened ${host(input.url)}`, detail: input.url || "" };
    case "WebSearch": return { text: `Searched the web: ${input.query || ""}`, detail: "" };
    case "Agent": case "Task": return { text: `Asked a helper: ${input.description || ""}`, detail: "" };
    case "TodoWrite": return { text: "Updated the to-do list", detail: "" };
    case "AskUserQuestion": return { text: "Asked you a question", detail: "" };
    case "Skill": return { text: `Used the ${input.skill || ""} skill`, detail: "" };
    case "ToolSearch": return { text: "Loaded extra tools", detail: "" };
    default: {
      const mcp = name.match(/^mcp__(.+?)__(.+)$/); // tools from add-ons: mcp__godot__run_project → "godot: run project"
      return { text: mcp ? `${mcp[1]}: ${mcp[2].replace(/_/g, " ")}` : name, detail: "" };
    }
  }
}

// Claude's multiple-choice questions (the AskUserQuestion tool) show as a message from Claude, and
// what you picked — on the phone or at the computer — as your reply.
function questionText(input) {
  return input.questions.map((q) => `**${q.question}**` + (q.options?.length ? `\n${q.options.map((o) => o.label).join(" · ")}` : "")).join("\n\n");
}
function answerText(answers) {
  const all = Object.entries(answers || {});
  return all.length === 1 ? String(all[0][1]) : all.map(([q, a]) => `${q} → ${a}`).join("\n");
}

// One transcript line → zero or more chat bubbles.
function toMessages(o) {
  if (o.isMeta || o.isSidechain || (o.type !== "user" && o.type !== "assistant")) return [];
  const at = Date.parse(o.timestamp) || Date.now();
  const content = o.message?.content;
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  const out = [];
  blocks.forEach((b, i) => {
    const id = `${o.uuid}-${i}`;
    if (b.type === "text" && b.text?.trim()) {
      const text = b.text.trim();
      if (o.type === "assistant") return out.push({ id, role: "assistant", text, at });
      if (o.isCompactSummary) return out.push({ id, role: "system", text: "Conversation compacted", at });
      const cmd = text.match(/<command-name>\/?(.*?)<\/command-name>/);
      if (cmd) return out.push({ id, role: "system", text: `/${cmd[1]}`, at });
      if (text.startsWith("[Request interrupted")) return out.push({ id, role: "system", text: "Stopped", at });
      if (/^<[a-z-]+>/.test(text)) return; // Claude Code's own bookkeeping, not something you typed
      out.push({ id, role: "user", text, at });
    } else if (b.type === "tool_use" && b.name === "AskUserQuestion" && b.input?.questions?.length) {
      out.push({ id, role: "assistant", ask: true, text: questionText(b.input), at });
    } else if (b.type === "tool_use") {
      const step = describeTool(b.name, b.input);
      out.push({ id, role: "tool", text: step.text, ...(step.detail && step.detail !== step.text && { detail: step.detail }), at });
    } else if (b.type === "tool_result" && !b.is_error && o.toolUseResult?.questions && o.toolUseResult?.answers) {
      const text = answerText(o.toolUseResult.answers);
      if (text) out.push({ id, role: "user", text, at });
    } else if (b.type === "tool_result" && b.is_error) {
      const t = typeof b.content === "string" ? b.content : (b.content || []).map((x) => x.text || "").join(" ");
      out.push({ id, role: "tool", error: true, text: t.trim().split("\n")[0].slice(0, 200), at });
    }
  });
  return out;
}

// Read whatever was added to a chat's transcript since last time.
function readTranscript(id) {
  const c = chats[id], r = rt(id);
  if (!c?.transcript) return;
  let size;
  try { size = fs.statSync(c.transcript).size; } catch { return; }
  if (size < r.offset) r.offset = 0; // file was replaced
  if (size === r.offset) return;
  const buf = Buffer.alloc(size - r.offset);
  const fd = fs.openSync(c.transcript, "r");
  fs.readSync(fd, buf, 0, buf.length, r.offset);
  fs.closeSync(fd);
  const end = buf.lastIndexOf(10); // only take complete lines; a half-written one is read next time
  if (end < 0) return;
  r.offset += end + 1;

  const fresh = [];
  for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
    try {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      // Claude Code records what each answer cost. The prompt half of that is how full its memory is.
      const u = o.message?.usage;
      if (u) r.tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      fresh.push(...toMessages(o));
    } catch {}
  }
  if (!fresh.length) return;
  for (const m of fresh) {
    r.messages.push(m);
    r.lastAt = m.at;
    if (m.role === "assistant") { r.count++; r.lastText = m.text; m.files = filesNamedIn(id, m.text); }
    if (m.role === "user") {
      r.lastText = `You: ${m.text}`;
      // An unnamed chat takes its name from the first thing you say in it, like a message preview.
      if (c.autoName) { c.name = m.text.split("\n")[0].slice(0, 40); c.autoName = false; save(); }
    }
  }
  if (r.messages.length > 3000) r.messages.splice(0, r.messages.length - 3000);
  broadcast({ type: "messages", chatId: id, messages: fresh });
  chatChanged(id);
}

function pushSystem(id, text) {
  const m = { id: crypto.randomUUID(), role: "system", text, at: Date.now() };
  rt(id).messages.push(m);
  broadcast({ type: "messages", chatId: id, messages: [m] });
}

// ── files coming back the other way ────────────────────────────────────────────────────────
// The phone can't reach into the computer's disk, so a file only becomes fetchable once this chat has
// pointed at it: either Claude ran `cchat send <file>`, or it named the file in its reply. Each one gets
// a token, and only tokens this chat knows can be fetched — nothing else on the computer is exposed.

const SHOWABLE = /\.(png|jpe?g|gif|webp|heic|svg|pdf|mp4|mov|m4v|webm)$/i;
const KINDS = { png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", heic: "image",
  svg: "image", pdf: "pdf", mp4: "video", mov: "video", m4v: "video", webm: "video" };
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", svg: "image/svg+xml", pdf: "application/pdf", mp4: "video/mp4", mov: "video/quicktime",
  m4v: "video/x-m4v", webm: "video/webm" };
const MAX_SHARE = 60e6; // 60 MB: enough for a render or a short clip, not a whole project

// Remember one file for this chat and describe it for the phone.
function shareFile(id, file) {
  const r = rt(id);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.isFile() || stat.size > MAX_SHARE) return null;
  const ext = path.extname(file).slice(1).toLowerCase();
  const token = crypto.createHash("sha1").update(file).digest("hex").slice(0, 16);
  r.shared ||= new Map();
  r.shared.set(token, file);
  if (r.shared.size > 300) r.shared.delete(r.shared.keys().next().value); // forget the oldest
  return { token, name: path.basename(file), size: stat.size, kind: KINDS[ext] || "file" };
}

// Files Claude named in its reply — "saved it to /Users/…/render.png", or just "public/render.png",
// which is how it usually writes them. A relative one is looked for in the chat's own folder. Only
// pictures, clips and documents count, and only if the file is really there, so ordinary words that
// happen to look like paths are ignored.
function filesNamedIn(id, text) {
  const base = chats[id]?.cwd || WORKDIR;
  const found = [];
  for (const m of String(text).matchAll(/(?:^|[\s"'`(<[])((?:~\/|\/)?[\w.@+-]+(?:\/[\w.@+ -]+)*\.[a-z0-9]{2,4})/gi)) {
    const named = m[1].replace(/[.,;:]$/, "");
    if (!SHOWABLE.test(named) || found.some((f) => f.name === path.basename(named))) continue;
    const file = named.startsWith("~/") ? path.join(HOME, named.slice(2))
      : path.isAbsolute(named) ? named : path.resolve(base, named);
    const shared = shareFile(id, file);
    if (shared) found.push(shared);
    if (found.length === 4) break;
  }
  return found.length ? found : undefined;
}

// What one of Claude Code's own commands showed, as a card in the chat.
function pushCommand(id, command, text, asks) {
  const m = { id: crypto.randomUUID(), role: "command", command, text, asks, at: Date.now() };
  rt(id).messages.push(m);
  broadcast({ type: "messages", chatId: id, messages: [m] });
  return m;
}

// Only running chats can have anything new (a stopped one is read one last time as it stops).
setInterval(() => { for (const id in chats) if (rt(id).alive) readTranscript(id); }, 600);

// Which chats still have a running claude? (tmux session exists)
async function refreshAlive() {
  let names = [];
  try { names = (await tmux("list-sessions", "-F", "#{session_name}")).trim().split("\n"); } catch {} // no tmux server = none running
  for (const c of Object.values(chats)) {
    const r = rt(c.id), alive = names.includes(c.tmux);
    if (r.alive === alive) continue;
    if (!alive) readTranscript(c.id); // Claude's last words before it stopped
    r.alive = alive;
    if (!alive) resolvePending(c.id, null);
    chatChanged(c.id);
  }
}
setInterval(refreshAlive, 3000);

// ── Claude's progress notes, read off the screen while it works (see notes.mjs) ───────────────

// Hooks tell the server when Claude starts and stops working, but a hook can go missing (a server
// restart, hooks broken on a new computer), and then the phone said "typing…" forever. So the screen
// is checked too: Claude Code's footer reads "esc to interrupt" while it works. Claude sitting at its
// ❯ prompt without it for 6 seconds means it has finished, whatever the hooks said.
const QUIET_MS = 6000;
async function pollNotes() {
  for (const c of Object.values(chats)) {
    const r = rt(c.id);
    if (!r.alive) continue;
    if (r.status !== "approval") {
      let visible = "";
      try { visible = (await tmux("capture-pane", "-p", "-t", c.tmux)).trimEnd(); } catch { continue; }
      const busy = /esc to interrupt/.test(visible.slice(-400));
      if (busy) {
        r.quietSince = 0;
        if (r.status === "idle") { r.status = "working"; chatChanged(c.id); }
      } else if (r.status !== "idle" && boxIn(visible) != null) {
        r.quietSince ||= Date.now();
        if (Date.now() - r.quietSince >= QUIET_MS) { r.status = "idle"; r.quietSince = 0; chatChanged(c.id); }
      } else {
        r.quietSince = 0;
      }
    }
    if (r.status !== "working" && r.status !== "approval") continue;
    let screen;
    try { screen = await tmux("capture-pane", "-p", "-J", "-S", "-1000", "-t", c.tmux); } catch { continue; }
    r.noteKeys ||= new Set();
    for (const text of notesFromScreen(screen)) {
      const key = noteKey(text);
      if (!key || r.noteKeys.has(key)) continue;
      r.noteKeys.add(key);
      if (r.noteKeys.size > 500) r.noteKeys.delete(r.noteKeys.values().next().value); // forget the oldest
      r.note = text;
      broadcast({ type: "note", chatId: c.id, text, at: Date.now() });
      chatChanged(c.id);
    }
  }
}
let pollingNotes = false;
setInterval(async () => {
  if (pollingNotes) return;
  pollingNotes = true;
  try { await pollNotes(); } catch (e) { console.error("notes:", e.message); } finally { pollingNotes = false; }
}, 1500);

// ── driving claude inside tmux ─────────────────────────────────────────────────────────────

// Chats run with bypassPermissions, like plain `claude` on this Mac: nothing asks first. The deny
// list in ~/.claude/settings.json (sudo, rm -rf, force-push…) still applies, and anything Claude Code
// asks about anyway still reaches the phone through the PermissionRequest hook.
// On a Windows PC, Claude runs in WSL with start.sh's short Linux PATH, so it couldn't find Windows'
// own tools (PowerShell, cmd, Windows Terminal, winget) without being told where they are. Add the
// Windows folders that exist, after the Linux ones so Linux tools still come first.
const WIN_USER = WORKDIR.match(/^\/mnt\/c\/Users\/([^/]+)\//)?.[1];
const WINDOWS_DIRS = IS_WSL ? [
  "/mnt/c/Windows/System32", "/mnt/c/Windows", "/mnt/c/Windows/System32/Wbem",
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0", "/mnt/c/Windows/System32/OpenSSH",
  "/mnt/c/Program Files/PowerShell/7", "/mnt/c/Program Files/Git/cmd", "/mnt/c/Program Files/Tailscale",
  WIN_USER && `/mnt/c/Users/${WIN_USER}/AppData/Local/Microsoft/WindowsApps`,
].filter((d) => d && fs.existsSync(d)) : [];
const WSL_PATH = [process.env.PATH, ...WINDOWS_DIRS].filter(Boolean).join(":");

// Claude can't know it's being read on a phone unless it's told, and then it can send things back.
const PHONE_NOTE = "This session is mirrored to an iPhone by claude-chat, so your replies are read there. " +
  "To show a file on that phone — a render, a screenshot, a diagram, a document — run: cchat send <path> [caption]. " +
  "Writing a file's full path in your reply also makes it appear there, so mention where you saved things. " +
  "Claude Code's built-in memory is switched off in these chats: save anything worth remembering to Sky AI Brain " +
  "(Supabase) with `mem remember`, as ~/.claude/CLAUDE.md describes.";

async function startClaude(c, { resume = false } = {}) {
  const args = [CLAUDE, resume ? "--resume" : "--session-id", c.sessionId, "-n", c.name,
    "--permission-mode", "bypassPermissions", "--settings", HOOKS_FILE, "--append-system-prompt", PHONE_NOTE];
  // A chat keeps the account it was started with; a resumed one goes back on the same account.
  if (!resume) { c.account = currentAccount; save(); }
  const token = accounts.tokenFor(ENV_FILE, c.account);
  // Luqman's knowledge lives in one place, Sky AI Brain on Supabase — not in Claude Code's own memory files.
  await tmux("new-session", "-d", "-s", c.tmux, "-c", c.cwd || WORKDIR, "-x", "140", "-y", "45",
    "-e", `CLAUDE_CHAT_ID=${c.id}`, "-e", `CLAUDE_CHAT_PORT=${PORT}`, "-e", `CLAUDE_CHAT_DATA=${DATA}`,
    "-e", "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1",
    ...(token ? ["-e", `CLAUDE_CODE_OAUTH_TOKEN=${token}`] : []),
    ...(IS_WSL ? ["-e", `PATH=${WSL_PATH}`] : []), args.map(shq).join(" "));
  const r = rt(c.id);
  r.alive = true;
  r.status = "starting";
  chatChanged(c.id);
}

// Opens a window on this computer attached to the chat's tmux session: Terminal on a Mac,
// Windows Terminal on a Windows PC.
async function openTerminal(c) {
  if (IS_WSL) {
    // cmd.exe treats & | < > ^ " % ! as commands, so they're left out of the window's title — a chat
    // called "R&D" would otherwise open a blank tab and try to run "D".
    const title = c.name.replace(/[&|<>^"%!]/g, "").trim() || "Claude";
    return run("/mnt/c/Windows/System32/cmd.exe", ["/c", "start", "", "wt.exe", "-w", "0", "new-tab", "--title", title,
      "wsl.exe", "-e", TMUX, "-L", SOCKET, "attach", "-t", c.tmux]);
  }
  const file = path.join(TERM_DIR, `${c.tmux}.command`);
  fs.writeFileSync(file, `#!/bin/zsh\nprintf '\\e]0;%s\\a' ${shq(c.name)}\nexec ${TMUX} -L ${SOCKET} attach -t ${c.tmux}\n`, { mode: 0o755 });
  await run("/usr/bin/open", ["-a", "Terminal", file]);
}

// The folders in the project folder, most recently changed first. The phone's "New chat" lists
// them the way WhatsApp lists contacts.
function listProjects() {
  const changed = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };
  return fs.readdirSync(WORKDIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => {
      const dir = path.join(WORKDIR, d.name);
      let latest = changed(dir);
      for (const f of fs.readdirSync(dir)) latest = Math.max(latest, changed(path.join(dir, f)));
      return { name: d.name, changedAt: latest, remote: gitRemote(dir) };
    })
    .sort((a, b) => b.changedAt - a.changedAt);
}

// A project's GitHub address, read from its .git/config (null if it has none). Setup scripts on a
// new computer use it to copy every project across.
function gitRemote(dir) {
  try { return fs.readFileSync(path.join(dir, ".git/config"), "utf8").match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1] || null; }
  catch { return null; }
}

// Syncthing keeps your Claude setup the same on every computer. The shared folder "claude-home" is
// ~/.claude, cut down by its .stignore to CLAUDE.md, settings.json, the keys (.env), the Sky AI
// Brain tool and the notes (D-014). Because keys travel, a new computer may only pair with a
// one-time code shown on your iPhone (⋯ → Computers → Add a computer), good for 30 minutes.
const SYNCTHING = ["/opt/homebrew/bin/syncthing", "/usr/local/bin/syncthing", "/usr/bin/syncthing"].find((p) => fs.existsSync(p));
let pairCode = null; // { code, expires }

// Which kind of device sent a request. tailscale serve adds the caller's tailnet address to
// X-Forwarded-For (the last entry is the one it added); requests made on this computer have none.
async function callerOs(req) {
  const raw = String(req.headers["x-forwarded-for"] || "").split(",").pop().trim();
  if (!raw) return "local";
  // The address can come as "[fd7a::1]:port", "100.1.2.3:port" or "::ffff:100.1.2.3" — reduce it to the bare address.
  const ip = raw.replace(/^\[([^\]]+)\](:\d+)?$/, "$1").replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, "$1").replace(/^::ffff:/i, "");
  const st = await tailnetStatus();
  const peer = [st?.Self, ...Object.values(st?.Peer || {})].find((p) => (p?.TailscaleIPs || []).includes(ip));
  if (!peer) {
    const seen = Object.fromEntries(Object.entries(req.headers).filter(([k]) => /forwarded|tailscale/i.test(k)));
    console.log(`caller not recognised: address ${ip}; headers ${JSON.stringify(seen)}`);
  }
  return peer?.OS || "unknown";
}

async function newPairCode(req) {
  const from = await callerOs(req);
  console.log(`pairing code asked for by: ${from}`);
  if (!(from === "local" || /^(ios|android)$/i.test(from))) throw fail("Pairing codes can only be made on your phone.", 403);
  pairCode = { code: String(crypto.randomInt(100000, 1000000)), expires: Date.now() + 30 * 60 * 1000, wrong: 0 };
  if (!SELF_URL) await otherComputers();
  return { code: pairCode.code, expires: pairCode.expires, mac: `curl -fsSL ${SELF_URL}/setup/mac | bash`, windows: `irm ${SELF_URL}/setup/windows | iex` };
}

async function pairSync({ id, name, code } = {}) {
  if (!SYNCTHING) throw fail("Syncthing isn't installed on this computer.", 409);
  if (!pairCode || String(code || "").replace(/\s/g, "") !== pairCode.code || Date.now() > pairCode.expires) {
    // Five wrong codes cancel it, so it can't be found by trying all million.
    if (pairCode && ++pairCode.wrong >= 5) pairCode = null;
    throw fail("That pairing code is wrong or has run out. Get a new one on your iPhone: Chats → ⋯ → Computers → Add a computer.", 403);
  }
  if (!/^[A-Z2-7]{7}(-[A-Z2-7]{7}){7}$/.test(String(id))) throw fail("That isn't a Syncthing ID.");
  pairCode = null; // each code works once
  const st = (...args) => run(SYNCTHING, ["cli", "config", ...args], { timeout: 15000 });
  const has = async (...args) => (await st(...args, "list")).stdout.includes(id);
  if (!(await has("devices"))) await st("devices", "add", "--device-id", id, "--name", String(name || "Another computer").slice(0, 60));
  if (!(await has("folders", "claude-home", "devices"))) await st("folders", "claude-home", "devices", "add", "--device-id", id);
  return { id: (await run(SYNCTHING, ["device-id"])).stdout.trim(), folder: "claude-home" };
}

// A project name from the phone → its folder. Only folders directly inside WORKDIR are allowed.
function projectDir(name) {
  if (!name) return WORKDIR;
  const dir = path.join(WORKDIR, String(name));
  if (path.dirname(dir) !== WORKDIR || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw fail("That project folder doesn't exist.");
  return dir;
}

// Before Claude starts in a project, get the newest version from GitHub, so work saved on another
// computer is here too. Only when nothing is unsaved here, and only if git can simply move forward.
// Returns a sentence for the chat, or null when there was nothing to say.
async function getLatest(cwd) {
  const git = async (...args) => (await run("git", ["-C", cwd, ...args], { timeout: 20000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })).stdout.trim();
  try {
    if (!fs.existsSync(path.join(cwd, ".git"))) return null;
    try { await git("rev-parse", "--abbrev-ref", "@{upstream}"); } catch { return null; } // not linked to GitHub
    if (await git("status", "--porcelain")) return "This project has unsaved changes on this computer, so I didn't fetch the newest version from GitHub.";
    const before = await git("rev-parse", "HEAD");
    await git("pull", "--ff-only", "--quiet");
    return before === (await git("rev-parse", "HEAD")) ? null : "Got the newest version of this project from GitHub.";
  } catch (e) {
    return `Couldn't get the newest version from GitHub: ${String(e.stderr || e.message).trim().split("\n")[0].slice(0, 140)}`;
  }
}

// Stop this chat's Claude and forget the chat: its Terminal file, its photos, everything.
async function deleteChat(id) {
  const c = chats[id];
  if (!c) return false;
  await tmux("kill-session", "-t", c.tmux).catch(() => {});
  resolvePending(id, null);
  delete chats[id];
  delete runtime[id];
  fs.rmSync(path.join(TERM_DIR, `${c.tmux}.command`), { force: true });
  fs.rmSync(path.join(PHOTO_DIR, id), { recursive: true, force: true });
  save();
  broadcast({ type: "removed", id });
  return true;
}

async function createChat(name, { terminal = true, project } = {}) {
  const id = crypto.randomUUID();
  const now = new Date();
  const cwd = projectDir(project);
  const synced = project ? await getLatest(cwd) : null;
  const c = {
    id, sessionId: id, tmux: `cc-${id.slice(0, 8)}`, createdAt: now.getTime(), cwd, transcript: transcriptPath(id, cwd),
    // A project chat is named after the project, like a WhatsApp chat is named after the contact.
    name: name?.trim().slice(0, 60) || (project ? path.basename(cwd) : `Chat ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`),
    autoName: !name?.trim() && !project,
  };
  chats[id] = c;
  save();
  if (synced) pushSystem(id, synced);
  await startClaude(c);
  if (terminal) openTerminal(c).catch((e) => console.error("could not open Terminal:", e.message));
  return c;
}

// The text in claude's input box: the lines between the last two ──── rules on screen.
async function inputBox(c) {
  return boxIn(await tmux("capture-pane", "-p", "-t", c.tmux));
}
function boxIn(screen) {
  const lines = screen.split("\n");
  const rules = lines.flatMap((l, i) => (/^\s*─{10,}/.test(l) ? [i] : []));
  if (rules.length < 2) return null;
  const [a, b] = rules.slice(-2);
  const box = lines.slice(a + 1, b).join("\n");
  return box.trimStart().startsWith("❯") ? box : null; // anything else is a menu or dialog, not the input box
}

// Scrolling back with the mouse in a chat's Terminal window puts tmux into its scroll ("copy")
// mode, and then every key goes to scrolling instead of Claude. Leave it before typing anything.
async function leaveScrollMode(c) {
  try {
    if ((await tmux("display-message", "-p", "-t", c.tmux, "#{pane_in_mode}")).trim() === "1") await tmux("send-keys", "-t", c.tmux, "-X", "cancel");
  } catch {}
}

// Type a message into claude and press Enter — checking each step, because a paste sent
// while claude is still starting up is silently dropped.
async function sendText(c, text) {
  await leaveScrollMode(c);
  const norm = (s) => s.replace(/[^a-zA-Z0-9]/g, "");
  const key = norm(text).slice(0, 16);
  const shows = (box) => box != null && (box.includes("[Pasted text") || (key ? norm(box).includes(key) : norm(box).length > 0));

  if (!(await until(async () => (await inputBox(c)) != null, 15000))) {
    throw fail(`Claude is showing a menu on ${COMPUTER}. Open the screen view to answer it first.`, 409);
  }
  const tmp = path.join(DATA, `paste-${c.tmux}.txt`);
  for (let attempt = 0; attempt < 4; attempt++) {
    fs.writeFileSync(tmp, text);
    await tmux("load-buffer", "-b", c.tmux, tmp);
    await tmux("paste-buffer", "-p", "-d", "-b", c.tmux, "-t", c.tmux); // -p: bracketed paste, so new lines don't send early
    fs.rmSync(tmp, { force: true });
    if (!(await until(async () => shows(await inputBox(c)), 3000))) { await sleep(1000); continue; }
    // A computer that's still starting Claude up (a slower PC, say) can miss the first Enter or two.
    for (let i = 0; i < 5; i++) {
      await tmux("send-keys", "-t", c.tmux, "Enter");
      if (await until(async () => !shows(await inputBox(c)), 4000)) return;
    }
    throw fail(`The message is in Claude's input box on ${COMPUTER} but didn't send. Open the screen view to check.`, 409);
  }
  throw fail("Claude didn't take the message. It may still be starting — try again in a moment.", 409);
}

const queue = (r, fn) => (r.chain = (r.chain || Promise.resolve()).catch(() => {}).then(fn));

// ── Claude Code's own commands (/usage, /model, /context…) ─────────────────────────────────
// These don't answer in the conversation: Claude Code draws the answer in the Terminal itself, and
// nothing about it reaches the transcript (checked 2026-09-11 with /usage, /status and /model). So the
// screen is read straight afterwards and sent to the phone as a card. A panel that only shows you
// something is then closed with Esc, so the chat isn't left stuck behind it; one that asks you to pick
// (like /model) stays open, and the phone opens its screen view.
const COMMAND_WAIT_MS = 1500;
const asksYou = (screen) => /(?:^|\s)(?:Enter|Tab|Space) to \S/.test(screen) || /^\s*❯\s*\d+\./m.test(screen);

async function runCommand(c, command) {
  const capture = async () => (await tmux("capture-pane", "-p", "-t", c.tmux)).split("\n");
  const before = await capture();
  await sendText(c, command);
  await sleep(COMMAND_WAIT_MS);
  let after = await capture();
  let text = newOnScreen(before, after);
  if (!text) { // a slow one: give it another moment
    await sleep(COMMAND_WAIT_MS);
    after = await capture();
    text = newOnScreen(before, after);
  }
  const screen = after.join("\n");
  const asks = boxIn(screen) == null && asksYou(screen);
  if (boxIn(screen) == null && !asks) {
    await tmux("send-keys", "-t", c.tmux, "Escape"); // just showing something: close it
    await sleep(400);
    if (boxIn((await capture()).join("\n")) == null) await tmux("send-keys", "-t", c.tmux, "Escape");
  }
  return pushCommand(c.id, command, text || "Done.", asks);
}

// What the screen gained: whatever was above stays put, so skip the lines that didn't change, and leave
// out the input box and the footer below it — and the Terminal's own furniture (the Claude Code logo at
// the top and its drawn rules), which is just noise in a chat.
const FRAME_LINE = /^[\s▔▁─━═▬▂▃▄▅▆▇█▀]+$/;
const LOGO_LINE = /^\s*[▝▘▗▖▛▜▙▟█]/;
function newOnScreen(before, after) {
  let i = 0;
  while (i < after.length && i < before.length && after[i] === before[i]) i++;
  const lines = after.slice(i).map((l) => l.trimEnd());
  const rule = lines.findIndex((l) => /^\s*─{10,}/.test(l));
  const kept = (rule >= 0 ? lines.slice(0, rule) : lines).filter((l) => !FRAME_LINE.test(l) && !LOGO_LINE.test(l));
  while (kept.length && !kept[0].trim()) kept.shift();
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  // Panels are drawn a few columns in from the edge; a narrow phone wants that space back.
  const indent = Math.min(...kept.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length), 20);
  return kept.slice(-60).map((l) => l.slice(indent)).join("\n").slice(0, 4000);
}

// Commands you've written yourself: yours in ~/.claude/commands, plus any in this chat's project.
function listCommands(cwd) {
  const out = [];
  for (const [dir, where] of [[path.join(HOME, ".claude/commands"), "yours"], ...(cwd ? [[path.join(cwd, ".claude/commands"), "this project"]] : [])]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")); } catch { continue; }
    for (const f of files) {
      let about = "";
      try { about = fs.readFileSync(path.join(dir, f), "utf8").match(/^description:\s*(.+)$/m)?.[1]?.trim() || ""; } catch {}
      out.push({ name: `/${f.replace(/\.md$/, "")}`, about: about.replace(/^["']|["']$/g, "").slice(0, 120), where });
    }
  }
  return out;
}

// ── permission requests: held open until the phone answers ─────────────────────────────────

function askPhone(c, ev, res) {
  const r = rt(c.id);
  resolvePending(c.id, null);
  const input = ev.tool_input || {};
  const p = {
    reqId: crypto.randomUUID(), tool: ev.tool_name, res, input,
    detail: ev.tool_name === "Bash" ? input.command : describeTool(ev.tool_name, input).text,
    why: input.description || "",
  };
  // One of Claude's multiple-choice questions: the phone shows the choices as buttons, and the
  // answers go back through POST /answer.
  if (ev.tool_name === "AskUserQuestion" && Array.isArray(input.questions) && input.questions.length) {
    p.questions = input.questions.map((q) => ({
      question: String(q.question || ""), header: String(q.header || ""), multiSelect: !!q.multiSelect,
      options: (q.options || []).map((o) => ({ label: String(o.label || ""), description: String(o.description || "") })),
    }));
    p.detail = p.questions[0].question;
  }
  r.pending = p;
  r.status = "approval";
  const timer = setTimeout(() => resolvePending(c.id, null, p.reqId), APPROVAL_WAIT_MS);
  // If you answer in the Terminal instead, Claude Code stops the hook and this connection closes.
  res.on("close", () => {
    clearTimeout(timer);
    if (r.pending !== p) return;
    r.pending = null;
    r.status = "working";
    chatChanged(c.id);
  });
  chatChanged(c.id);
  notify(c.id, p.questions ? `Asks: ${p.detail}` : `Needs your OK: ${p.detail}`);
}

// answer: { behavior: "allow" | "deny", updatedInput?, message? } for hook.mjs, or null for no
// answer (the Terminal's own prompt stays up)
function resolvePending(id, answer, reqId) {
  const r = rt(id), p = r.pending;
  if (!p || (reqId && p.reqId !== reqId)) return false;
  r.pending = null;
  r.status = "working";
  if (!p.res.writableEnded) json(p.res, answer || {});
  chatChanged(id);
  return true;
}

// ── events from hook.mjs ───────────────────────────────────────────────────────────────────

function handleHook(chatId, ev, res) {
  const c = chats[chatId];
  if (!c) return json(res, {});
  const r = rt(chatId);
  switch (ev.hook_event_name) {
    case "PermissionRequest":
      return askPhone(c, ev, res);
    case "SessionStart":
      r.status = "idle";
      if (ev.transcript_path && ev.transcript_path !== c.transcript) {
        // /clear or a resume started a new transcript file — follow it.
        c.transcript = ev.transcript_path;
        c.sessionId = ev.session_id;
        r.offset = 0;
        r.tokens = 0; // a cleared or resumed session starts with an empty memory
        if (ev.source === "resume") { r.messages = []; r.count = 0; broadcast({ type: "reset", chatId }); }
        else pushSystem(chatId, ev.source === "clear" ? "Conversation cleared" : "New session");
        save();
      }
      break;
    case "UserPromptSubmit": r.status = "working"; r.note = null; break;
    case "Stop": r.status = "idle"; break;
    case "Notification": if (ev.notification_type === "idle_prompt") r.status = "idle"; break;
  }
  chatChanged(chatId);
  json(res, {});
}

// ── notifications on the iPhone (push.mjs does the sending) ─────────────────────────────────

// The phone gives every computer its push address when you turn notifications on (⋯ → Notifications).
let subscriptions = [];
try { subscriptions = JSON.parse(fs.readFileSync(PUSH_FILE, "utf8")); } catch {}
function saveSubscriptions() {
  fs.writeFileSync(`${PUSH_FILE}.tmp`, JSON.stringify(subscriptions, null, 2));
  fs.renameSync(`${PUSH_FILE}.tmp`, PUSH_FILE);
}
// While you're looking at the app (it says so every 20 seconds) there's no need to buzz.
let lookingUntil = 0;
// Apple wants a contact address with every notification; this project's page does.
const PUSH_SUBJECT = "https://github.com/juslangit/claude-chat";

// Returns what each push address answered (201 = on its way).
async function notify(id, text, { force = false } = {}) {
  try {
    if (!subscriptions.length || (!force && Date.now() < lookingUntil)) return [];
    if (chats[id]?.archived) return []; // archived means leave me alone
    const keys = push.vapidKeys(ENV_FILE);
    if (!keys) { console.error(`push: no signing key in ${ENV_FILE} yet`); return []; }
    const c = chats[id];
    const payload = { title: c?.name || "Claude Chats", body: text.slice(0, 180), chat: c ? id : null, url: SELF_URL, tag: c ? `${COMPUTER}/${id}` : "claude-chat" };
    const results = await Promise.all(subscriptions.map((s) => push.send(s, payload, keys, PUSH_SUBJECT)));
    for (const r of results) if (r.status < 200 || r.status > 299) console.error(`push: ${r.status} ${r.text}`);
    // 404 or 410: the phone turned notifications off, or its address expired. Forget it.
    const gone = new Set(results.flatMap((r, i) => (r.status === 404 || r.status === 410 ? [subscriptions[i].endpoint] : [])));
    if (gone.size) { subscriptions = subscriptions.filter((s) => !gone.has(s.endpoint)); saveSubscriptions(); }
    return results;
  } catch (e) {
    console.error("push:", e.message);
    return [];
  }
}

// Claude's reply without its Markdown, for a notification's two or three lines.
const plainText = (s) => String(s || "").replace(/```[\s\S]*?```/g, " [code] ").replace(/[*`#>_|]+/g, "").replace(/\s+/g, " ").trim();

// A turn runs from Claude starting work until it's back at its prompt. When one ends, notify — a
// moment later, so Claude's last words have been read from the transcript first.
function watchTurn(id) {
  const r = rt(id);
  if (!r.alive) return void (r.turn = null);
  if (r.status === "working" || r.status === "approval") r.turn ||= { count: r.count };
  else if (r.status === "idle" && r.turn) {
    const turn = r.turn;
    r.turn = null;
    setTimeout(() => {
      if (!chats[id]) return;
      readTranscript(id);
      const said = r.count > turn.count && !r.lastText.startsWith("You: ") ? plainText(r.lastText) : "";
      notify(id, said || "Claude has finished.");
    }, 1500);
  }
}

// ── HTTP ───────────────────────────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

async function body(req, max = 2e6) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > max) throw fail("Too large", 413); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw fail("Bad JSON"); }
}

const KEYS = { up: "Up", down: "Down", left: "Left", right: "Right", enter: "Enter", esc: "Escape", tab: "Tab", shifttab: "BTab", space: "Space",
  ...Object.fromEntries("123456789".split("").map((d) => [d, d])) };

async function api(req, res, url) {
  if (url.pathname === "/api/projects" && req.method === "GET") return json(res, listProjects());
  if (url.pathname === "/api/commands" && req.method === "GET") return json(res, listCommands(chats[url.searchParams.get("chat")]?.cwd));
  if (url.pathname === "/api/whoami") return json(res, { name: COMPUTER, os: OS, url: SELF_URL, version: pageVersion() });
  if (url.pathname === "/api/computers") return json(res, await otherComputers());
  if (url.pathname === "/api/sync/code" && req.method === "POST") return json(res, await newPairCode(req));
  if (url.pathname === "/api/sync/pair" && req.method === "POST") return json(res, await pairSync(await body(req)));

  // Notifications: the phone says when it's being looked at, asks for the signing key's public half,
  // hands over (or takes back) its push address, and can ask for a test one.
  // What size the phone says its screen is — for chasing gaps at the top or bottom of the app.
  if (url.pathname === "/api/viewport" && req.method === "POST") {
    const report = JSON.stringify({ at: new Date().toISOString(), ...(await body(req, 4000)) });
    fs.appendFile(path.join(DATA, "viewport.log"), report + "\n", () => {});
    return json(res, { ok: true });
  }
  if (url.pathname === "/api/presence" && req.method === "POST") {
    lookingUntil = (await body(req)).looking ? Date.now() + 45000 : 0;
    return json(res, { ok: true });
  }
  // The Claude account new chats run as, and adding a second one without leaving the phone.
  // Asked straight out of ~/.claude/.env, not the few-second cache — Syncthing may have just brought
  // an account over from the other computer.
  if (url.pathname === "/api/accounts" && req.method === "GET") { knownAccounts.at = 0; return json(res, { ...accountList(), ...(await addingState()) }); }
  if (url.pathname === "/api/accounts/use" && req.method === "POST") return json(res, useAccount((await body(req)).id));
  if (url.pathname === "/api/accounts/add" && req.method === "POST") return json(res, await startAdding(await body(req)));
  if (url.pathname === "/api/accounts/code" && req.method === "POST") return json(res, await sendLoginCode((await body(req)).code));
  if (url.pathname === "/api/accounts/cancel" && req.method === "POST") { await stopAdding(); return json(res, { ok: true }); }
  if (url.pathname === "/api/accounts/remove" && req.method === "POST") {
    const { id } = await body(req);
    if (id === "signed-in") throw fail("The account this computer is signed in to can't be removed from here.");
    accounts.removeAccount(ENV_FILE, id);
    knownAccounts.at = 0;
    return json(res, accountList());
  }

  if (url.pathname === "/api/push/key") return json(res, { key: push.makeVapidKeys(ENV_FILE).publicKey });
  if (url.pathname === "/api/push/subscribe" && req.method === "POST") {
    const s = await body(req);
    if (!push.validSubscription(s)) throw fail("That isn't a push address.");
    subscriptions = [...subscriptions.filter((x) => x.endpoint !== s.endpoint), { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, at: Date.now() }];
    saveSubscriptions();
    return json(res, { ok: true, count: subscriptions.length });
  }
  if (url.pathname === "/api/push/unsubscribe" && req.method === "POST") {
    const { endpoint } = await body(req);
    subscriptions = subscriptions.filter((x) => x.endpoint !== endpoint);
    saveSubscriptions();
    return json(res, { ok: true });
  }
  if (url.pathname === "/api/push/test" && req.method === "POST") {
    const results = await notify(null, "Notifications are on. You'll get one like this when Claude finishes or needs you.", { force: true });
    const ok = (r) => r.status >= 200 && r.status < 300;
    return json(res, { sent: results.filter(ok).length, failed: results.filter((r) => !ok(r)).map((r) => `${r.status} ${r.text}`) });
  }

  // Tidy-up from Settings: forget every chat whose Claude has stopped. Running ones are left alone.
  if (url.pathname === "/api/chats/stopped" && req.method === "DELETE") {
    const stopped = Object.keys(chats).filter((id) => !rt(id).alive);
    for (const id of stopped) await deleteChat(id);
    return json(res, { deleted: stopped.length });
  }

  // A photo you sent, for the phone to show in the chat.
  // A file this chat has pointed at, fetched by its token.
  const shared = url.pathname.match(/^\/api\/chats\/([\w-]+)\/files\/([0-9a-f]{16})$/);
  if (shared && req.method === "GET") {
    const file = rt(shared[1]).shared?.get(shared[2]);
    if (!chats[shared[1]] || !file || !fs.existsSync(file)) throw fail("Not found", 404);
    const ext = path.extname(file).slice(1).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": fs.statSync(file).size,
      "content-disposition": `${KINDS[ext] ? "inline" : "attachment"}; filename="${path.basename(file).replace(/"/g, "")}"`,
      "cache-control": "private, max-age=600",
    });
    return fs.createReadStream(file).pipe(res);
  }

  const photo = url.pathname.match(/^\/api\/chats\/([\w-]+)\/photos\/(\d+\.jpg)$/);
  if (photo && req.method === "GET") {
    const file = path.join(PHOTO_DIR, photo[1], photo[2]);
    if (!chats[photo[1]] || !fs.existsSync(file)) throw fail("Not found", 404);
    res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "private, max-age=31536000, immutable" });
    return fs.createReadStream(file).pipe(res);
  }

  const m = url.pathname.match(/^\/api\/chats(?:\/([\w-]+))?(?:\/(\w+))?$/);
  if (!m) throw fail("Not found", 404);
  const [, id, action] = m;
  const route = `${req.method} ${action || ""}`;

  if (!id) {
    if (req.method === "GET") return json(res, Object.values(chats).map(summary));
    if (req.method === "POST") {
      const b = await body(req);
      const c = await createChat(b.name, { terminal: b.terminal !== false, project: b.project });
      return json(res, { ...summary(c), tmux: c.tmux });
    }
    throw fail("Not found", 404);
  }

  const c = chats[id];
  if (!c) throw fail("That chat doesn't exist any more.", 404);
  const r = rt(id);

  switch (route) {
    case "GET messages":
      return json(res, r.messages.slice(-500));
    case "POST send": {
      const text = String((await body(req)).text || "").trim();
      if (!text) throw fail("Nothing to send.");
      if (!r.alive) throw fail("This chat's Claude has stopped. Tap Resume first.", 409);
      if (r.pending) throw fail(r.pending.questions ? "Claude asked you a question first. Answer it above." : "Claude is waiting for your approval first.", 409);
      await queue(r, () => sendText(c, text));
      return json(res, { ok: true });
    }
    case "POST share": {
      // `cchat send <file>` on the computer: show this file on the phone.
      const b = await body(req);
      const file = path.resolve(String(b.path || "").replace(/^~/, HOME));
      const shared = shareFile(id, file);
      if (!shared) throw fail("That file isn't there, or it's bigger than 60 MB.", 404);
      const caption = String(b.caption || "").trim().slice(0, 500);
      const m = { id: crypto.randomUUID(), role: "file", ...shared, caption, at: Date.now() };
      r.messages.push(m);
      r.lastAt = m.at;
      r.lastText = `📎 ${shared.name}`;
      broadcast({ type: "messages", chatId: id, messages: [m] });
      chatChanged(id);
      notify(id, `Sent you ${shared.name}${caption ? ` — ${caption}` : ""}`);
      return json(res, m);
    }
    case "POST photo": {
      // A photo from the phone (already shrunk to a JPEG there): saved in data/photos, and Claude is
      // told where it is so it can open it and look.
      const b = await body(req, 15e6);
      if (!r.alive) throw fail("This chat's Claude has stopped. Tap Resume first.", 409);
      if (r.pending) throw fail(r.pending.questions ? "Claude asked you a question first. Answer it above." : "Claude is waiting for your approval first.", 409);
      const img = Buffer.from(String(b.data || ""), "base64");
      if (img.length < 100 || img[0] !== 0xff || img[1] !== 0xd8) throw fail("That photo didn't arrive whole. Try again.");
      const dir = path.join(PHOTO_DIR, id);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}.jpg`);
      fs.writeFileSync(file, img);
      const caption = String(b.caption || "").trim().slice(0, 4000);
      await queue(r, () => sendText(c, `[📷 photo from my phone: ${file} — open it to see it]${caption ? `\n\n${caption}` : ""}`));
      return json(res, { ok: true });
    }
    case "POST command": {
      // One of Claude Code's own commands, e.g. "/usage" — the answer comes back as a card (runCommand).
      const command = String((await body(req)).command || "").trim();
      if (!/^\/[a-z][\w-]*(?:\s[\s\S]{0,500})?$/i.test(command)) throw fail("That doesn't look like a command.");
      if (!r.alive) throw fail("This chat's Claude has stopped. Tap Resume first.", 409);
      if (r.pending) throw fail(r.pending.questions ? "Claude asked you a question first. Answer it above." : "Claude is waiting for your approval first.", 409);
      return json(res, await queue(r, () => runCommand(c, command)));
    }
    case "POST key": {
      const k = KEYS[(await body(req)).key];
      if (!k) throw fail("Unknown key.");
      if (!r.alive) throw fail("This chat's Claude has stopped.", 409);
      await leaveScrollMode(c);
      await tmux("send-keys", "-t", c.tmux, k);
      return json(res, { ok: true });
    }
    case "GET screen":
      if (!r.alive) return json(res, { text: "(Claude is not running in this chat.)" });
      return json(res, { text: await tmux("capture-pane", "-p", "-t", c.tmux) });
    case "POST approve": {
      const b = await body(req);
      const allow = b.decision === "allow", question = r.pending?.reqId === b.reqId && r.pending.questions;
      // A question needs an answer (POST answer), not an OK. Denying one skips it. Only a phone page from
      // before questions had buttons would try to OK one.
      if (allow && question) throw fail("Your phone has an old copy of this app, so it can't show the answer buttons. Close the app and open it again.", 409);
      const answer = allow ? { behavior: "allow" } : { behavior: "deny", ...(question && { message: "Luqman skipped this question from his phone." }) };
      if (!resolvePending(id, answer, b.reqId)) throw fail("That request was already answered.", 409);
      return json(res, { ok: true });
    }
    case "POST answer": {
      // { reqId, answers: { "<question>": "<answer>" } } — Claude Code wants the answers keyed by the
      // question's words; several picks from one question are joined with ", ".
      const b = await body(req), p = r.pending;
      if (!p?.questions || p.reqId !== b.reqId) throw fail("That question was already answered.", 409);
      const answers = {};
      for (const q of p.questions) {
        const a = String(b.answers?.[q.question] ?? "").trim().slice(0, 2000);
        if (!a) throw fail(`No answer for “${q.question}”.`);
        answers[q.question] = a;
      }
      resolvePending(id, { behavior: "allow", updatedInput: { ...p.input, answers } }, b.reqId);
      return json(res, { ok: true });
    }
    case "POST terminal":
      if (!r.alive) throw fail("This chat's Claude has stopped. Tap Resume first.", 409);
      await openTerminal(c);
      return json(res, { ok: true });
    case "POST resume":
      if (!r.alive) { await startClaude(c, { resume: true }); openTerminal(c).catch((e) => console.error("could not open Terminal:", e.message)); }
      return json(res, { ok: true });
    case "PATCH ": {
      // Rename, or archive: an archived chat keeps running and keeps everything, it just leaves the list
      // on the phone and stops sending notifications.
      const b = await body(req);
      const name = String(b.name || "").trim().slice(0, 60);
      if (name) { c.name = name; c.autoName = false; }
      if ("archived" in b) c.archived = !!b.archived;
      if (name || "archived" in b) { save(); chatChanged(id); }
      return json(res, summary(c));
    }
    case "DELETE ":
      await deleteChat(id);
      return json(res, { ok: true });
  }
  throw fail("Not found", 404);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const PUBLIC = path.join(ROOT, "public");

// A fingerprint of the phone page's files. It changes whenever public/ changes (a git pull), and an
// open phone page that sees a new one reloads itself, so it never keeps running an old copy.
function pageVersion() {
  const h = crypto.createHash("sha1");
  for (const f of fs.readdirSync(PUBLIC).sort()) h.update(f).update(fs.readFileSync(path.join(PUBLIC, f)));
  return h.digest("hex").slice(0, 12);
}

function serveStatic(pathname, res) {
  const file = path.normalize(path.join(PUBLIC, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw fail("Not found", 404);
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

// ── several computers ──────────────────────────────────────────────────────────────────────
// The phone's page comes from one computer but talks to every computer running claude-chat on
// your Tailscale network. Each one says who it is (/api/whoami) and lists the others it can see
// (/api/computers), and lets pages from your own tailnet talk to it (CORS). Pages from anywhere
// else are refused, so a website open on the phone can't reach your chats.

// This computer's name, shown on the phone next to its chats ("Luqman's MacBook Pro").
let COMPUTER = process.env.CLAUDE_CHAT_COMPUTER || os.hostname().replace(/\.local$/, "");
if (!process.env.CLAUDE_CHAT_COMPUTER) {
  try {
    if (OS === "mac") COMPUTER = (await run("/usr/sbin/scutil", ["--get", "ComputerName"])).stdout.trim() || COMPUTER;
    if (IS_WSL) COMPUTER = (await run("/mnt/c/Windows/System32/cmd.exe", ["/c", "echo %COMPUTERNAME%"])).stdout.trim() || COMPUTER;
  } catch {}
}

// Tailscale's command-line tool. This Mac runs it in userspace mode with its own socket (D-004);
// a Mac with the Tailscale app, a Windows PC (seen from WSL) or Linux keep it in the usual places.
const USERSPACE_SOCKET = path.join(HOME, "Library/Application Support/tailscale-user/tailscaled.sock");
// Looked for on every call, not once at start: after a restart this server can be up before Tailscale
// is, and then it used to go without Tailscale (and its safety checks) until it was restarted again.
const tailscaleTools = () => [
  ["/opt/homebrew/opt/tailscale/bin/tailscale", `--socket=${USERSPACE_SOCKET}`],
  ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
  ["/mnt/c/Program Files/Tailscale/tailscale.exe"],
  ["/usr/bin/tailscale"],
  ["/usr/local/bin/tailscale"],
].filter(([bin, sock]) => fs.existsSync(bin) && (!sock || fs.existsSync(USERSPACE_SOCKET)));

async function tailnetStatus() {
  for (const [bin, ...args] of tailscaleTools()) {
    try { return JSON.parse((await run(bin, [...args, "status", "--json"], { timeout: 5000, maxBuffer: 8e6 })).stdout); } catch {}
  }
  return null;
}

let TAILNET = null;  // e.g. "tail8806f8.ts.net"
let SELF_URL = null; // e.g. "https://luqman-mac.tail8806f8.ts.net"
let peers = { until: 0, list: [] };
// The other computers on your tailnet, switched off ones too, with when Tailscale last saw them —
// the phone uses that to say "offline since 19:43".
async function otherComputers() {
  if (Date.now() < peers.until) return peers.list;
  const st = await tailnetStatus();
  const dns = (d) => String(d || "").replace(/\.$/, "");
  if (st?.Self?.DNSName) {
    SELF_URL = `https://${dns(st.Self.DNSName)}`;
    TAILNET = dns(st.Self.DNSName).split(".").slice(1).join(".");
  }
  const list = Object.values(st?.Peer || {})
    .filter((p) => /^(macos|windows|linux)$/i.test(p.OS) && p.DNSName)
    .map((p) => ({
      url: `https://${dns(p.DNSName)}`, os: p.OS, online: !!p.Online,
      lastSeen: !p.Online && Date.parse(p.LastSeen) > 0 ? Date.parse(p.LastSeen) : null,
    }));
  peers = { until: Date.now() + (st ? 30000 : 5000), list }; // no answer from Tailscale: ask again soon
  return list;
}
await otherComputers();

const hostname = (h) => String(h || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
const isLocal = (name) => name === "127.0.0.1" || name === "localhost" || name === "::1";

// The name a request was sent to must be this computer or one on your tailnet. A website can't fake
// that header, so this stops "DNS rebinding" — a page pointing its own name at 127.0.0.1 to read chats.
function hostAllowed(req) {
  return [req.headers.host, req.headers["x-forwarded-host"]].filter(Boolean).every((h) => {
    const name = hostname(h);
    return isLocal(name) || (TAILNET ? name.endsWith(`.${TAILNET}`) : name.endsWith(".ts.net"));
  });
}

// Pages from your own tailnet may talk to this computer. Until Tailscale has said which tailnet that
// is, only the page this computer served itself is let in — never any other *.ts.net site.
function originAllowed(origin, req) {
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (isLocal(url.hostname)) return true;
  if (TAILNET) return url.hostname.endsWith(`.${TAILNET}`);
  return [req.headers.host, req.headers["x-forwarded-host"]].includes(url.host);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (!TAILNET) await otherComputers(); // Tailscale may have started since this server did
    if (!hostAllowed(req)) throw fail("Not allowed.", 403);
    const origin = req.headers.origin;
    if (origin) {
      if (!originAllowed(origin, req)) throw fail("Not allowed from that page.", 403);
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE", "Access-Control-Allow-Headers": "content-type", "Access-Control-Max-Age": "600" });
        return res.end();
      }
    }
    if (url.pathname === "/hook" && req.method === "POST") {
      if (req.headers["x-secret"] !== SECRET) throw fail("Forbidden", 403);
      const b = await body(req);
      return handleHook(b.chatId, b.event || {}, res);
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write("retry: 3000\n: connected\n\n"); // if the line drops, the phone tries again after 3 s
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    // One-line setup for another computer, e.g.  curl -fsSL <this address>/setup/mac | bash
    const setup = url.pathname.match(/^\/setup\/(mac|windows|wsl)$/);
    if (setup) {
      const file = path.join(ROOT, "setup", { mac: "mac.sh", windows: "windows.ps1", wsl: "wsl.sh" }[setup[1]]);
      if (!SELF_URL) await otherComputers(); // learn this computer's Tailscale address
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      return res.end(fs.readFileSync(file, "utf8").replaceAll("__HOME_URL__", SELF_URL || "__HOME_URL__"));
    }
    serveStatic(url.pathname, res);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, { error: e.message }, e.status || 500);
  }
});

for (const id in chats) readTranscript(id);
await refreshAlive();
server.listen(PORT, "127.0.0.1", () => console.log(`claude-chat on http://127.0.0.1:${PORT} — chats start in ${WORKDIR}`));

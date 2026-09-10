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

const run = promisify(execFile);
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const HOME = os.homedir();
const PORT = Number(process.env.PORT || 4477);
const WORKDIR = process.env.CLAUDE_CHAT_WORKDIR || path.join(HOME, "Desktop/project");
const CLAUDE = process.env.CLAUDE_BIN || path.join(HOME, ".local/bin/claude");
const TMUX = process.env.TMUX_BIN || "/opt/homebrew/bin/tmux";
const DATA = path.join(ROOT, "data");
const CHATS_FILE = path.join(DATA, "chats.json");
const SECRET_FILE = path.join(DATA, "secret");
const HOOKS_FILE = path.join(DATA, "hooks.json");
const TERM_DIR = path.join(DATA, "terminal");
// The permission hook is allowed 30 minutes; give up a little before Claude Code does.
const APPROVAL_WAIT_MS = 29 * 60 * 1000;

fs.mkdirSync(TERM_DIR, { recursive: true });

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
const tmux = async (...args) => (await run(TMUX, ["-L", "claude-chat", "-f", path.join(ROOT, "tmux.conf"), ...args], { encoding: "utf8" })).stdout;
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
try { chats = JSON.parse(fs.readFileSync(CHATS_FILE, "utf8")); } catch {}
let saveTimer;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => fs.writeFileSync(CHATS_FILE, JSON.stringify(chats, null, 2)), 200); };

// Only in memory: what is happening in each chat right now.
const runtime = {};
const rt = (id) => (runtime[id] ||= { messages: [], offset: 0, count: 0, status: "idle", alive: false, pending: null, lastText: "", lastAt: 0 });

function summary(c) {
  const r = rt(c.id);
  return {
    id: c.id, name: c.name, createdAt: c.createdAt, alive: r.alive,
    project: c.cwd && c.cwd !== WORKDIR ? path.basename(c.cwd) : null,
    status: r.alive ? r.status : "ended",
    lastText: r.lastText, lastAt: r.lastAt || c.createdAt, count: r.count,
    pending: r.pending && { reqId: r.pending.reqId, tool: r.pending.tool, detail: r.pending.detail, why: r.pending.why },
  };
}

// ── live updates to the phone (Server-Sent Events) ─────────────────────────────────────────

const clients = new Set();
const broadcast = (event) => { const line = `data: ${JSON.stringify(event)}\n\n`; for (const res of clients) res.write(line); };
const chatChanged = (id) => chats[id] && broadcast({ type: "chat", chat: summary(chats[id]) });
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 20000);

// ── reading what was said, from Claude Code's transcript file ──────────────────────────────

function describeTool(name, input = {}) {
  const rel = (p) => (p?.startsWith(WORKDIR + "/") ? p.slice(WORKDIR.length + 1) : p) || "";
  switch (name) {
    case "Bash": return `$ ${input.command || ""}`;
    case "Read": case "Write": case "Edit": case "MultiEdit": case "NotebookEdit": return `${name} ${rel(input.file_path || input.notebook_path)}`;
    case "Glob": case "Grep": return `${name} ${input.pattern || ""}`;
    case "WebFetch": return `WebFetch ${input.url || ""}`;
    case "WebSearch": return `WebSearch ${input.query || ""}`;
    case "Agent": case "Task": return `Agent: ${input.description || ""}`;
    case "TodoWrite": return "Updated the to-do list";
    default: return name;
  }
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
    } else if (b.type === "tool_use") {
      out.push({ id, role: "tool", text: describeTool(b.name, b.input), at });
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
    try { if (line.trim()) fresh.push(...toMessages(JSON.parse(line))); } catch {}
  }
  if (!fresh.length) return;
  for (const m of fresh) {
    r.messages.push(m);
    r.lastAt = m.at;
    if (m.role === "assistant") { r.count++; r.lastText = m.text; }
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

setInterval(() => { for (const id in chats) readTranscript(id); }, 600);

// Which chats still have a running claude? (tmux session exists)
async function refreshAlive() {
  let names = [];
  try { names = (await tmux("list-sessions", "-F", "#{session_name}")).trim().split("\n"); } catch {} // no tmux server = none running
  for (const c of Object.values(chats)) {
    const r = rt(c.id), alive = names.includes(c.tmux);
    if (r.alive === alive) continue;
    r.alive = alive;
    if (!alive) resolvePending(c.id, null);
    chatChanged(c.id);
  }
}
setInterval(refreshAlive, 3000);

// ── driving claude inside tmux ─────────────────────────────────────────────────────────────

// Chats run with bypassPermissions, like plain `claude` on this Mac: nothing asks first. The deny
// list in ~/.claude/settings.json (sudo, rm -rf, force-push…) still applies, and anything Claude Code
// asks about anyway still reaches the phone through the PermissionRequest hook.
async function startClaude(c, { resume = false } = {}) {
  const args = [CLAUDE, resume ? "--resume" : "--session-id", c.sessionId, "-n", c.name,
    "--permission-mode", "bypassPermissions", "--settings", HOOKS_FILE];
  await tmux("new-session", "-d", "-s", c.tmux, "-c", c.cwd || WORKDIR, "-x", "140", "-y", "45",
    "-e", `CLAUDE_CHAT_ID=${c.id}`, "-e", `CLAUDE_CHAT_PORT=${PORT}`, args.map(shq).join(" "));
  const r = rt(c.id);
  r.alive = true;
  r.status = "starting";
  chatChanged(c.id);
}

// Opens a Terminal window on the Mac attached to the chat's tmux session.
async function openTerminal(c) {
  const file = path.join(TERM_DIR, `${c.tmux}.command`);
  fs.writeFileSync(file, `#!/bin/zsh\nprintf '\\e]0;%s\\a' ${shq(c.name)}\nexec ${TMUX} -L claude-chat attach -t ${c.tmux}\n`, { mode: 0o755 });
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
      return { name: d.name, changedAt: latest };
    })
    .sort((a, b) => b.changedAt - a.changedAt);
}

// A project name from the phone → its folder. Only folders directly inside WORKDIR are allowed.
function projectDir(name) {
  if (!name) return WORKDIR;
  const dir = path.join(WORKDIR, String(name));
  if (path.dirname(dir) !== WORKDIR || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw fail("That project folder doesn't exist.");
  return dir;
}

async function createChat(name, { terminal = true, project } = {}) {
  const id = crypto.randomUUID();
  const now = new Date();
  const cwd = projectDir(project);
  const c = {
    id, sessionId: id, tmux: `cc-${id.slice(0, 8)}`, createdAt: now.getTime(), cwd, transcript: transcriptPath(id, cwd),
    // A project chat is named after the project, like a WhatsApp chat is named after the contact.
    name: name?.trim().slice(0, 60) || (project ? path.basename(cwd) : `Chat ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`),
    autoName: !name?.trim() && !project,
  };
  chats[id] = c;
  save();
  await startClaude(c);
  if (terminal) openTerminal(c).catch((e) => console.error("could not open Terminal:", e.message));
  return c;
}

// The text in claude's input box: the lines between the last two ──── rules on screen.
async function inputBox(c) {
  const lines = (await tmux("capture-pane", "-p", "-t", c.tmux)).split("\n");
  const rules = lines.flatMap((l, i) => (/^\s*─{10,}/.test(l) ? [i] : []));
  if (rules.length < 2) return null;
  const [a, b] = rules.slice(-2);
  const box = lines.slice(a + 1, b).join("\n");
  return box.trimStart().startsWith("❯") ? box : null; // anything else is a menu or dialog, not the input box
}

// Type a message into claude and press Enter — checking each step, because a paste sent
// while claude is still starting up is silently dropped.
async function sendText(c, text) {
  const norm = (s) => s.replace(/[^a-zA-Z0-9]/g, "");
  const key = norm(text).slice(0, 16);
  const shows = (box) => box != null && (box.includes("[Pasted text") || (key ? norm(box).includes(key) : norm(box).length > 0));

  if (!(await until(async () => (await inputBox(c)) != null, 15000))) {
    throw fail("Claude is showing a menu on the Mac. Open the screen view to answer it first.", 409);
  }
  const tmp = path.join(DATA, `paste-${c.tmux}.txt`);
  for (let attempt = 0; attempt < 4; attempt++) {
    fs.writeFileSync(tmp, text);
    await tmux("load-buffer", "-b", c.tmux, tmp);
    await tmux("paste-buffer", "-p", "-d", "-b", c.tmux, "-t", c.tmux); // -p: bracketed paste, so new lines don't send early
    fs.rmSync(tmp, { force: true });
    if (!(await until(async () => shows(await inputBox(c)), 3000))) { await sleep(1000); continue; }
    for (let i = 0; i < 3; i++) {
      await tmux("send-keys", "-t", c.tmux, "Enter");
      if (await until(async () => !shows(await inputBox(c)), 3000)) return;
    }
    throw fail("The message is in Claude's input box on the Mac but didn't send. Open the screen view to check.", 409);
  }
  throw fail("Claude didn't take the message. It may still be starting — try again in a moment.", 409);
}

const queue = (r, fn) => (r.chain = (r.chain || Promise.resolve()).catch(() => {}).then(fn));

// ── permission requests: held open until the phone answers ─────────────────────────────────

function askPhone(c, ev, res) {
  const r = rt(c.id);
  resolvePending(c.id, null);
  const p = {
    reqId: crypto.randomUUID(), tool: ev.tool_name, res,
    detail: ev.tool_name === "Bash" ? ev.tool_input?.command : describeTool(ev.tool_name, ev.tool_input),
    why: ev.tool_input?.description || "",
  };
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
}

// behavior: "allow" | "deny" | null (null = no answer; the Terminal's own prompt stays up)
function resolvePending(id, behavior, reqId) {
  const r = rt(id), p = r.pending;
  if (!p || (reqId && p.reqId !== reqId)) return false;
  r.pending = null;
  r.status = "working";
  if (!p.res.writableEnded) json(p.res, behavior ? { behavior } : {});
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
        if (ev.source === "resume") { r.messages = []; r.count = 0; broadcast({ type: "reset", chatId }); }
        else pushSystem(chatId, ev.source === "clear" ? "Conversation cleared" : "New session");
        save();
      }
      break;
    case "UserPromptSubmit": r.status = "working"; break;
    case "Stop": r.status = "idle"; break;
    case "Notification": if (ev.notification_type === "idle_prompt") r.status = "idle"; break;
  }
  chatChanged(chatId);
  json(res, {});
}

// ── HTTP ───────────────────────────────────────────────────────────────────────────────────

function json(res, data, status = 200) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > 2e6) throw fail("Too large", 413); }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw fail("Bad JSON"); }
}

const KEYS = { up: "Up", down: "Down", left: "Left", right: "Right", enter: "Enter", esc: "Escape", tab: "Tab", shifttab: "BTab", space: "Space",
  ...Object.fromEntries("123456789".split("").map((d) => [d, d])) };

async function api(req, res, url) {
  if (url.pathname === "/api/projects" && req.method === "GET") return json(res, listProjects());
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
      if (r.pending) throw fail("Claude is waiting for your approval first.", 409);
      await queue(r, () => sendText(c, text));
      return json(res, { ok: true });
    }
    case "POST key": {
      const k = KEYS[(await body(req)).key];
      if (!k) throw fail("Unknown key.");
      if (!r.alive) throw fail("This chat's Claude has stopped.", 409);
      await tmux("send-keys", "-t", c.tmux, k);
      return json(res, { ok: true });
    }
    case "GET screen":
      if (!r.alive) return json(res, { text: "(Claude is not running in this chat.)" });
      return json(res, { text: await tmux("capture-pane", "-p", "-t", c.tmux) });
    case "POST approve": {
      const b = await body(req);
      if (!resolvePending(id, b.decision === "allow" ? "allow" : "deny", b.reqId)) throw fail("That request was already answered.", 409);
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
      const name = String((await body(req)).name || "").trim().slice(0, 60);
      if (name) { c.name = name; c.autoName = false; save(); chatChanged(id); }
      return json(res, summary(c));
    }
    case "DELETE ":
      await tmux("kill-session", "-t", c.tmux).catch(() => {});
      resolvePending(id, null);
      delete chats[id];
      delete runtime[id];
      fs.rmSync(path.join(TERM_DIR, `${c.tmux}.command`), { force: true });
      save();
      broadcast({ type: "removed", id });
      return json(res, { ok: true });
  }
  throw fail("Not found", 404);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
const PUBLIC = path.join(ROOT, "public");

function serveStatic(pathname, res) {
  const file = path.normalize(path.join(PUBLIC, pathname === "/" ? "index.html" : pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw fail("Not found", 404);
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/hook" && req.method === "POST") {
      if (req.headers["x-secret"] !== SECRET) throw fail("Forbidden", 403);
      const b = await body(req);
      return handleHook(b.chatId, b.event || {}, res);
    }
    if (url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    serveStatic(url.pathname, res);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) json(res, { error: e.message }, e.status || 500);
  }
});

for (const id in chats) readTranscript(id);
await refreshAlive();
server.listen(PORT, "127.0.0.1", () => console.log(`claude-chat on http://127.0.0.1:${PORT} — chats start in ${WORKDIR}`));

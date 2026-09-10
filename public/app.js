// Claude Chats — the phone side. Everything here talks to server.mjs on the Mac.

const $ = (sel) => document.querySelector(sel);
const state = {
  chats: new Map(),    // id → summary from the server
  messages: new Map(), // id → messages, once a chat has been opened
  current: null,       // id of the open chat
  seen: read("seen", {}),     // id → how many of Claude's messages you've seen (for unread badges)
  drafts: read("drafts", {}), // id → half-typed message
};
const STATUS = { starting: "starting…", working: "working…", approval: "needs your approval", idle: "waiting for you", ended: "stopped" };

function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, { method, body } = {}) {
  const res = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json" },
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status})`);
  return data;
}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4500);
}

// ── live connection to the Mac ─────────────────────────────────────────────

let source;
function connect() {
  source?.close();
  source = new EventSource("/events");
  source.onopen = () => { setOnline(true); refresh(); };
  source.onerror = () => setOnline(false);
  source.onmessage = (e) => onEvent(JSON.parse(e.data));
}
function setOnline(on) {
  $("#conn").classList.toggle("on", on);
  $("#conn").title = on ? "Connected to the Mac" : "Can't reach the Mac";
}
// iPhones pause pages in the background; catch up when you come back.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!source || source.readyState === EventSource.CLOSED) connect(); else refresh();
});

function onEvent(ev) {
  if (ev.type === "chat") {
    state.chats.set(ev.chat.id, ev.chat);
    renderList();
    if (ev.chat.id === state.current) renderChatChrome();
  } else if (ev.type === "removed") {
    state.chats.delete(ev.id);
    state.messages.delete(ev.id);
    if (state.current === ev.id) location.hash = "";
    renderList();
  } else if (ev.type === "messages") {
    const list = state.messages.get(ev.chatId);
    if (!list) return;
    const known = new Set(list.map((m) => m.id));
    const fresh = ev.messages.filter((m) => !known.has(m.id));
    list.push(...fresh);
    if (ev.chatId === state.current) appendMessages(fresh);
  } else if (ev.type === "reset") {
    state.messages.delete(ev.chatId);
    if (ev.chatId === state.current) loadMessages(ev.chatId);
  }
}

async function refresh() {
  try {
    const list = await api("/api/chats");
    state.chats = new Map(list.map((c) => [c.id, c]));
    renderList();
    if (state.current) { renderChatChrome(); await loadMessages(state.current); }
  } catch (e) { toast(e.message); }
}

// ── chat list ──────────────────────────────────────────────────────────────

function avatar(c) {
  let h = 0;
  for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const initial = [...(c.name || "?").trim()][0]?.toUpperCase() || "?";
  const dot = ["working", "starting", "approval", "ended"].includes(c.status) ? `<span class="dot ${c.status}"></span>` : "";
  return `<div class="avatar" style="background:hsl(${h} 42% 44%)">${esc(initial)}${dot}</div>`;
}

function when(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return clock(ts);
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (now - d < 6 * 864e5) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "2-digit" });
}
const clock = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function renderList() {
  const chats = [...state.chats.values()].sort((a, b) => !!b.pending - !!a.pending || b.lastAt - a.lastAt);
  $("#chat-list").innerHTML = chats.length
    ? chats.map(rowHtml).join("")
    : `<div class="empty"><p>No chats yet.</p><p>Tap <b>+</b> to start one. A Terminal window with Claude Code opens on the Mac, ready to go.</p></div>`;
}

function rowHtml(c) {
  const unread = Math.max(0, c.count - (state.seen[c.id] ?? 0));
  let preview = esc(c.lastText || "No messages yet");
  let badge = unread && c.id !== state.current ? `<span class="badge">${unread}</span>` : "";
  if (c.pending) {
    preview = `<span class="warn-text">Wants to run: ${esc(c.pending.detail)}</span>`;
    badge = `<span class="badge warn">!</span>`;
  } else if (c.status === "working" || c.status === "starting") {
    preview = `<span class="working">${STATUS[c.status]}</span>`;
  } else if (c.status === "ended") {
    preview = `■ stopped · ${preview}`;
  }
  return `<button class="row" data-id="${c.id}">${avatar(c)}
    <div class="meta">
      <div class="top"><span class="name">${esc(c.name)}</span><span class="time">${when(c.lastAt)}</span></div>
      <div class="preview"><span class="ptext">${preview}</span>${badge}</div>
    </div></button>`;
}

$("#chat-list").addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (row) location.hash = `chat/${row.dataset.id}`;
});

// ── moving between the list and a chat (uses the URL, so the back gesture works) ──

function route() {
  saveDraft();
  const id = location.hash.match(/^#chat\/([\w-]+)/)?.[1] || null;
  state.current = id;
  $("#list-view").hidden = !!id;
  $("#chat-view").hidden = !id;
  closeSheets();
  if (id) {
    $("#messages").innerHTML = "";
    $("#input").value = state.drafts[id] || "";
    grow();
    renderChatChrome();
    loadMessages(id);
  } else {
    renderList();
  }
}
window.addEventListener("hashchange", route);
$("#back").onclick = () => (location.hash = "");

// ── one chat ───────────────────────────────────────────────────────────────

function renderChatChrome() {
  const c = state.chats.get(state.current);
  if (!c) return;
  $("#chat-name").textContent = c.name;
  $("#chat-status").textContent = STATUS[c.status] || "";
  $("#chat-avatar").innerHTML = avatar(c);
  $("#stop").hidden = !(c.status === "working" || c.status === "approval");
  $("#ended").hidden = c.status !== "ended";
  $("#composer").hidden = c.status === "ended";
  const wasTyping = !$("#typing").hidden;
  $("#typing").hidden = !(c.status === "working" || c.status === "starting");
  if (!wasTyping && !$("#typing").hidden && nearBottom()) scrollDown();

  const card = $("#approval");
  card.hidden = !c.pending;
  if (c.pending) {
    $("#approval-tool").textContent = c.pending.tool;
    $("#approval-why").textContent = c.pending.why;
    $("#approval-why").hidden = !c.pending.why;
    $("#approval-detail").textContent = c.pending.detail;
    card.dataset.req = c.pending.reqId;
  }
  markSeen(c);
}

function markSeen(c) {
  if (c.id !== state.current || document.visibilityState !== "visible") return;
  state.seen[c.id] = c.count;
  write("seen", state.seen);
}

async function loadMessages(id) {
  try {
    const msgs = await api(`/api/chats/${id}/messages`);
    state.messages.set(id, msgs);
    if (state.current !== id) return;
    $("#messages").innerHTML = msgs.map(msgHtml).join("");
    scrollDown();
  } catch (e) { toast(e.message); }
}

function appendMessages(msgs) {
  if (!msgs.length) return;
  const stick = nearBottom() || msgs.some((m) => m.role === "user");
  $("#messages").insertAdjacentHTML("beforeend", msgs.map(msgHtml).join(""));
  if (stick) scrollDown();
}

function msgHtml(m) {
  if (m.role === "tool") return `<div class="tool${m.error ? " error" : ""}">${m.error ? "✕ " : "⚙︎ "}${esc(m.text)}</div>`;
  if (m.role === "system") return `<div class="system">${esc(m.text)}</div>`;
  const body = m.role === "assistant" ? md(m.text) : esc(m.text);
  return `<div class="msg ${m.role}">${body}<span class="t">${clock(m.at)}</span></div>`;
}
// Tap a tool line to see all of it.
$("#messages").addEventListener("click", (e) => e.target.closest(".tool")?.classList.toggle("open"));

// Just enough Markdown for Claude's replies: code blocks, `code`, **bold**, headings, links.
function md(src) {
  const parts = src.split(/```[^\n]*\n?([\s\S]*?)```/g); // odd entries are code blocks
  return parts.map((part, i) => {
    if (i % 2) return `<pre><code>${esc(part.replace(/\n$/, ""))}</code></pre>`;
    return esc(parts.length > 1 ? part.replace(/^\n+|\n+$/g, "") : part)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
      .replace(/^#{1,6} +(.+)$/gm, "<b>$1</b>")
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  }).join("");
}

const scroller = $("#scroller");
const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 150;
const scrollDown = () => requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));

// ── typing and sending ─────────────────────────────────────────────────────

const input = $("#input");
function grow() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, innerHeight * 0.4)}px`;
}
function saveDraft() {
  if (!state.current) return;
  if (input.value.trim()) state.drafts[state.current] = input.value; else delete state.drafts[state.current];
  write("drafts", state.drafts);
}
input.addEventListener("input", () => { grow(); saveDraft(); });
// On a computer, Enter sends and Shift+Enter makes a new line. On the phone, use the send button.
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && matchMedia("(pointer: fine)").matches) { e.preventDefault(); send(); }
});
// Keep the keyboard open when tapping the buttons.
for (const b of ["#send", "#stop"]) $(b).addEventListener("pointerdown", (e) => e.preventDefault());

let sending = false;
$("#send").onclick = send;
async function send() {
  const text = input.value.trim();
  if (!text || sending || !state.current) return;
  sending = true;
  $("#send").disabled = true;
  $("#send").classList.add("busy");
  try {
    await api(`/api/chats/${state.current}/send`, { body: { text } });
    input.value = "";
    grow();
    saveDraft();
  } catch (e) {
    toast(e.message);
  } finally {
    sending = false;
    $("#send").disabled = false;
    $("#send").classList.remove("busy");
  }
}

const pressKey = (key) => api(`/api/chats/${state.current}/key`, { body: { key } }).catch((e) => toast(e.message));
$("#stop").onclick = () => pressKey("esc");

async function answer(decision) {
  const reqId = $("#approval").dataset.req;
  for (const b of ["#approve", "#deny"]) $(b).disabled = true;
  try { await api(`/api/chats/${state.current}/approve`, { body: { decision, reqId } }); }
  catch (e) { toast(e.message); }
  finally { for (const b of ["#approve", "#deny"]) $(b).disabled = false; }
}
$("#approve").onclick = () => answer("allow");
$("#deny").onclick = () => answer("deny");

$("#resume").onclick = () => api(`/api/chats/${state.current}/resume`, { body: {} }).catch((e) => toast(e.message));

// ── sheets: new chat, menu, Mac screen ─────────────────────────────────────

function openSheet(sel) { closeSheets(); $(sel).hidden = false; }
function closeSheets() { for (const s of document.querySelectorAll(".sheet")) s.hidden = true; }
for (const s of document.querySelectorAll(".sheet")) {
  s.addEventListener("click", (e) => { if (e.target === s || e.target.closest(".close")) closeSheets(); });
}

$("#new-chat").onclick = () => {
  openSheet("#new-sheet");
  $("#new-name").value = "";
  $("#new-name").focus();
};
$("#new-form").onsubmit = async (e) => {
  e.preventDefault();
  $("#new-go").disabled = true;
  try {
    const c = await api("/api/chats", { body: { name: $("#new-name").value } });
    state.chats.set(c.id, c);
    location.hash = `chat/${c.id}`;
  } catch (err) {
    toast(err.message);
  } finally {
    $("#new-go").disabled = false;
  }
};

$("#menu-btn").onclick = () => openSheet("#menu");
$("#open-mac").onclick = async () => {
  closeSheets();
  try { await api(`/api/chats/${state.current}/terminal`, { body: {} }); toast("Opened in a Terminal window on the Mac."); }
  catch (e) { toast(e.message); }
};
$("#rename").onclick = async () => {
  closeSheets();
  const c = state.chats.get(state.current);
  const name = prompt("Chat name", c?.name || "");
  if (name?.trim()) await api(`/api/chats/${state.current}`, { method: "PATCH", body: { name } }).catch((e) => toast(e.message));
};
$("#end-chat").onclick = async () => {
  closeSheets();
  if (!confirm("End this chat?\n\nClaude stops and the chat leaves this list. Anything it made stays in your project folder.")) return;
  try { await api(`/api/chats/${state.current}`, { method: "DELETE" }); location.hash = ""; }
  catch (e) { toast(e.message); }
};

// The Mac screen: exactly what the Terminal shows, for menus the chat view can't show.
let screenTimer;
$("#screen-btn").onclick = () => { openSheet("#screen"); pollScreen(); };
async function pollScreen() {
  clearTimeout(screenTimer);
  if ($("#screen").hidden || !state.current) return;
  try {
    const { text } = await api(`/api/chats/${state.current}/screen`);
    const pre = $("#screen-text");
    pre.textContent = text.replace(/\s+$/, "");
    pre.scrollTop = pre.scrollHeight;
  } catch {}
  screenTimer = setTimeout(pollScreen, 1500);
}
$("#screen .keys").addEventListener("click", async (e) => {
  const key = e.target.closest("button")?.dataset.key;
  if (!key) return;
  await pressKey(key);
  setTimeout(pollScreen, 300);
});

// ── keep the typing bar above the iPhone keyboard ──────────────────────────

const vv = window.visualViewport;
function fitToKeyboard() {
  const view = $("#chat-view");
  view.style.height = `${vv.height}px`;
  view.style.top = `${vv.offsetTop}px`;
}
if (vv) {
  vv.addEventListener("resize", () => { const stick = nearBottom(); fitToKeyboard(); if (stick) scrollDown(); });
  vv.addEventListener("scroll", fitToKeyboard);
}

route();
connect();

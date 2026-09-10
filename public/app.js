// Claude Chats — the phone side. Everything here talks to server.mjs on the Mac.
// It is dressed as WhatsApp on the iPhone: the Chats list, green bubbles with ticks, the wallpaper,
// "online / typing… / last seen" under the name, and a chat info page when you tap the name.

const $ = (sel) => document.querySelector(sel);
const state = {
  chats: new Map(),    // id → summary from the server
  messages: new Map(), // id → messages, once a chat has been opened
  current: null,       // id of the open chat
  online: true,        // false while the phone can't reach the Mac
  hintUntil: 0,        // until this time, the chat's top bar says "tap here for chat info"
  seen: read("seen", {}),        // id → how many of Claude's messages you've seen (for unread badges)
  drafts: read("drafts", {}),    // id → half-typed message
  filter: read("filter", "all"), // which chip is picked above the chat list
  search: "",
  projects: null,                // project folders for New chat, once loaded
};
// What the top of a chat says under its name. "online" means Claude is running and waiting for you.
const STATUS = { starting: "starting…", working: "typing…", approval: "needs your approval", idle: "online" };
const isWorking = (c) => c.status === "working" || c.status === "starting";

function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Small drawings that get used in more than one place.
const ICON = {
  ticks: `<svg class="ticks" width="17" height="11" viewBox="0 0 17 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5.8l3 3L10.6 2.2M7 7.8l1 1 6.6-6.6"/></svg>`,
  steps: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3l4 4-4 4M8 11h4"/></svg>`,
  chevron: `<svg class="chev" width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l4 4-4 4"/></svg>`,
};

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
// Like WhatsApp: when the phone can't reach the Mac, the title says "Connecting…".
function setOnline(on) {
  state.online = on;
  const title = $("#nav-title");
  title.classList.toggle("offline", !on);
  title.innerHTML = on ? "Chats" : `<span class="spin"></span>Connecting…`;
  renderChatChrome();
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

function avatar(c, size = "") {
  let h = 0;
  for (const ch of c.id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const initial = [...(c.name || "?").trim()][0]?.toUpperCase() || "?";
  return `<div class="avatar ${size}" style="background:hsl(${h} 38% 48%)">${esc(initial)}</div>`;
}

const clock = (ts) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const sameDay = (a, b) => a.toDateString() === b.toDateString();
const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return d; };

// The time on the right of a chat row: "14:32", "Yesterday", "Tue", "03/09/26".
function when(ts) {
  const d = new Date(ts), now = new Date();
  if (sameDay(d, now)) return clock(ts);
  if (sameDay(d, yesterday())) return "Yesterday";
  if (now - d < 6 * 864e5) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "2-digit" });
}

const unreadOf = (c) => Math.max(0, c.count - (state.seen[c.id] ?? 0));

// Does a chat belong under the chip that's picked, and match what's typed in Search?
function matches(c) {
  const f = state.filter;
  if (f === "unread" && !(unreadOf(c) || c.pending)) return false;
  if (f === "working" && !(isWorking(c) || c.status === "approval")) return false;
  if (f === "stopped" && c.status !== "ended") return false;
  const q = state.search.trim().toLowerCase();
  return !q || c.name.toLowerCase().includes(q) || (c.lastText || "").toLowerCase().includes(q);
}

const NOTHING = { all: "No chats found", unread: "No unread chats", working: "Claude isn't working in any chat right now", stopped: "No stopped chats" };

function renderList() {
  const all = [...state.chats.values()].sort((a, b) => !!b.pending - !!a.pending || b.lastAt - a.lastAt);
  const shown = all.filter(matches);
  $("#chat-list").innerHTML = !all.length
    ? `<div class="empty"><p>No chats yet.</p><p>Tap <b>+</b> to start one. A Terminal window with Claude Code opens on the Mac, ready to go.</p></div>`
    : shown.length ? shown.map(rowHtml).join("") : `<div class="empty">${NOTHING[state.filter]}</div>`;
  for (const chip of document.querySelectorAll(".chip")) chip.classList.toggle("on", chip.dataset.filter === state.filter);
  renderBackCount();
}

// Chat previews drop Markdown symbols so they read like plain messages.
const plain = (s) => String(s || "").replace(/```[^\n]*\n?/g, "").replace(/[*`#]+/g, "").replace(/\s+/g, " ").trim();

function rowHtml(c) {
  const unread = c.id === state.current ? 0 : unreadOf(c);
  let badge = unread ? `<span class="badge">${unread}</span>` : "";
  let preview;
  if (c.pending) {
    preview = `<span class="warn-text">Wants to run: ${esc(c.pending.detail)}</span>`;
    badge = `<span class="badge warn">!</span>`;
  } else if (isWorking(c)) {
    preview = `<span class="typing-text">${STATUS[c.status]}</span>`;
  } else {
    const text = plain(c.lastText);
    // Your own last message gets ticks instead of "You:", the way WhatsApp shows it.
    preview = text.startsWith("You: ") ? ICON.ticks + esc(text.slice(5)) : esc(text || "No messages yet");
    if (c.status === "ended") preview = `Stopped · ${preview}`;
  }
  return `<button class="row${unread ? " unread" : ""}" data-id="${c.id}">${avatar(c)}
    <div class="meta">
      <div class="top"><span class="name">${esc(c.name)}</span><span class="time">${when(c.lastAt)}</span></div>
      <div class="bottom"><span class="ptext">${preview}</span>${badge}</div>
    </div></button>`;
}

$("#chat-list").addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (row) location.hash = `chat/${row.dataset.id}`;
});
$("#chips").addEventListener("click", (e) => {
  const f = e.target.closest(".chip")?.dataset.filter;
  if (!f) return;
  state.filter = f;
  write("filter", f);
  renderList();
});
$("#search").addEventListener("input", (e) => { state.search = e.target.value; renderList(); });

// The big "Chats" title scrolls away and a small one appears in the bar, as on the iPhone.
const listScroll = $("#list-scroll");
listScroll.addEventListener("scroll", () => $("#list-nav").classList.toggle("scrolled", listScroll.scrollTop > 40), { passive: true });

// ── moving between the list and a chat (uses the URL, so the back gesture works) ──

function route() {
  saveDraft();
  const id = location.hash.match(/^#chat\/([\w-]+)/)?.[1] || null;
  state.current = id;
  $("#list-view").hidden = !!id;
  $("#chat-view").hidden = !id;
  closeSheets();
  if (id) {
    // For the first few seconds the top bar says "tap here for chat info", like WhatsApp.
    state.hintUntil = Date.now() + 3000;
    clearTimeout(route.hint);
    route.hint = setTimeout(renderChatChrome, 3100);
    $("#messages").innerHTML = "";
    resetGroups();
    input.value = state.drafts[id] || "";
    grow();
    renderChatChrome();
    loadMessages(id);
  } else {
    renderList();
  }
}
window.addEventListener("hashchange", route);
$("#back").onclick = () => (location.hash = "");

// The number next to the back arrow: other chats with something new.
function renderBackCount() {
  const n = [...state.chats.values()].filter((c) => c.id !== state.current && (unreadOf(c) || c.pending)).length;
  $("#back-count").textContent = n || "";
}

// ── one chat ───────────────────────────────────────────────────────────────

function lastSeen(ts) {
  const d = new Date(ts);
  if (sameDay(d, new Date())) return `today at ${clock(ts)}`;
  if (sameDay(d, yesterday())) return `yesterday at ${clock(ts)}`;
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} at ${clock(ts)}`;
}

function subtitle(c) {
  if (!state.online) return "connecting…";
  if (c.status !== "idle" && c.status !== "ended") return STATUS[c.status] || "";
  if (Date.now() < state.hintUntil) return "tap here for chat info";
  return c.status === "idle" ? "online" : `last seen ${lastSeen(c.lastAt)}`;
}

function renderChatChrome() {
  const c = state.chats.get(state.current);
  if (!c) return;
  $("#chat-name").textContent = c.name;
  $("#chat-status").textContent = subtitle(c);
  $("#chat-avatar").innerHTML = avatar(c, "small");
  $("#stop").hidden = !(c.status === "working" || c.status === "approval");
  $("#ended").hidden = c.status !== "ended";
  $("#composer").hidden = c.status === "ended";
  const wasTyping = !$("#typing").hidden;
  $("#typing").hidden = !isWorking(c);
  if (!wasTyping && isWorking(c) && nearBottom()) scrollDown();
  // Claude has picked up your message → blue ticks.
  if (c.status === "working" || c.status === "approval") markAllRead();

  const card = $("#approval");
  card.hidden = !c.pending;
  if (c.pending) {
    $("#approval-tool").textContent = c.pending.tool;
    $("#approval-why").textContent = c.pending.why;
    $("#approval-why").hidden = !c.pending.why;
    $("#approval-detail").textContent = c.pending.detail;
    card.dataset.req = c.pending.reqId;
  }
  renderBackCount();
  if (!$("#info").hidden) fillInfo(c);
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
    resetGroups();
    $("#messages").innerHTML = "";
    addMessages(msgs);
    const c = state.chats.get(id);
    if (c && (c.status === "working" || c.status === "approval")) markAllRead();
    scrollDown();
  } catch (e) { toast(e.message); }
}

function appendMessages(msgs) {
  if (!msgs.length) return;
  const stick = nearBottom() || msgs.some((m) => m.role === "user");
  addMessages(msgs);
  if (stick) scrollDown();
}

// Messages are laid out the WhatsApp way: a date pill when the day changes, a tail only on the
// first bubble of a run from the same side, and Claude's steps folded into one bubble.
// `group` remembers where the last message left off, so live ones join the right run.
let group;
function resetGroups() { group = { day: "", side: null, tools: null }; }
resetGroups();

function el(tag, cls, html = "") {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.innerHTML = html;
  return e;
}

function addMessages(msgs) {
  const box = $("#messages");
  for (const m of msgs) addMessage(box, m);
  updateTicks();
}

function addMessage(box, m) {
  const day = dayLabel(m.at);
  if (day !== group.day) {
    box.append(el("div", "day", esc(day)));
    group = { day, side: null, tools: null };
  }
  if (m.role === "system") {
    box.append(el("div", "system", esc(m.text)));
    group.side = null;
    group.tools = null;
    return;
  }
  if (m.role === "tool") {
    if (!group.tools) {
      group.tools = el("div", `bubble in tools${group.side === "in" ? "" : " tail"}`,
        `<div class="tools-sum">${ICON.steps}<span class="n"></span><span class="last"></span>${ICON.chevron}</div><ol class="tools-list"></ol>`);
      box.append(group.tools);
      group.side = "in";
    }
    const t = group.tools;
    t.querySelector(".tools-list").append(el("li", m.error ? "error" : "", esc(m.text)));
    const n = t.querySelectorAll("li:not(.error)").length;
    t.querySelector(".n").textContent = n === 1 ? "1 step" : `${n} steps`;
    const last = t.querySelector(".last");
    last.textContent = m.text;
    last.classList.toggle("error", !!m.error);
    return;
  }
  const side = m.role === "user" ? "out" : "in";
  const body = side === "in" ? md(m.text) : esc(m.text);
  box.append(el("div", `bubble ${side}${group.side === side ? "" : " tail"}`,
    `${body}<span class="spacer${side === "out" ? " wide" : ""}"></span><span class="stamp">${clock(m.at)}${side === "out" ? ICON.ticks : ""}</span>`));
  group.side = side;
  group.tools = null;
}

// Grey ticks = your message reached Claude. Blue = Claude has answered or is working on it.
function updateTicks() {
  let answered = false;
  const kids = $("#messages").children;
  for (let i = kids.length - 1; i >= 0; i--) {
    const k = kids[i];
    if (k.classList.contains("in")) answered = true;
    else if (answered && k.classList.contains("out")) {
      const t = k.querySelector(".ticks");
      if (t.classList.contains("read")) break; // everything older is already blue
      t.classList.add("read");
    }
  }
}
function markAllRead() {
  for (const t of document.querySelectorAll("#messages .ticks:not(.read)")) t.classList.add("read");
}

// The date pill: "Today", "Yesterday", "Monday", "Wed 3 Sept".
function dayLabel(ts) {
  const d = new Date(ts), now = new Date();
  if (sameDay(d, now)) return "Today";
  if (sameDay(d, yesterday())) return "Yesterday";
  if (now - d < 6 * 864e5) return d.toLocaleDateString("en-GB", { weekday: "long" });
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

// Tap Claude's steps to see all of them.
$("#messages").addEventListener("click", (e) => e.target.closest(".tools")?.classList.toggle("open"));

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
  $("#composer").classList.toggle("has-text", !!input.value.trim()); // the send button appears once you type
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

// ── sheets: new chat, list menu, chat info, Mac screen ─────────────────────

function openSheet(sel) { closeSheets(); $(sel).hidden = false; }
function closeSheets() { for (const s of document.querySelectorAll(".sheet")) s.hidden = true; }
for (const s of document.querySelectorAll(".sheet")) {
  s.addEventListener("click", (e) => { if (e.target === s || e.target.closest(".close")) closeSheets(); });
}

// New chat lists your projects like WhatsApp lists contacts. Tap one and Claude starts in that folder.
$("#new-chat").onclick = async () => {
  openSheet("#new-sheet");
  $("#new-search").value = "";
  renderProjects();
  try { state.projects = await api("/api/projects"); renderProjects(); } catch (e) { toast(e.message); }
};
$("#new-search").addEventListener("input", renderProjects);

function renderProjects() {
  const box = $("#project-list");
  if (!state.projects) return (box.innerHTML = `<div class="cell muted">Loading…</div>`);
  const q = $("#new-search").value.trim().toLowerCase();
  const list = state.projects.filter((p) => p.name.toLowerCase().includes(q));
  box.innerHTML = list.length ? list.map(projectRow).join("") : `<div class="cell muted">No projects match</div>`;
}
function projectRow(p) {
  const open = [...state.chats.values()].filter((c) => c.project === p.name && c.status !== "ended").length;
  const note = `${open ? `${open} open chat${open > 1 ? "s" : ""} · ` : ""}changed ${ago(p.changedAt)}`;
  return `<button class="cell pick" data-project="${esc(p.name)}">${avatar({ id: p.name, name: p.name }, "small")}
    <span class="pick-text"><b>${esc(p.name)}</b><small>${note}</small></span></button>`;
}
// "today", "yesterday", "3 days ago", "12 Aug" — counted in calendar days.
function ago(ts) {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 864e5);
  if (days < 1) return "today";
  if (days === 1) return "yesterday";
  return days < 7 ? `${days} days ago` : new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

let starting = false;
$("#new-sheet").addEventListener("click", async (e) => {
  const pick = e.target.closest(".pick");
  if (!pick || starting) return;
  starting = true;
  pick.classList.add("busy");
  try {
    const c = await api("/api/chats", { body: { project: pick.dataset.project || undefined } });
    state.chats.set(c.id, c);
    location.hash = `chat/${c.id}`;
  } catch (err) {
    toast(err.message);
  } finally {
    starting = false;
    pick.classList.remove("busy");
  }
});

$("#list-more").onclick = () => openSheet("#list-menu");
$("#read-all").onclick = () => {
  for (const c of state.chats.values()) state.seen[c.id] = c.count;
  write("seen", state.seen);
  closeSheets();
  renderList();
};

// Tapping the name at the top opens the chat's info page, as it does in WhatsApp.
$("#chat-head").onclick = () => { openSheet("#info"); fillInfo(state.chats.get(state.current)); };
function fillInfo(c) {
  if (!c) return;
  $("#info-avatar").innerHTML = avatar(c, "big");
  $("#info-name").textContent = c.name;
  $("#info-sub").textContent = `Claude Code on your Mac · ${c.status === "ended" ? "stopped" : "running"}`;
  $("#info-folder").textContent = c.project || "Whole project folder";
  $("#info-started").textContent = new Date(c.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  $("#info-count").textContent = c.count;
  $("#open-mac").disabled = c.status === "ended";
}
$("#info-screen").onclick = () => { openSheet("#screen"); pollScreen(); };
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

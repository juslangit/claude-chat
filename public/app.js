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
  sound: read("sound", true),    // the pop when Claude answers
  lastStep: null,                // the open chat's latest step, for the "typing…" bubble
  computers: [],                 // every computer running claude-chat that this phone can reach
  pinned: read("pinned", []),    // keys of pinned chats, newest pin first
};
// Chats from every computer share one list. A chat's key is "<computer>/<chat id>"; "home" is the
// computer this page came from.
const home = { id: "home", base: "", name: "", online: false };
state.computers.push(home);
const keyOf = (comp, id) => `${comp.id}/${id}`;
const tag = (comp, c) => ({ ...c, key: keyOf(comp, c.id), comp: comp.id });
const compOf = (c) => state.computers.find((x) => x.id === c?.comp) || home;
const cur = () => state.chats.get(state.current);
// What the top of a chat says under its name. "online" means Claude is running and waiting for you.
const STATUS = { starting: "starting…", working: "typing…", approval: "needs your approval", idle: "online" };
const isWorking = (c) => c?.status === "working" || c?.status === "starting";

// Messages you speak carry a short tag at the end, so Claude knows they came through speech
// recognition (and, on a call, to answer briefly). The phone hides the tag and shows a mic instead.
const VOICE_NOTE = "\n\n[🎤 voice note: typed by speech recognition, so a word may be misheard]";
const VOICE_CALL = "\n\n[📞 voice call: typed by speech recognition. Reply in one to three short spoken sentences, with no code, tables, lists or links]";
const VOICE_TAG = /\n\n\[(🎤|📞) voice (note|call)[^\]]*\]$/u;
function splitVoice(text) {
  const s = String(text || ""), m = s.match(VOICE_TAG);
  return m ? { text: s.slice(0, m.index), kind: m[2] } : { text: s, kind: null };
}
// A photo you send reaches Claude as a line saying where it was saved; the phone shows the photo instead.
const PHOTO_TAG = /^\[📷 photo from my phone: (.+?) — open it to see it\]\s*/u;
function splitPhoto(text) {
  const s = String(text || ""), m = s.match(PHOTO_TAG);
  return m ? { photo: m[1].split("/").pop(), text: s.slice(m[0].length) } : { photo: null, text: s };
}
// A reply (swipe a message to the right) starts by quoting the message it answers.
const REPLY_TAG = /^Replying to (your|my) message: "([\s\S]*?)"\n\n/;
function splitReply(text) {
  const s = String(text || ""), m = s.match(REPLY_TAG);
  return m ? { quote: m[2], who: m[1] === "your" ? "Claude" : "You", text: s.slice(m[0].length) } : { quote: null, who: null, text: s };
}
// The chat list's preview: a photo shows as "📷 Photo", and a reply without the message it quotes.
function previewOf(last) {
  let s = String(last || "");
  const you = s.startsWith("You: ");
  if (you) s = s.slice(5);
  s = splitReply(splitVoice(s).text).text;
  const pic = splitPhoto(s);
  if (pic.photo) s = `📷 ${pic.text || "Photo"}`;
  return (you ? "You: " : "") + s;
}

function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function write(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Small drawings that get used in more than one place.
const ICON = {
  ticks: `<svg class="ticks" width="17" height="11" viewBox="0 0 17 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 5.8l3 3L10.6 2.2M7 7.8l1 1 6.6-6.6"/></svg>`,
  steps: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3l4 4-4 4M8 11h4"/></svg>`,
  chevron: `<svg class="chev" width="8" height="12" viewBox="0 0 8 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l4 4-4 4"/></svg>`,
  mic: `<svg class="voice" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>`,
  phone: `<svg class="voice" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3.5h3.2l1.6 4-2.1 1.5a11 11 0 0 0 7.3 7.3l1.5-2.1 4 1.6V19a1.8 1.8 0 0 1-1.9 1.8C10.3 20.3 3.7 13.7 3.2 5.4A1.8 1.8 0 0 1 5 3.5z"/></svg>`,
  pin: `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M14.5 2.5l7 7-2.3.9-3.6 3.6.6 4.6-1.6 1.6-4.2-4.2L5 21.4 3.6 20l5.4-5.4-4.2-4.2 1.6-1.6 4.6.6 3.6-3.6z"/></svg>`,
};

// Talk to a computer's server (this one unless another is given).
async function api(path, { method, body, timeout } = {}, comp = home) {
  const res = await fetch(comp.base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: { "content-type": "application/json" },
    body: body && JSON.stringify(body),
    signal: timeout ? AbortSignal.timeout(timeout) : undefined,
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

// A chat's own requests go to the computer it runs on.
const chatApi = (c, sub, opts) => api(`/api/chats/${c.id}${sub}`, opts, compOf(c));

function connect(comp) {
  clearTimeout(comp.retry);
  comp.source?.close();
  const src = (comp.source = new EventSource(`${comp.base}/events`));
  comp.heard = Date.now();
  src.onopen = () => { comp.heard = Date.now(); comp.tries = 0; setComputerOnline(comp, true); if (comp === home) checkVersion(); refreshComputer(comp); };
  src.onerror = () => {
    setComputerOnline(comp, false);
    // Safari gives up for good when the computer answers with an error — tailscale serve does, while
    // claude-chat restarts — and the app sat on "Connecting…" until you left it and came back. So try
    // again here: after 2 seconds, then 4, 8, 16, and every 30 after that.
    if (src.readyState === EventSource.CLOSED && comp.source === src) {
      comp.tries = (comp.tries || 0) + 1;
      comp.retry = setTimeout(() => connect(comp), Math.min(30000, 1000 * 2 ** comp.tries));
    }
  };
  src.onmessage = (e) => { comp.heard = Date.now(); onEvent(JSON.parse(e.data), comp); };
  src.addEventListener("ping", () => (comp.heard = Date.now()));
}
// Each computer pings every 20 seconds. A minute of silence means the line died without saying so — the
// computer dropped off Wi-Fi, and nothing ever tells the phone. Show it as offline from when it was last
// heard, and try a fresh line; the moment one opens, it's back online.
setInterval(() => {
  if (document.visibilityState !== "visible") return;
  for (const comp of state.computers) {
    if (!comp.source || Date.now() - comp.heard < 60000) continue;
    setComputerOnline(comp, false, comp.heard);
    connect(comp);
  }
}, 15000);

function setComputerOnline(comp, on, since = Date.now()) {
  const changed = comp.online !== on || (!on && comp.offlineSince == null);
  const wasOnline = comp.online;
  comp.online = on;
  if (on) { comp.offlineSince = null; comp.lastSeen = null; } else comp.offlineSince ??= since;
  if (comp === home) setOnline(on);
  if (!changed) return;
  if (on) {
    tellLooking(document.visibilityState === "visible", [comp]); // a computer that's back hears whether you're looking
    if (read("push", false)) shareSubscription(comp);           // and gets this phone's push address
  }
  renderList();
  renderComputers();
  if (cur()?.comp === comp.id) renderChatChrome();
  if (wasOnline && !on) findComputers(); // ask the other computers when Tailscale last saw it
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
  tellLooking(document.visibilityState === "visible");
  if (document.visibilityState !== "visible") return pauseCall();
  for (const comp of state.computers) {
    // Pings come every 20 s, so nothing for 25 s means the line died while the phone was away.
    if (!comp.source || comp.source.readyState === EventSource.CLOSED || Date.now() - comp.heard > 25000) connect(comp);
    else refreshComputer(comp);
  }
  findComputers();
  checkVersion();
  resumeCall();
});

function onEvent(ev, comp = home) {
  if (ev.type === "chat") {
    const c = tag(comp, ev.chat), old = state.chats.get(c.key);
    state.chats.set(c.key, c);
    if (old && !(call.on && call.chatId === c.key)) { // on a call you hear the reply instead
      if (c.count > old.count) pop();
      else if (c.pending && !old.pending) pop("alert");
    }
    if (c.key === state.current && isWorking(c) && !isWorking(old)) state.lastStep = null; // a new turn
    renderList();
    if (c.key === state.current) renderChatChrome();
    callChatChanged(old, c);
  } else if (ev.type === "note") {
    if (call.on && keyOf(comp, ev.chatId) === call.chatId) sayOnce(ev.text);
  } else if (ev.type === "removed") {
    const key = keyOf(comp, ev.id);
    state.chats.delete(key);
    state.messages.delete(key);
    if (state.current === key) location.hash = "";
    renderList();
  } else if (ev.type === "messages") {
    const key = keyOf(comp, ev.chatId);
    loading.get(key)?.push(...ev.messages); // the chat's history is loading: these go after it
    const list = state.messages.get(key);
    if (!list) return;
    const seen = new Set(list.map((m) => m.id));
    const fresh = ev.messages.filter((m) => !seen.has(m.id));
    list.push(...fresh);
    if (key === state.current) appendMessages(fresh);
    if (call.on && key === call.chatId) {
      // A question is read out from the question card instead (sayQuestion), one at a time.
      for (const m of fresh) if (m.role === "assistant" && !m.ask && m.at >= call.since - 5000) { call.awaiting = false; sayOnce(m.text); }
    }
  } else if (ev.type === "reset") {
    const key = keyOf(comp, ev.chatId);
    state.messages.delete(key);
    if (key === state.current) loadMessages(key);
  }
}

// Fetch one computer's chats again, replacing what the list had for it.
async function refreshComputer(comp) {
  try {
    const list = await api("/api/chats", {}, comp);
    for (const [key, c] of state.chats) if (c.comp === comp.id) state.chats.delete(key);
    for (const c of list) state.chats.set(keyOf(comp, c.id), tag(comp, c));
    renderList();
    if (cur()?.comp === comp.id) { renderChatChrome(); await loadMessages(state.current); }
  } catch (e) { if (comp === home) toast(e.message); }
}

// ── the other computers ────────────────────────────────────────────────────
// This computer lists the others it can see on your Tailscale network; each one that answers
// /api/whoami is running claude-chat, and its chats join the list. Ones found before are
// remembered, so they're tried even if this computer can't see them right now.
async function startComputers() {
  connect(home);
  try { Object.assign(home, await api("/api/whoami")); } catch {}
  renderComputers();
  findComputers();
  setInterval(() => { findComputers(); checkVersion(); }, 120000);
}

// A Home Screen app can stay open for days, so after an update the phone could keep running the old
// page (and, say, show Approve / Deny for a question that needs answer buttons). The computer this page
// came from reports a version of its page files; when that changes, reload. Not during a call or a voice
// note — it tries again at the next check. A half-typed message is kept, as drafts always are.
async function checkVersion() {
  let v;
  try { v = (await api("/api/whoami", { timeout: 5000 })).version; } catch { return; }
  if (!v || !home.version || v === home.version) { home.version ||= v; return; }
  if (call.on || recording) return;
  try {
    if (sessionStorage.getItem("reloadedFor") === v) return; // already reloaded for this one; don't loop
    sessionStorage.setItem("reloadedFor", v);
  } catch {}
  saveDraft();
  location.reload();
}
// Every computer that answers lists the others on your tailnet, with when Tailscale last saw the ones
// that are off. Asking all of them means "offline since" still works when the Mac is the one that's gone.
async function findComputers() {
  const lists = await Promise.all(state.computers.filter((c) => c === home || c.online)
    .map((c) => api("/api/computers", { timeout: 5000 }, c).catch(() => [])));
  const peers = lists.flat();
  for (const comp of state.computers) {
    const seen = peers.find((p) => p.url === (comp === home ? home.url : comp.base))?.lastSeen;
    if (!comp.online && seen) comp.lastSeen = seen;
  }
  const urls = peers.filter((p) => p.online !== false).map((p) => p.url);
  for (const k of read("computers", [])) if (!urls.includes(k)) urls.push(k);
  await Promise.all(urls.map(addComputer));
  renderComputers();
  renderList();
  if (cur() && !compOf(cur()).online) renderChatChrome();
}
async function addComputer(base) {
  if (!base || base === home.url || state.computers.some((c) => c.base === base)) return;
  try {
    const who = await api("/api/whoami", { timeout: 4000 }, { base });
    if (who.url && who.url === home.url) return; // this computer, reached by another address
    const comp = { id: new URL(base).host.replace(/[^\w]/g, "-"), base, name: who.name, os: who.os, online: false };
    state.computers.push(comp);
    write("computers", state.computers.filter((c) => c.base).map((c) => c.base));
    connect(comp);
  } catch {} // not running claude-chat, or switched off right now
}

// Which computer a chat is on, shown in the list once there's more than one.
function whereLabel(c) {
  if (state.computers.length < 2) return "";
  const comp = compOf(c);
  return `<span class="where">${esc(comp.name || "This computer")}${comp.online ? "" : " (offline)"}</span> · `;
}

// "offline since 19:43": when Tailscale last saw it (asked of the other computers), or else when this
// phone lost it.
function offlineText(comp) {
  const t = comp.lastSeen || comp.offlineSince;
  return t ? `offline since ${sameDay(new Date(t), new Date()) ? clock(t) : lastSeen(t)}` : "offline";
}

function renderComputers() {
  $("#computers-count").textContent = state.computers.filter((c) => c.online).length;
  $("#computer-list").innerHTML = state.computers.map((c) => `<div class="cell computer">
      <span class="pick-text"><b>${esc(c.name || "This computer")}</b><small>${c === home ? "This app comes from here" : c.os === "windows" ? "Windows PC" : c.os === "mac" ? "Mac" : "Computer"}</small></span>
      <span class="state ${c.online ? "on" : ""}">${c.online ? "online" : offlineText(c)}</span></div>`).join("");
}

// Above the chat list, a note for each computer the phone can't reach — or one for the phone itself.
function renderOfflineNotes() {
  $("#offline-notes").innerHTML = navigator.onLine === false
    ? `<div class="offline-note"><b>This iPhone is offline.</b><small>Your chats catch up when it's back on the internet.</small></div>`
    : state.computers.filter((c) => !c.online && c.offlineSince).map((c) => `<div class="offline-note">
        <b>${esc(c.name || "This computer")}</b> — ${offlineText(c)}
        <small>It may be asleep, switched off or off Wi-Fi. Its chats catch up when it's back.</small></div>`).join("");
}
addEventListener("online", () => renderList());
addEventListener("offline", () => renderList());

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
  // Pinned chats first, then any waiting for you, then the most recent.
  const all = [...state.chats.values()].sort((a, b) => isPinned(b) - isPinned(a) || !!b.pending - !!a.pending || b.lastAt - a.lastAt);
  const shown = all.filter(matches);
  $("#chat-list").innerHTML = !all.length
    ? `<div class="empty"><p>No chats yet.</p><p>Tap <b>+</b> to start one. A Terminal window with Claude Code opens on the Mac, ready to go.</p></div>`
    : shown.length ? shown.map(rowHtml).join("") : `<div class="empty">${NOTHING[state.filter]}</div>`;
  for (const chip of document.querySelectorAll(".chip")) chip.classList.toggle("on", chip.dataset.filter === state.filter);
  renderOfflineNotes();
  renderBackCount();
}

// Chat previews drop Markdown symbols so they read like plain messages.
const plain = (s) => String(s || "").replace(/```[^\n]*\n?/g, "").replace(/[*`#]+/g, "").replace(/\s+/g, " ").trim();

function rowHtml(c) {
  const unread = c.id === state.current ? 0 : unreadOf(c);
  let badge = unread ? `<span class="badge">${unread}</span>` : "";
  let preview;
  if (c.pending) {
    preview = `<span class="warn-text">${c.pending.questions ? "Asks" : "Wants to run"}: ${esc(c.pending.detail)}</span>`;
    badge = `<span class="badge warn">!</span>`;
  } else if (isWorking(c)) {
    preview = `<span class="typing-text">${STATUS[c.status]}</span>`;
  } else {
    const text = plain(previewOf(c.lastText));
    // Your own last message gets ticks instead of "You:", the way WhatsApp shows it.
    preview = text.startsWith("You: ") ? ICON.ticks + esc(text.slice(5)) : esc(text || "No messages yet");
    if (c.status === "ended") preview = `Stopped · ${preview}`;
  }
  preview = whereLabel(c) + preview;
  return `<button class="row${unread ? " unread" : ""}" data-id="${c.key}" data-swipe="${isPinned(c) ? "Unpin" : "Pin"}">${avatar(c)}
    <div class="meta">
      <div class="top"><span class="name">${esc(c.name)}</span><span class="time">${when(c.lastAt)}</span></div>
      <div class="bottom"><span class="ptext">${preview}</span>${badge}${isPinned(c) ? `<span class="pin">${ICON.pin}</span>` : ""}</div>
    </div></button>`;
}

$("#chat-list").addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (row && Date.now() - swipedAt > 400) location.hash = `chat/${row.dataset.id}`; // not the end of a swipe
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
  endCall(); // leaving a chat hangs up
  saveDraft();
  setReply(null);
  closeFind();
  const m = location.hash.match(/^#chat\/(?:([\w-]+)\/)?([\w-]+)/); // #chat/<computer>/<chat>, or an old #chat/<chat>
  const id = m ? `${m[1] || "home"}/${m[2]}` : null;
  state.current = id;
  $("#list-view").hidden = !!id;
  $("#chat-view").hidden = !id;
  closeSheets();
  if (id) {
    state.lastStep = null; // the progress bubble only ever shows this chat's steps
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
  const comp = compOf(c); // the computer this chat runs on, which isn't always the one the page came from
  if (!comp.online) return comp.offlineSince ? offlineText(comp) : "connecting…";
  if (c.pending?.questions) return "asked you a question";
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
  const stick = nearBottom();
  $("#typing").hidden = !isWorking(c);
  if (isWorking(c)) renderDoing(c);
  if (isWorking(c) && stick) scrollDown();
  // Claude has picked up your message → blue ticks.
  if (c.status === "working" || c.status === "approval") markAllRead();

  const card = $("#approval");
  card.hidden = !c.pending || !!c.pending.questions;
  renderQuestion(c);
  if (!card.hidden) {
    $("#approval-tool").textContent = c.pending.tool;
    $("#approval-why").textContent = c.pending.why;
    $("#approval-why").hidden = !c.pending.why;
    $("#approval-detail").textContent = c.pending.detail;
    card.dataset.req = c.pending.reqId;
  }
  renderBackCount();
  updateQuick();
  if (!$("#info").hidden) fillInfo(c);
  markSeen(c);
}

// The "typing…" bubble also says what Claude is doing: its latest note, and its latest step.
function renderDoing(c) {
  const note = c.note || "", step = state.lastStep || "";
  $("#doing").innerHTML = (note ? `<div class="doing-note">${esc(note)}</div>` : "") + (step ? `<div class="doing-now">▸ ${esc(step)}</div>` : "");
  $("#doing").hidden = !note && !step;
}

function markSeen(c) {
  if (c.id !== state.current || document.visibilityState !== "visible") return;
  state.seen[c.id] = c.count;
  write("seen", state.seen);
}

// Messages that arrive while a chat's history is loading wait here and go after it. Before, they were
// wiped when the history replaced the screen, and came back only when you reopened the chat.
const loading = new Map(); // chat key → messages that arrived during its load

async function loadMessages(id) {
  const c = state.chats.get(id);
  if (!c) return; // its computer hasn't answered yet; refreshComputer calls this again when it does
  const live = [];
  loading.set(id, live);
  try {
    const got = await chatApi(c, "/messages");
    if (loading.get(id) !== live) return; // a newer load of this chat started meanwhile; it wins
    loading.delete(id);
    const have = new Set(got.map((m) => m.id));
    const msgs = [...got, ...live.filter((m) => !have.has(m.id))];
    state.messages.set(id, msgs);
    if (state.current !== id) return;
    resetGroups();
    $("#messages").innerHTML = "";
    addMessages(msgs);
    if (c.status === "working" || c.status === "approval") markAllRead();
    scrollDown();
  } catch (e) {
    if (loading.get(id) === live) loading.delete(id);
    toast(e.message);
  }
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
    t.querySelector(".tools-list").append(el("li", m.error ? "error" : "", esc(m.text) + (m.detail ? `<span class="raw">${esc(m.detail)}</span>` : "")));
    if (!m.error) {
      state.lastStep = m.text;
      const c = state.chats.get(state.current);
      if (isWorking(c)) renderDoing(c);
    }
    const n = t.querySelectorAll("li:not(.error)").length;
    t.querySelector(".n").textContent = n === 1 ? "1 step" : `${n} steps`;
    const last = t.querySelector(".last");
    last.textContent = m.text;
    last.classList.toggle("error", !!m.error);
    return;
  }
  const side = m.role === "user" ? "out" : "in";
  const spoken = side === "out" ? splitVoice(m.text) : { text: m.text, kind: null };
  // Your own messages can open with a quote (a swipe-to-reply) or a photo: both are shown, not spelled out.
  const replied = side === "out" ? splitReply(spoken.text) : { quote: null, text: m.text };
  const pic = side === "out" ? splitPhoto(replied.text) : { photo: null, text: m.text };
  const quote = replied.quote ? `<span class="quote"><b>${replied.who}</b>${esc(replied.quote)}</span>` : "";
  const photo = pic.photo ? `<img class="photo" src="${esc(photoUrl(pic.photo))}" alt="Photo you sent">` : "";
  const body = side === "in" ? md(m.text) : quote + photo + esc(pic.text);
  const voice = spoken.kind ? ICON[spoken.kind === "call" ? "phone" : "mic"] : ""; // said out loud, not typed
  const bubble = el("div", `bubble ${side}${group.side === side ? "" : " tail"}`,
    `${body}<span class="spacer${side === "out" ? " wide" : ""}${voice ? " voiced" : ""}"></span><span class="stamp">${voice}${clock(m.at)}${side === "out" ? ICON.ticks : ""}</span>`);
  // What a swipe-to-reply quotes: the start of the message, as plain words.
  bubble.dataset.who = side === "in" ? "claude" : "you";
  bubble.dataset.quote = plain(side === "in" ? m.text : pic.text || (pic.photo ? "📷 Photo" : "")).slice(0, 300);
  box.append(bubble);
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

// Tap Claude's steps to see all of them, or a photo to see it full screen.
$("#messages").addEventListener("click", (e) => {
  if (Date.now() - swipedAt < 400) return; // the end of a swipe, not a tap
  const img = e.target.closest(".photo");
  if (img) { $("#viewer-img").src = img.src; $("#viewer").hidden = false; return; }
  e.target.closest(".tools")?.classList.toggle("open");
});

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
  updateQuick();
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
    await sendMessage(text);
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

const pressKey = (key) => chatApi(cur(), "/key", { body: { key } }).catch((e) => toast(e.message));
$("#stop").onclick = () => pressKey("esc");

async function answer(decision) {
  const reqId = $("#approval").dataset.req;
  for (const b of ["#approve", "#deny"]) $(b).disabled = true;
  try { await chatApi(cur(), "/approve", { body: { decision, reqId } }); }
  catch (e) { toast(e.message); }
  finally { for (const b of ["#approve", "#deny"]) $(b).disabled = false; }
}
$("#approve").onclick = () => answer("allow");
$("#deny").onclick = () => answer("deny");

// ── Claude's multiple-choice questions ─────────────────────────────────────
// Claude sometimes asks a question with a few answers to pick from. Each choice is a reply
// button; typing or saying something instead answers in your own words. Several questions come
// one at a time, and all the answers go back to Claude together after the last one.

let ask = null; // the question on screen: { reqId, i: which one, answers: { question → answer }, picked: labels ticked so far, busy }
const CHECK = `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5l2.6 2.6L11 4.5"/></svg>`;

function renderQuestion(c) {
  const box = $("#question"), qs = c?.pending?.questions;
  box.hidden = !qs;
  input.placeholder = qs ? "Or type your own answer" : "";
  if (!qs) return (ask = null);
  if (ask?.reqId !== c.pending.reqId) ask = { reqId: c.pending.reqId, i: 0, answers: {}, picked: new Set(), busy: false };
  const q = qs[ask.i];
  const opts = q.options.map((o, n) => `<button data-opt="${n}"${ask.picked.has(o.label) ? ` class="picked"` : ""}>
      <span class="opt"><b>${esc(o.label)}</b>${o.description && o.description !== o.label ? `<small>${esc(o.description)}</small>` : ""}</span>
      ${q.multiSelect ? `<span class="box">${CHECK}</span>` : ""}</button>`).join("");
  box.innerHTML = `<div class="bubble in tail">
      <div class="ask-top">${q.header ? `<span class="ask-chip">${esc(q.header)}</span>` : ""}
        ${qs.length > 1 ? `<span class="ask-count">${ask.i + 1} of ${qs.length}</span>` : ""}<span class="grow"></span>
        ${ask.i ? `<button data-do="back">Back</button>` : ""}<button data-do="skip">Skip</button></div>
      <div class="ask-q">${esc(q.question)}</div>
      <div class="ask-hint">${q.multiSelect ? "Tap all that fit, then Send." : "Tap an answer."} Or type your own below.</div>
    </div>
    <div class="ask-opts">${opts}${q.multiSelect ? `<button data-do="send" class="ask-send"${ask.picked.size ? "" : " disabled"}>Send</button>` : ""}</div>`;
  if (ask.busy) for (const b of box.querySelectorAll("button")) b.disabled = true;
}

$("#question").addEventListener("click", (e) => {
  const b = e.target.closest("button"), c = cur(), q = c?.pending?.questions?.[ask?.i];
  if (!b || !q || ask.busy) return;
  const failed = (err) => toast(err.message);
  if (b.dataset.opt) {
    const label = q.options[b.dataset.opt].label;
    if (!q.multiSelect) return reply(label).catch(failed);
    if (!ask.picked.delete(label)) ask.picked.add(label);
    return renderQuestion(c);
  }
  if (b.dataset.do === "send") return reply(q.options.map((o) => o.label).filter((l) => ask.picked.has(l)).join(", ")).catch(failed);
  if (b.dataset.do === "back") { ask.i--; ask.picked = new Set(); return renderQuestion(c); }
  if (b.dataset.do === "skip") {
    ask.busy = true;
    renderQuestion(c);
    chatApi(c, "/approve", { body: { decision: "deny", reqId: ask.reqId } }).catch((err) => { if (ask) { ask.busy = false; renderQuestion(c); } failed(err); });
  }
});

// Answer the question on screen. After the last one, all the answers go to Claude.
async function reply(text) {
  const c = cur(), qs = c?.pending?.questions;
  if (!qs || ask?.reqId !== c.pending.reqId) throw new Error("That question was already answered.");
  ask.answers[qs[ask.i].question] = text;
  ask.picked = new Set();
  if (ask.i + 1 < qs.length) {
    ask.i++;
    renderQuestion(c);
    if (call.on) { call.awaiting = false; clearTimeout(call.waitTimer); sayQuestion(c); } // on a call, ask the next one out loud
    return;
  }
  ask.busy = true;
  renderQuestion(c);
  try { await chatApi(c, "/answer", { body: { reqId: ask.reqId, answers: ask.answers } }); }
  catch (e) { if (ask) { ask.busy = false; renderQuestion(c); } throw e; } // tap again to retry
}

$("#resume").onclick = () => chatApi(cur(), "/resume", { body: {} }).catch((e) => toast(e.message));

// ── sheets: new chat, list menu, chat info, Mac screen ─────────────────────

function openSheet(sel) { closeSheets(); $(sel).hidden = false; }
function closeSheets() { for (const s of document.querySelectorAll(".sheet")) s.hidden = true; }
for (const s of document.querySelectorAll(".sheet")) {
  s.addEventListener("click", (e) => { if (e.target === s || e.target.closest(".close")) closeSheets(); });
}

// New chat lists your projects like WhatsApp lists contacts. Tap one and Claude starts in that folder.
// With more than one computer, the chips at the top pick which computer it starts on.
let newOn = home;
$("#new-chat").onclick = () => {
  openSheet("#new-sheet");
  $("#new-search").value = "";
  newOn = state.computers.find((c) => c.id === read("newOn", "home") && c.online) || home;
  renderNewComputers();
  loadProjects();
};
$("#new-search").addEventListener("input", renderProjects);
function renderNewComputers() {
  const online = state.computers.filter((c) => c.online);
  $("#new-computers").hidden = online.length < 2;
  $("#new-computers").innerHTML = online.map((c) => `<button class="chip${c === newOn ? " on" : ""}" data-comp="${c.id}">${esc(c.name || "This computer")}</button>`).join("");
  $("#projects-title").textContent = online.length < 2 ? "Your projects" : `Projects on ${newOn.name || "this computer"}`;
}
$("#new-computers").addEventListener("click", (e) => {
  const comp = state.computers.find((c) => c.id === e.target.closest(".chip")?.dataset.comp);
  if (!comp) return;
  newOn = comp;
  write("newOn", comp.id);
  renderNewComputers();
  loadProjects();
});
async function loadProjects() {
  const comp = newOn;
  state.projects = null;
  renderProjects();
  try {
    const list = await api("/api/projects", {}, comp);
    if (comp === newOn) { state.projects = list; renderProjects(); }
  } catch (e) { toast(e.message); }
}

function renderProjects() {
  const box = $("#project-list");
  if (!state.projects) return (box.innerHTML = `<div class="cell muted">Loading…</div>`);
  const q = $("#new-search").value.trim().toLowerCase();
  const list = state.projects.filter((p) => p.name.toLowerCase().includes(q));
  box.innerHTML = list.length ? list.map(projectRow).join("") : `<div class="cell muted">No projects match</div>`;
}
function projectRow(p) {
  const open = [...state.chats.values()].filter((c) => c.comp === newOn.id && c.project === p.name && c.status !== "ended").length;
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
    const c = tag(newOn, await api("/api/chats", { body: { project: pick.dataset.project || undefined } }, newOn));
    state.chats.set(c.key, c);
    location.hash = `chat/${c.key}`;
  } catch (err) {
    toast(err.message);
  } finally {
    starting = false;
    pick.classList.remove("busy");
  }
});

$("#list-more").onclick = () => openSheet("#list-menu");
$("#computers-btn").onclick = () => { openSheet("#computers"); $("#add-box").hidden = true; renderComputers(); findComputers(); };
// Add a computer: the lines to paste on it, and a one-time pairing code it asks for (it will
// receive your Claude setup, keys included, so it has to be you at that computer).
$("#add-computer").onclick = async () => {
  try {
    const r = await api("/api/sync/code", { body: {} });
    $("#add-mac").textContent = r.mac;
    $("#add-windows").textContent = r.windows;
    $("#add-code").textContent = r.code.replace(/(\d{3})(\d{3})/, "$1 $2");
    $("#add-box").hidden = false;
  } catch (e) { toast(e.message); }
};
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
  $("#info-computer").textContent = compOf(c).name || "This computer";
  $("#open-mac-label").textContent = compOf(c).os === "windows" ? "Open on PC" : "Open on Mac";
  $("#info-started").textContent = new Date(c.createdAt).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  $("#info-count").textContent = c.count;
  $("#open-mac").disabled = c.status === "ended";
  $("#pin-label").textContent = isPinned(c) ? "Unpin chat" : "Pin chat";
}
$("#info-screen").onclick = () => { openSheet("#screen"); pollScreen(); };
$("#open-mac").onclick = async () => {
  closeSheets();
  try { await chatApi(cur(), "/terminal", { body: {} }); toast(`Opened in a Terminal window on ${compOf(cur()).name || "the computer"}.`); }
  catch (e) { toast(e.message); }
};
$("#rename").onclick = async () => {
  closeSheets();
  const c = state.chats.get(state.current);
  const name = prompt("Chat name", c?.name || "");
  if (name?.trim()) await chatApi(c, "", { method: "PATCH", body: { name } }).catch((e) => toast(e.message));
};
$("#end-chat").onclick = async () => {
  closeSheets();
  if (!confirm("End this chat?\n\nClaude stops and the chat leaves this list. Anything it made stays in your project folder.")) return;
  try { await chatApi(cur(), "", { method: "DELETE" }); location.hash = ""; }
  catch (e) { toast(e.message); }
};

// The Mac screen: exactly what the Terminal shows, for menus the chat view can't show.
let screenTimer;
$("#screen-btn").onclick = () => { openSheet("#screen"); pollScreen(); };
async function pollScreen() {
  clearTimeout(screenTimer);
  if ($("#screen").hidden || !state.current) return;
  try {
    const { text } = await chatApi(cur(), "/screen");
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

// ── sending, quick replies and the reply sound ─────────────────────────────

function sendMessage(text, key = state.current) {
  const c = state.chats.get(key);
  if (!c) return Promise.reject(new Error("That chat isn't available right now."));
  // While Claude is asking you a question, whatever you type or say is your answer to it.
  if (c.pending?.questions && key === state.current) {
    const { text: words, kind } = splitVoice(text);
    return reply(kind ? `${words} (said out loud, so a word may be misheard)` : words);
  }
  // A swipe-to-reply goes in front, quoting the message you're answering, so Claude knows which one.
  const quoting = key === state.current ? replyTo : null;
  const full = quoting ? `Replying to ${quoting.who === "claude" ? "your" : "my"} message: "${quoting.text}"\n\n${text}` : text;
  return chatApi(c, "/send", { body: { text: full } }).then((r) => { if (quoting && replyTo === quoting) setReply(null); return r; });
}

// One-tap replies, shown while Claude is waiting for you and the typing box is empty.
function updateQuick() {
  const c = state.chats.get(state.current);
  $("#quick").hidden = !c || c.status !== "idle" || !c.count || !!input.value.trim() || !!recording;
}
$("#quick").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  $("#quick").hidden = true;
  try { await sendMessage(b.dataset.say); } catch (err) { toast(err.message); updateQuick(); }
});

// A soft WhatsApp-style pop when Claude answers (a lower one when it needs your OK), made on the
// spot with the Web Audio API — no sound file. iPhones only allow sound once you've touched the
// page, and keep it quiet when the phone is on silent.
let audio;
function unlockAudio() {
  try { audio ||= new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch {}
}
addEventListener("pointerdown", unlockAudio);
function pop(kind = "reply") {
  if (!state.sound || !audio || document.visibilityState !== "visible") return;
  const t = audio.currentTime, osc = audio.createOscillator(), gain = audio.createGain();
  const [from, to] = kind === "alert" ? [660, 440] : [880, 1320];
  osc.type = "sine";
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(to, t + 0.09);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.25, t + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + 0.22);
}
function renderSound() { $("#sound-state").textContent = state.sound ? "On" : "Off"; }
$("#sound-toggle").onclick = () => { state.sound = !state.sound; write("sound", state.sound); renderSound(); unlockAudio(); pop(); };
renderSound();

// ── speech: the iPhone's own recognition and voice, the same as Sky ────────

const speechApi = () => window.SpeechRecognition || window.webkitSpeechRecognition;

// Listen until told to stop; `onWords` gets everything heard so far. iPhones end a listen at
// every pause, so while it's still wanted it quietly starts again and keeps what it already had.
function listen(onWords, onBlocked) {
  const rec = new (speechApi())();
  rec.lang = "en-US";
  rec.interimResults = true;
  rec.continuous = true;
  let kept = "", heard = "", wanted = true, finish, startedAt = 0, quickEnds = 0;
  const done = new Promise((resolve) => (finish = resolve));
  const all = () => `${kept} ${heard}`.replace(/\s+/g, " ").trim();
  const start = () => { startedAt = Date.now(); rec.start(); };
  rec.onresult = (e) => { quickEnds = 0; heard = [...e.results].map((r) => r[0].transcript).join(" "); onWords?.(all()); };
  rec.onerror = (e) => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { wanted = false; onBlocked?.(); } };
  rec.onend = () => {
    kept = all();
    heard = "";
    // Ending straight after starting, five times running, means listening isn't working (another app
    // has the microphone, say). Give up then, instead of starting it again forever.
    quickEnds = Date.now() - startedAt < 1000 ? quickEnds + 1 : 0;
    if (wanted && quickEnds < 5) { try { start(); return; } catch {} }
    wanted = false;
    finish(kept);
  };
  try { start(); } catch { wanted = false; finish(""); }
  const end = (how) => {
    wanted = false;
    try { rec[how](); } catch { finish(all()); }
    setTimeout(() => finish(all()), 2500); // in case the iPhone never says it has stopped
    return done;
  };
  // `done` gives the words once listening has ended, whether it was told to or stopped by itself.
  return { stop: () => end("stop"), abort: () => end("abort"), done };
}

function micBlocked() {
  if (recording) endRecording(false, true);
  endCall();
  toast("The microphone is blocked. Allow it in Settings → Apps → Safari → Microphone, then try again.");
}

let voice = null; // the nicest English voice on the phone (the same pick as Sky)
function pickVoice() {
  const vs = window.speechSynthesis?.getVoices() || [];
  voice = vs.find((v) => /en-GB|en-AU/.test(v.lang) && /Siri|Samantha|Daniel|Google/i.test(v.name)) || vs.find((v) => v.lang.startsWith("en")) || null;
}
window.speechSynthesis?.addEventListener?.("voiceschanged", pickVoice);
pickVoice();

// ── voice notes: hold the mic, talk, let go to send; slide left to cancel ──

let recording = null;
const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const mic = $("#mic");
mic.addEventListener("contextmenu", (e) => e.preventDefault());
mic.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (recording) return;
  if (!speechApi()) return toast("Voice needs Safari on your iPhone.");
  try { mic.setPointerCapture(e.pointerId); } catch {}
  unlockAudio();
  recording = { x: e.clientX, started: Date.now() };
  recording.listener = listen((words) => recording && showPreview(words), micBlocked);
  recording.timer = setInterval(() => ($("#rec-time").textContent = mmss(Date.now() - recording.started)), 250);
  $("#rec-time").textContent = "0:00";
  $("#composer").classList.add("recording");
  $("#rec-bar").hidden = false;
  showPreview("");
  updateQuick();
});
mic.addEventListener("pointermove", (e) => {
  if (!recording) return;
  const slid = recording.x - e.clientX;
  $("#composer").classList.toggle("cancelling", slid > 50);
  if (slid > 110) endRecording(false);
});
mic.addEventListener("pointerup", () => recording && endRecording(true));
mic.addEventListener("pointercancel", () => recording && endRecording(false));

function showPreview(words) {
  const p = $("#rec-preview");
  p.hidden = false;
  p.textContent = words || "Listening…";
  if (nearBottom()) scrollDown();
}

async function endRecording(sendIt, quiet = false) {
  const r = recording;
  recording = null;
  clearInterval(r.timer);
  $("#composer").classList.remove("recording", "cancelling");
  $("#rec-bar").hidden = true;
  const words = await (sendIt ? r.listener.stop() : r.listener.abort());
  $("#rec-preview").hidden = true;
  updateQuick();
  if (quiet) return;
  if (!sendIt) return toast("Voice note cancelled");
  if (!words) return toast(Date.now() - r.started < 700 ? "Hold the mic while you talk, then let go to send." : "I didn't catch any words. Try again.");
  try { await sendMessage(words + VOICE_NOTE); }
  catch (e) { toast(e.message); input.value = words; grow(); } // keep your words, so nothing is lost
}

// ── voice call: you talk, Claude answers out loud, then it listens again ────

const call = { on: false, spoken: new Set(), queue: [] };
function setCallMode(mode, text) { $("#call").dataset.mode = mode; $("#call-state").textContent = text; }

$("#call-btn").onclick = startCall;
$("#info-call").onclick = () => { closeSheets(); startCall(); };

async function startCall() {
  const c = state.chats.get(state.current);
  if (!c) return;
  if (!speechApi() || !window.speechSynthesis) return toast("Voice calls need Safari on your iPhone.");
  if (c.status === "ended") return toast("Claude has stopped in this chat. Tap Resume first.");
  Object.assign(call, { on: true, chatId: c.key, since: Date.now(), muted: false, speaking: false, awaiting: false, queue: [], spoken: new Set(), listener: null, current: null, micFails: 0 });
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance("")); // iPhones only allow speech that starts from a tap
  unlockAudio();
  $("#call-avatar").innerHTML = avatar(c, "big");
  $("#call-name").textContent = c.name;
  $("#call-heard").textContent = "";
  $("#call-said").textContent = "";
  $("#call-time").textContent = "00:00";
  $("#call-mute").classList.remove("on");
  $("#call").hidden = false;
  call.clock = setInterval(() => {
    const s = Math.floor((Date.now() - call.since) / 1000);
    $("#call-time").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }, 1000);
  try { call.wake = await navigator.wakeLock?.request("screen"); } catch {} // keep the screen on during the call
  callChatChanged(null, c);
  say(isWorking(c) ? "Claude is still working. I'll tell you what it says." : "Hi, I'm listening.");
}

// Whenever the chat changes: Claude started or finished working, needs your OK, or stopped.
function callChatChanged(old, c) {
  if (!call.on || c.key !== call.chatId) return;
  if (isWorking(c) || c.pending) { call.awaiting = false; clearTimeout(call.waitTimer); }
  $("#call-approval").hidden = !c.pending || !!c.pending.questions;
  if (c.pending && !old?.pending) c.pending.questions ? sayQuestion(c) : say(`Claude needs your OK to use ${c.pending.tool}. Tap Approve or Deny.`);
  if (c.status === "ended" && old && old.status !== "ended") say("Claude has stopped in this chat.");
  if (isWorking(c) && !call.speaking) $("#call-said").textContent = c.note || state.lastStep || "";
  nextTurn();
}

// Your turn to talk — unless Claude is busy, talking, waiting for your OK, or you're muted.
function nextTurn() {
  if (!call.on || call.speaking || call.listener) return;
  const c = state.chats.get(call.chatId);
  if (!c || c.status === "ended") return setCallMode("idle", "Claude has stopped");
  if (c.pending && !c.pending.questions) return setCallMode("idle", "Waiting for your OK"); // a question is answered by talking
  if (call.awaiting || isWorking(c)) return setCallMode("working", "Claude is working…");
  if (call.muted) return setCallMode("idle", "You're muted. Tap Mute to talk.");
  setCallMode("listening", "Listening…");
  $("#call-heard").textContent = "";
  const l = (call.listener = listen((words) => {
    call.micFails = 0;
    $("#call-heard").textContent = words;
    clearTimeout(call.quiet);
    call.quiet = setTimeout(finishTurn, 1600); // a short pause means you've finished talking
  }, micBlocked));
  // Listening stopped by itself — not because you paused or Claude spoke. The screen used to stay on
  // "Listening…" with the microphone off. Send what it heard, or try again; after three tries, say so.
  l.done.then((words) => {
    if (call.listener !== l || !call.on) return;
    call.listener = null;
    clearTimeout(call.quiet);
    if (words) { call.awaiting = true; return sendTurn(words); }
    if ((call.micFails = (call.micFails || 0) + 1) < 3) return setTimeout(nextTurn, 1000);
    call.muted = true;
    $("#call-mute").classList.add("on");
    setCallMode("idle", "The microphone stopped. Tap Mute to try again.");
  });
}

// On a call, Claude's question is read out with its choices; the answer you say goes back as
// your answer to it (sendMessage → reply).
function sayQuestion(c) {
  const q = c.pending.questions[ask?.i || 0], labels = q.options.map((o) => o.label);
  const choices = labels.length > 1 ? ` ${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}?` : "";
  say(`${ask?.i ? "Next" : "Claude asks"}: ${q.question}${choices}${q.multiSelect ? " You can say more than one." : ""}`);
}

async function finishTurn() {
  const l = call.listener;
  if (!l || !call.on) return;
  call.listener = null;
  call.awaiting = true; // don't start listening again until this has gone to Claude
  sendTurn(await l.stop());
}

async function sendTurn(words) {
  if (!call.on) return;
  if (!words) { call.awaiting = false; return nextTurn(); }
  $("#call-heard").textContent = words;
  clearTimeout(call.waitTimer);
  call.waitTimer = setTimeout(() => { call.awaiting = false; nextTurn(); }, 20000);
  setCallMode("working", "Sending…");
  try { await sendMessage(words + VOICE_CALL, call.chatId); nextTurn(); }
  catch (e) { call.awaiting = false; say(`Sorry, that didn't reach Claude. ${e.message}`); }
}

// Read Claude's words out once each. Markdown and code don't read well aloud, so they're tidied.
function sayOnce(text) {
  const key = text.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 200);
  if (!key || call.spoken.has(key)) return;
  call.spoken.add(key);
  say(speakable(text));
}
const speakable = (s) => splitVoice(s).text
  .replace(/```[\s\S]*?```/g, " There's some code in the chat. ")
  .replace(/`([^`]*)`/g, "$1").replace(/\*\*|__/g, "").replace(/^#+\s*/gm, "")
  .replace(/https?:\/\/\S+/g, "a link").replace(/^\s*([-*•]|\d+\.)\s+/gm, "").replace(/\|/g, " ")
  .replace(/\s+/g, " ").trim();

function say(text) {
  if (!call.on || !text) return;
  $("#call-said").textContent = text;
  // Long replies go in pieces of a few sentences, which the iPhone voice handles more reliably.
  let piece = "";
  for (const sentence of text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text]) {
    if (piece && (piece + sentence).length > 240) { call.queue.push(piece.trim()); piece = ""; }
    piece += sentence;
  }
  if (piece.trim()) call.queue.push(piece.trim());
  if (!call.speaking) speakNext();
}

function speakNext() {
  if (!call.on) return;
  const text = call.queue.shift();
  if (text === undefined) { call.speaking = false; call.current = null; return nextTurn(); }
  call.speaking = true;
  if (call.listener) { call.listener.abort(); call.listener = null; clearTimeout(call.quiet); } // never listen to itself
  setCallMode("speaking", "Claude is talking…");
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 1.03;
  u.onend = u.onerror = () => { if (call.current === u) setTimeout(speakNext, 120); };
  call.current = u;
  speechSynthesis.speak(u);
}

function endCall() {
  if (!call.on) return;
  call.on = false;
  call.listener?.abort();
  call.listener = null;
  call.queue = [];
  call.current = null;
  clearTimeout(call.quiet);
  clearTimeout(call.waitTimer);
  clearInterval(call.clock);
  speechSynthesis.cancel();
  try { call.wake?.release(); } catch {}
  call.wake = null;
  $("#call").hidden = true;
}
// The screen locked or you switched apps: the iPhone stops listening, so start again on return.
function pauseCall() {
  if (!call.on || !call.listener) return;
  call.listener.abort();
  call.listener = null;
  clearTimeout(call.quiet);
}
async function resumeCall() {
  if (!call.on) return;
  try { call.wake = await navigator.wakeLock?.request("screen"); } catch {}
  nextTurn();
}

$("#call-end").onclick = endCall;
$("#call-mute").onclick = () => {
  call.muted = !call.muted;
  call.micFails = 0;
  $("#call-mute").classList.toggle("on", call.muted);
  if (call.muted) pauseCall();
  nextTurn();
};
$("#call-skip").onclick = () => { // stop Claude talking and go straight to your turn
  call.queue = [];
  call.current = null;
  speechSynthesis.cancel();
  call.speaking = false;
  nextTurn();
};
$("#call-approve").onclick = () => answer("allow");
$("#call-deny").onclick = () => answer("deny");

// ── swipe, like WhatsApp: a chat to pin it, a message to reply to it ────────

// Swipe a row or a bubble to the right and it follows your finger a little way; let go past the mark
// and it does its job. Up-and-down still scrolls (the styles give these touch-action: pan-y).
let swipedAt = 0; // the browser ends a swipe with a tap; a tap straight after one is ignored
function swipeable(box, selector, onSwipe) {
  let s = null;
  box.addEventListener("pointerdown", (e) => {
    const el = e.target.closest(selector);
    s = el && e.button <= 0 ? { el, x: e.clientX, y: e.clientY, dx: 0, on: false } : null;
  });
  box.addEventListener("pointermove", (e) => {
    if (!s) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    if (!s.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return void (s = null); // that's a scroll
      if (dx < 12) return;
      s.on = true;
      s.el.classList.add("swiping");
      try { box.setPointerCapture(e.pointerId); } catch {}
    }
    s.dx = Math.max(0, Math.min(dx, 90));
    s.el.style.transform = `translateX(${s.dx}px)`;
    s.el.classList.toggle("swipe-ready", s.dx > 60);
  });
  const end = () => {
    const done = s;
    s = null;
    if (!done?.on) return;
    swipedAt = Date.now();
    done.el.style.transition = "transform .2s";
    done.el.style.transform = "";
    done.el.classList.remove("swiping", "swipe-ready");
    setTimeout(() => (done.el.style.transition = ""), 220);
    if (done.dx > 60) onSwipe(done.el);
  };
  box.addEventListener("pointerup", end);
  box.addEventListener("pointercancel", end);
}

// Swipe one of the messages to reply to it. It's quoted above the typing box and goes in front of what
// you send next, so Claude knows which message you mean.
let replyTo = null; // { who: "claude" | "you", text }
function setReply(r) {
  replyTo = r;
  $("#reply-bar").hidden = !r;
  if (!r) return;
  $("#reply-who").textContent = r.who === "claude" ? "Claude" : "You";
  $("#reply-text").textContent = r.text;
  input.focus();
}
$("#reply-cancel").onclick = () => setReply(null);
swipeable($("#messages"), ".bubble.in:not(.tools), .bubble.out", (b) => b.dataset.quote && setReply({ who: b.dataset.who, text: b.dataset.quote }));

// Pinned chats stay at the top of the list. Swipe a chat to the right to pin or unpin it, or use Chat
// info. The pins are kept on this phone.
const isPinned = (c) => state.pinned.includes(c.key);
function togglePin(key) {
  const on = !state.pinned.includes(key);
  state.pinned = on ? [key, ...state.pinned] : state.pinned.filter((k) => k !== key);
  write("pinned", state.pinned);
  renderList();
  if (cur()) fillInfo(cur());
  toast(on ? "Pinned to the top" : "Unpinned");
}
swipeable($("#chat-list"), ".row", (row) => togglePin(row.dataset.id));
$("#pin-chat").onclick = () => state.current && togglePin(state.current);

// ── search inside a chat (Chat info → Search) ──────────────────────────────
// Every match in the chat is marked. It starts at the newest; the arrows step through the rest.

const finder = { hits: [], i: -1 };
const canMark = !!(window.CSS?.highlights && window.Highlight); // marks words in place (Safari 17.2+)
function openFind() {
  $("#find").hidden = false;
  $("#find-input").value = "";
  $("#find-count").textContent = "";
  $("#find-input").focus();
}
function closeFind() {
  $("#find").hidden = true;
  clearFind();
}
function clearFind() {
  if (canMark) { CSS.highlights.delete("find"); CSS.highlights.delete("find-now"); }
  for (const b of document.querySelectorAll(".hit, .hit-now")) b.classList.remove("hit", "hit-now");
  finder.hits = [];
  finder.i = -1;
}
const bubbleOf = (range) => range.startContainer.parentElement?.closest(".bubble");
function runFind() {
  clearFind();
  const q = $("#find-input").value.trim().toLowerCase();
  if (!q) return void ($("#find-count").textContent = "");
  const walk = document.createTreeWalker($("#messages"), NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest(".stamp, .day, .tools-sum") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n; (n = walk.nextNode());) {
    const t = n.data.toLowerCase();
    for (let at = t.indexOf(q); at >= 0; at = t.indexOf(q, at + q.length)) {
      const r = new Range();
      r.setStart(n, at);
      r.setEnd(n, at + q.length);
      finder.hits.push(r);
    }
  }
  if (canMark) CSS.highlights.set("find", new Highlight(...finder.hits));
  else for (const r of finder.hits) bubbleOf(r)?.classList.add("hit");
  finder.i = finder.hits.length - 1; // the newest first, like WhatsApp
  showHit();
}
function showHit() {
  const n = finder.hits.length;
  $("#find-count").textContent = n ? `${finder.i + 1} of ${n}` : "No results";
  $("#find-up").disabled = finder.i <= 0;
  $("#find-down").disabled = finder.i >= n - 1;
  if (!n) return;
  const r = finder.hits[finder.i], b = bubbleOf(r);
  b?.closest(".tools")?.classList.add("open"); // a match among Claude's folded steps: unfold them
  if (canMark) CSS.highlights.set("find-now", new Highlight(r));
  else { for (const x of document.querySelectorAll(".hit-now")) x.classList.remove("hit-now"); b?.classList.add("hit-now"); }
  (b || r.startContainer.parentElement).scrollIntoView({ block: "center", behavior: "smooth" });
}
function stepFind(by) {
  if (!finder.hits.length) return;
  finder.i = Math.max(0, Math.min(finder.hits.length - 1, finder.i + by));
  showHit();
}
let findTimer;
$("#find-input").addEventListener("input", () => { clearTimeout(findTimer); findTimer = setTimeout(runFind, 150); });
$("#find-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); stepFind(-1); } });
$("#find-up").onclick = () => stepFind(-1);
$("#find-down").onclick = () => stepFind(1);
$("#find-done").onclick = closeFind;
$("#info-search").onclick = () => { closeSheets(); openFind(); };

// ── photos ─────────────────────────────────────────────────────────────────
// + in the typing bar picks a photo, or takes one. It's shrunk here to at most 1600 pixels across —
// plenty for Claude, and quick to send — then saved on the computer, and Claude is told where it is.

let photo = null; // { url, data } of the photo waiting to be sent
const photoUrl = (name) => { const c = cur(); return c ? `${compOf(c).base}/api/chats/${c.id}/photos/${name}` : ""; };
$("#attach").onclick = () => $("#photo-input").click();
$("#photo-input").onchange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // so picking the same photo again still counts
  if (!file) return;
  try { photo = await shrink(file); } catch { return toast("That photo couldn't be opened."); }
  $("#photo-preview").src = photo.url;
  $("#photo-caption").value = input.value.trim(); // anything you'd typed becomes the caption
  openSheet("#photo-sheet");
};
async function shrink(file, max = 1600) {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = reject; i.src = src; });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(img.naturalWidth * scale), height: Math.round(img.naturalHeight * scale) });
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL("image/jpeg", 0.85);
    return { url, data: url.slice(url.indexOf(",") + 1) };
  } finally { URL.revokeObjectURL(src); }
}
async function sendPhoto() {
  const c = cur(), b = $("#photo-send");
  if (!c || !photo || b.disabled) return;
  const caption = $("#photo-caption").value.trim();
  b.disabled = true;
  b.classList.add("busy");
  try {
    await chatApi(c, "/photo", { body: { data: photo.data, caption }, timeout: 60000 });
    if (caption && caption === input.value.trim()) { input.value = ""; grow(); saveDraft(); } // it went as the caption
    photo = null;
    closeSheets();
  } catch (err) { toast(err.message); }
  finally { b.disabled = false; b.classList.remove("busy"); }
}
$("#photo-send").onclick = sendPhoto;
$("#photo-caption").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendPhoto(); } });
$("#viewer").onclick = () => ($("#viewer").hidden = true);

// ── notifications ──────────────────────────────────────────────────────────
// ⋯ → Notifications. The iPhone allows them only in the Home Screen app. Every computer is given this
// phone's push address, and sends one when Claude finishes or needs you — but not while you're looking
// at the app (it tells them so every 20 seconds, and when you leave).

const canPush = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const onHomeScreen = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (ch) => ch.charCodeAt(0));
const toB64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  // Tapping a notification while the app is open: go to that chat.
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.open) location.hash = `chat/${e.data.open}`; });
}
function renderNotify() { $("#notify-state").textContent = read("push", false) ? "On" : "Off"; }
async function mySubscription() {
  if (!canPush()) return null;
  return (await navigator.serviceWorker.ready).pushManager.getSubscription();
}
async function shareSubscription(comp, sub) {
  try {
    sub ||= await mySubscription();
    if (sub) await api("/api/push/subscribe", { body: sub.toJSON(), timeout: 8000 }, comp);
  } catch {}
}
$("#notify-toggle").onclick = async () => {
  if (read("push", false)) return turnOffNotifications();
  if (!canPush()) {
    return toast(/iPhone|iPad/.test(navigator.userAgent) && !onHomeScreen()
      ? "Add this app to your Home Screen first (Share → Add to Home Screen), then turn notifications on in there."
      : "Notifications don't work in this browser.");
  }
  // Asked straight away, while it still counts as your tap — iPhones insist on that.
  if ((await Notification.requestPermission()) !== "granted") return toast("Notifications are off for this app. Turn them on in Settings → Notifications → Claude Chats.");
  try {
    const { key } = await api("/api/push/key");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub?.options?.applicationServerKey && toB64u(sub.options.applicationServerKey) !== key) { await sub.unsubscribe(); sub = null; }
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(key) });
    await Promise.all(state.computers.filter((c) => c.online).map((c) => shareSubscription(c, sub)));
    write("push", true);
    renderNotify();
    const test = await api("/api/push/test", { body: {} });
    toast(test.sent ? "Notifications are on. A test one is on its way." : `Notifications are on, but the test didn't send: ${test.failed[0] || "no answer"}`);
  } catch (e) { toast(`Couldn't turn notifications on: ${e.message}`); }
};
async function turnOffNotifications() {
  try {
    const sub = await mySubscription();
    if (sub) {
      await Promise.all(state.computers.filter((c) => c.online).map((c) => api("/api/push/unsubscribe", { body: { endpoint: sub.endpoint } }, c).catch(() => {})));
      await sub.unsubscribe();
    }
  } catch {}
  write("push", false);
  renderNotify();
  toast("Notifications are off.");
}
renderNotify();

// While you're looking at the app, the computers hold their notifications back.
function tellLooking(looking, comps = state.computers.filter((c) => c.online)) {
  const body = JSON.stringify({ looking });
  for (const comp of comps) {
    const url = `${comp.base}/api/presence`;
    // Leaving the app: sendBeacon still gets out while the iPhone is pausing the page.
    if (!looking && navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain" }))) continue;
    fetch(url, { method: "POST", body, headers: { "content-type": "text/plain" }, keepalive: true }).catch(() => {});
  }
}
setInterval(() => { if (document.visibilityState === "visible") tellLooking(true); }, 20000);

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
startComputers();

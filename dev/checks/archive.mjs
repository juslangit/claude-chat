// End-to-end checks for archive and delete, against a test copy on :4479 (own data folder, own tmux
// server, own .env). A fake Apple push service on :4481 proves an archived chat really does stay quiet.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";

import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the app being checked lives, and a scratch folder for its data, profiles and screenshots.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.CLAUDE_CHAT_APP || path.resolve(HERE, "../..");
const WORK = process.env.CLAUDE_CHAT_WORK || path.join(HERE, ".work");
fs.mkdirSync(WORK, { recursive: true });

const W = APP;
const D = `${WORK}/t-archive`;
const SHOTS = `${WORK}/shots-archive`;
const PORT = 4479, RECV = 4481, CDP = 9339;
const TMUX = "/opt/homebrew/bin/tmux";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`); };
fs.mkdirSync(D, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

let server;
function startServer() {
  const out = fs.openSync(`${D}/server.log`, "a");
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: W, stdio: ["ignore", out, out],
    env: { ...process.env, CLAUDE_CHAT_COMPUTER: "Test (4479)", CLAUDE_CHAT_DATA: D, CLAUDE_CHAT_SOCKET: "claude-chat-arch",
      PORT: String(PORT), ANTHROPIC_MODEL: "claude-haiku-4-5", CLAUDE_CHAT_ENV_FILE: `${D}/env` },
  });
}
function req(method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method,
      headers: { ...(data && { "content-type": "application/json", "content-length": Buffer.byteLength(data) }), ...headers } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => { let j; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", reject);
    r.setTimeout(120000, () => r.destroy(new Error("timeout")));
    if (data) r.write(data);
    r.end();
  });
}
const waitUp = async () => { for (let i = 0; i < 80; i++) { try { await req("GET", "/api/whoami"); return true; } catch {} await sleep(250); } return false; };

// a fake phone and a fake Apple, so "archived means no notification" can be proved
const phone = crypto.createECDH("prime256v1");
const phonePub = phone.generateKeys();
const auth = crypto.randomBytes(16);
const b64u = (b) => Buffer.from(b).toString("base64url");
function decrypt(body) {
  const salt = body.subarray(0, 16), idlen = body[20], from = body.subarray(21, 21 + idlen), sealed = body.subarray(21 + idlen);
  const hk = (s, ikm, info, n) => Buffer.from(crypto.hkdfSync("sha256", ikm, s, info, n));
  const ikm = hk(auth, phone.computeSecret(from), Buffer.concat([Buffer.from("WebPush: info\0"), phonePub, from]), 32);
  const d = crypto.createDecipheriv("aes-128-gcm", hk(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16), hk(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12));
  d.setAuthTag(sealed.subarray(-16));
  const pt = Buffer.concat([d.update(sealed.subarray(0, -16)), d.final()]);
  let i = pt.length - 1;
  while (pt[i] === 0) i--;
  return JSON.parse(pt.subarray(0, i).toString());
}
const pushes = [];
const apple = http.createServer((q, s) => {
  const chunks = [];
  q.on("data", (c) => chunks.push(c));
  q.on("end", () => { try { pushes.push(decrypt(Buffer.concat(chunks))); } catch {} s.writeHead(201); s.end(); });
}).listen(RECV, "127.0.0.1");
const waitPush = async (n, ms) => { const end = Date.now() + ms; while (Date.now() < end && pushes.length < n) await sleep(200); return pushes.length >= n; };

let chrome, A, B, C, E;
try {
  startServer();
  check("server starts", await waitUp());
  await req("GET", "/api/push/key");
  await req("POST", "/api/push/subscribe", { body: { endpoint: `http://127.0.0.1:${RECV}/phone`, keys: { p256dh: b64u(phonePub), auth: b64u(auth) } } });
  await req("POST", "/api/presence", { body: { looking: false } });

  A = (await req("POST", "/api/chats", { body: { name: "keeper", terminal: false } })).json;
  B = (await req("POST", "/api/chats", { body: { name: "old one", terminal: false } })).json;
  const list = async () => (await req("GET", "/api/chats")).json || [];
  const one = async (id) => (await list()).find((c) => c.id === id);
  const waitFor = async (id, want, ms) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = (await one(id))?.status; if (want(s)) return s; await sleep(400); } return s; };
  check("both chats reach online", (await waitFor(A.id, (s) => s === "idle", 60000)) === "idle" && (await waitFor(B.id, (s) => s === "idle", 60000)) === "idle");

  // ── archiving ──
  const archived = (await req("PATCH", `/api/chats/${A.id}`, { body: { archived: true } })).json;
  check("a chat can be archived", archived?.archived === true);
  check("…and it says so in the list", (await one(A.id))?.archived === true);
  check("…while the other one isn't", (await one(B.id))?.archived === false);

  const secret = fs.readFileSync(`${D}/secret`, "utf8").trim();
  const ask = async (id) => {
    const hook = req("POST", "/hook", { headers: { "x-secret": secret }, body: { chatId: id, event: { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo hi" } } } });
    await sleep(1200);
    const reqId = (await one(id))?.pending?.reqId;
    await req("POST", `/api/chats/${id}/approve`, { body: { decision: "deny", reqId } });
    await hook;
  };
  const before = pushes.length;
  await ask(A.id);
  await sleep(2500);
  check("an archived chat sends no notification", pushes.length === before, `${pushes.length - before} arrived`);

  await req("PATCH", `/api/chats/${A.id}`, { body: { archived: false } });
  check("unarchiving puts it back", (await one(A.id))?.archived === false);
  await ask(A.id);
  check("…and it notifies again", await waitPush(before + 1, 6000) && /echo hi/.test(pushes[before]?.body || ""), pushes[before]?.body);

  const renamed = (await req("PATCH", `/api/chats/${A.id}`, { body: { name: "keeper renamed" } })).json;
  check("renaming still works and doesn't archive anything", renamed?.name === "keeper renamed" && renamed.archived === false);

  // ── deleting the stopped ones ──
  execFileSync(TMUX, ["-L", "claude-chat-arch", "kill-session", "-t", B.tmux]);
  check("the second chat shows as stopped", (await waitFor(B.id, (s) => s === "ended", 15000)) === "ended");
  const swept = (await req("DELETE", "/api/chats/stopped")).json;
  check("delete stopped removes exactly the stopped one", swept?.deleted === 1, JSON.stringify(swept));
  const after = await list();
  check("…and leaves the running chat alone", after.length === 1 && after[0].id === A.id, after.map((c) => c.name).join(", "));
  B = null;

  // ── the phone ──
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORK}/.chrome-e2e4-${Date.now()}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  let ver;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(250); ver = await fetch(`http://127.0.0.1:${CDP}/json/version`).then((r) => r.json()).catch(() => null); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let seq = 0;
  const waiting = new Map(), errors = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); return m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Page.enable");
  await S("Runtime.enable");
  await S("Emulation.setDeviceMetricsOverride", { width: 402, height: 874, deviceScaleFactor: 2, mobile: true });
  const js = async (expression) => {
    const r = await S("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name) => { await sleep(350); const { data } = await S("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, "base64")); };
  const until = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr).catch(() => false)) return true; await sleep(300); } return false; };
  // A finger on a chat in the list, as pointer events. Holding one half a second opens its menu.
  const rowOf = (id) => `#chat-list .row[data-id="home/${id}"]`;
  const rowSel = rowOf(A.id);
  const menuOpen = `!document.querySelector("#row-menu").hidden`;
  const finger = (id, type, dx = 0) => js(`(() => {
    const el = document.querySelector(${JSON.stringify(rowOf(id))});
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, clientX: r.left + r.width / 2 + ${dx}, clientY: r.top + r.height / 2, pointerId: 11, pointerType: "touch", button: 0, isPrimary: true }));
    return true;
  })()`);
  // Lifting the finger: the phone then "taps" the chat and the dimmed background under it.
  const letGo = async (id = A.id) => { await finger(id, "pointerup"); await js(`document.querySelector(${JSON.stringify(rowOf(id))}).click(); document.querySelector("#row-menu").click(); true`); await sleep(500); };
  const hold = async (id = A.id) => { await finger(id, "pointerdown"); return until(menuOpen, 1500); };
  const menu = async (id, button) => { await hold(id); await letGo(id); await js(`document.querySelector("#${button}").click(); true`); };
  const tap = async (id) => { await js(`document.querySelector(${JSON.stringify(rowOf(id))}).click(); true`); await sleep(150); };
  const label = (id) => js(`document.querySelector("#${id}").textContent`);
  const title = () => label("nav-title");

  await S("Page.navigate", { url: `http://127.0.0.1:${PORT}/#chats` });
  check("phone page connects", await until("home.online === true", 10000));
  check("no Archived row while nothing is archived", await js(`document.querySelector("#archived-row").hidden`));

  await finger(A.id, "pointerdown");
  for (const dx of [-15, -30, -50, -70, -85]) await finger(A.id, "pointermove", dx);
  await finger(A.id, "pointerup", -85);
  await sleep(800);
  check("swiping a chat does nothing now — holding it is the way", await js(`!!document.querySelector('${rowSel}')`) && !(await js(menuOpen)) && (await one(A.id))?.archived === false);
  await menu(A.id, "row-archive");
  check("hold → Archive archives it", await until(`document.querySelectorAll("#chat-list .row").length === 0`, 6000));
  check("…and the note offers Undo", await until(`(() => { const b = document.querySelector("#toast:not([hidden]) .toast-action"); return b?.textContent === "Undo"; })()`, 3000));
  await shot("0b-undo");
  await js(`document.querySelector("#toast .toast-action").click(); true`);
  check("Undo brings it straight back, on the computer too", await until(`document.querySelectorAll("#chat-list .row").length === 1`, 6000) && (await one(A.id))?.archived === false);
  await menu(A.id, "row-archive"); // archived again, for the checks below
  await until(`document.querySelectorAll("#chat-list .row").length === 0`, 6000);
  check("…the Archived row appears with a count", await js(`(() => { const r = document.querySelector("#archived-row"); return !r.hidden && r.textContent.includes("Archived") && r.textContent.includes("1"); })()`));
  check("…and the computer knows, not just the phone", (await one(A.id))?.archived === true);
  await shot("1-list-archived");

  await js(`document.querySelector("#archived-row").click(); true`);
  check("the Archived row opens what's inside", await until(`document.querySelectorAll("#chat-list .row").length === 1 && document.querySelector("#nav-title").textContent === "Archived"`, 4000));
  await shot("2-archived-view");
  await hold(A.id);
  check("…where the menu offers Unarchive", (await label("row-archive-label")) === "Unarchive chat");
  await letGo(A.id);
  await js(`document.querySelector("#row-archive").click(); true`);
  check("hold → Unarchive puts it back", await until(`document.querySelectorAll("#chat-list .row").length === 0`, 6000) && (await one(A.id))?.archived === false);
  await js(`document.querySelector("#archived-row").click(); true`);
  check("back in the main list", await until(`document.querySelectorAll("#chat-list .row").length === 1 && document.querySelector("#nav-title").textContent === "Chats"`, 4000));

  // ── holding a chat: its menu, and no web-page sliding or zooming ──
  check("the chat list can't be dragged sideways", await js(`getComputedStyle(document.querySelector("#chat-list").closest(".page")).overflowX === "hidden"`));
  check("double-tap and pinch don't zoom", await js(`document.querySelector("meta[name=viewport]").content.includes("user-scalable=no") && getComputedStyle(document.querySelector("#chat-list")).touchAction === "manipulation"`));
  await finger(A.id, "pointerdown"); await sleep(200); await finger(A.id, "pointerup"); await sleep(600);
  check("a quick touch doesn't open the menu", !(await js(menuOpen)));
  check("holding a chat opens its menu", await hold());
  check("…with Pin, Archive and Delete for that chat", (await label("row-menu-name")) === "keeper renamed" && (await label("row-pin-label")) === "Pin chat" && (await label("row-archive-label")) === "Archive chat" && (await label("row-delete")) === "Delete chat");
  await letGo();
  check("…letting go keeps it open, without opening the chat", await js(`${menuOpen} && location.hash === "#chats"`), await js("location.hash"));
  await shot("0-hold-menu");
  await js(`document.querySelector("#row-pin").click(); true`);
  check("menu → Pin pins it", await until(`state.pinned.includes("home/${A.id}") && !!document.querySelector('${rowSel} .pin')`, 3000));
  await hold(); await letGo();
  check("…then the menu offers Unpin", (await label("row-pin-label")) === "Unpin chat");
  await js(`document.querySelector("#row-pin").click(); true`);
  check("menu → Unpin unpins it", await until(`!state.pinned.includes("home/${A.id}")`, 3000));
  await hold(); await letGo();
  await js(`document.querySelector("#row-archive").click(); true`);
  check("menu → Archive archives it on the computer", await until(`!document.querySelector('${rowSel}')`, 6000) && (await one(A.id))?.archived === true);
  await req("PATCH", `/api/chats/${A.id}`, { body: { archived: false } });
  check("(put back for the next checks)", await until(`!!document.querySelector('${rowSel}')`, 6000));

  await js(`window.prompt = () => "keeper held"; true`);
  await menu(A.id, "row-rename");
  check("hold → Rename renames it on the computer", await until(`document.querySelector('${rowSel} .name').textContent === "keeper held"`, 5000) && (await one(A.id))?.name === "keeper held");

  // ── selecting several chats ──
  C = (await req("POST", "/api/chats", { body: { name: "extra one", terminal: false } })).json;
  E = (await req("POST", "/api/chats", { body: { name: "extra two", terminal: false } })).json;
  check("(two more chats to select)", await until(`!!document.querySelector('${rowOf(C.id)}') && !!document.querySelector('${rowOf(E.id)}')`, 8000));
  await menu(A.id, "row-select");
  check("hold → Select chats starts selecting, with that chat ticked", (await title()) === "1 selected" && await js(`document.querySelector('${rowSel}').classList.contains("picked")`), await title());
  check("…Archive and Delete take the tab bar's place, Done takes the +", await js(`!document.querySelector("#pick-bar").hidden && document.querySelector("#tabs").hidden && !document.querySelector("#pick-done").hidden && document.querySelector("#new-chat").hidden`));
  await tap(C.id);
  check("tapping another chat ticks it instead of opening it", (await title()) === "2 selected" && await js(`location.hash === "#chats"`));
  await shot("6-selecting");
  await tap(C.id);
  check("…tapping it again unticks it", (await title()) === "1 selected");
  const pickAll = () => js(`document.querySelector("#pick-all").click(); true`);
  check("Select all shows while selecting", await js(`!document.querySelector("#pick-all").hidden`) && (await label("pick-all")) === "Select all");
  await pickAll();
  check("Select all ticks every chat showing, and becomes Deselect all", (await title()) === "3 selected" && (await label("pick-all")) === "Deselect all");
  await shot("7-select-all");
  // the widest the header gets: Deselect all, a two-digit count, and Done, all on one phone-wide line
  check("Deselect all, \"12 selected\" and Done fit side by side", await js(`(() => {
    const t = document.querySelector("#nav-title"), was = t.textContent; t.textContent = "12 selected";
    const a = document.querySelector("#pick-all").getBoundingClientRect(), m = t.getBoundingClientRect(), d = document.querySelector("#pick-done").getBoundingClientRect();
    t.textContent = was;
    return a.right <= m.left && m.right <= d.left && d.right <= innerWidth && Math.abs((m.left + m.right) / 2 - innerWidth / 2) < 6;
  })()`));
  await pickAll();
  check("Deselect all unticks them all, and Archive / Delete grey out", (await title()) === "Select chats" && await js(`document.querySelector("#pick-archive").disabled && document.querySelector("#pick-delete").disabled`));
  const search = (text) => js(`(() => { const s = document.querySelector("#search"); s.value = ${JSON.stringify(text)}; s.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await search("extra");
  await pickAll();
  check("with a search, Select all ticks only what the search shows", (await title()) === "2 selected" && await js(`!state.picking.has("home/${A.id}")`));
  await search("");
  await pickAll(); // everything showing isn't ticked yet (A isn't), so this ticks A as well…
  await pickAll(); // …and this unticks all three
  await tap(A.id);
  check("(back to just the first chat ticked)", (await title()) === "1 selected" && await js(`state.picking.has("home/${A.id}")`));
  await tap(C.id);
  await js(`document.querySelector("#pick-archive").click(); true`);
  check("Archive archives every ticked chat, and only those", await until(`!document.querySelector('${rowSel}') && !document.querySelector('${rowOf(C.id)}')`, 6000) && (await one(A.id))?.archived === true && (await one(C.id))?.archived === true && (await one(E.id))?.archived === false);
  check("…and selecting ends", await js(`document.querySelector("#pick-bar").hidden && !document.querySelector("#tabs").hidden && document.querySelector("#nav-title").textContent === "Chats"`));
  check("…the note offers Undo for both", await until(`(() => { const t = document.querySelector("#toast"); return !t.hidden && t.textContent.startsWith("Archived 2 chats") && !!t.querySelector(".toast-action"); })()`, 3000), await js(`document.querySelector("#toast").textContent`));
  await js(`document.querySelector("#toast .toast-action").click(); true`);
  check("Undo unarchives exactly those two", await until(`!!document.querySelector('${rowSel}') && !!document.querySelector('${rowOf(C.id)}')`, 6000) && (await one(A.id))?.archived === false && (await one(C.id))?.archived === false && (await one(E.id))?.archived === false);
  for (const x of [A, C]) await req("PATCH", `/api/chats/${x.id}`, { body: { archived: false } });
  await until(`!!document.querySelector('${rowSel}') && !!document.querySelector('${rowOf(C.id)}')`, 6000);
  await menu(C.id, "row-select");
  await tap(E.id);
  await js(`window.confirm = () => true; document.querySelector("#pick-delete").click(); true`);
  check("Delete deletes every ticked chat, and only those", await until(`!document.querySelector('${rowOf(C.id)}') && !document.querySelector('${rowOf(E.id)}')`, 6000) && !(await one(C.id)) && !(await one(E.id)) && !!(await one(A.id)));
  C = E = null;
  await menu(A.id, "row-select");
  await js(`document.querySelector("#pick-done").click(); true`);
  check("Done stops selecting without doing anything", await js(`document.querySelector("#pick-bar").hidden && document.querySelector("#nav-title").textContent === "Chats"`) && (await one(A.id))?.archived === false);

  await js(`go("chat/home/${A.id}"); true`);
  await sleep(800);
  await js(`document.querySelector("#chat-head").click(); true`);
  await sleep(400);
  check("Chat info offers Archive and Delete", await js(`document.querySelector("#archive-label").textContent === "Archive chat" && document.querySelector("#end-chat").textContent === "Delete chat"`));
  await shot("3-chat-info");
  await js(`document.querySelector("#archive-chat").click(); true`);
  check("Chat info → Archive archives it", await until(`state.chats.get("home/${A.id}")?.archived === true`, 6000));
  await js(`document.querySelector("#chat-head").click(); true`);
  await sleep(400);
  check("…and the row then says Unarchive", await js(`document.querySelector("#archive-label").textContent === "Unarchive chat"`));
  await js(`closeSheets(); go("home"); true`);
  await sleep(700);
  check("an archived chat stays out of Home", await js(`!document.querySelector("#activity").textContent.includes("keeper")`), await js(`document.querySelector("#activity").textContent.replace(/\\s+/g, " ").slice(0, 60)`));
  check("…and out of today's count", await js(`document.querySelector("#day-card").textContent.includes("Nothing running")`));
  await shot("4-home");
  await js(`go("settings"); true`);
  await sleep(600);
  check("Settings has the clear-out, greyed out with nothing stopped", await js(`(() => { const b = document.querySelector("#delete-stopped"); return b.textContent.includes("Delete stopped chats") && b.disabled; })()`));
  await shot("5-settings");

  // Last, because it takes the chat away: holding it → Delete, after the usual "are you sure?".
  await req("PATCH", `/api/chats/${A.id}`, { body: { archived: false } });
  await js(`go("chats"); window.confirm = () => true; true`);
  await until(`!!document.querySelector('${rowSel}')`, 6000);
  await hold(); await letGo();
  await js(`document.querySelector("#row-delete").click(); true`);
  check("menu → Delete deletes it", await until(`!document.querySelector('${rowSel}')`, 6000) && !(await one(A.id)));
  A = null;
  check("no errors in the page", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("test run finished without crashing", false, e.stack);
} finally {
  for (const x of [A, B, C, E]) if (x?.id) await req("DELETE", `/api/chats/${x.id}`).catch(() => {});
  await sleep(400);
  server?.kill();
  chrome?.kill();
  apple.close();
  try { execFileSync(TMUX, ["-L", "claude-chat-arch", "kill-server"], { stdio: "ignore" }); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(0);
}

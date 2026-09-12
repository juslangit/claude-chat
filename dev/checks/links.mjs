// End-to-end checks for each computer's own link — Settings' computer buttons go to that computer's page,
// which is its own Home Screen app — and for pins and read marks being kept on the computers, so every
// link and phone shows the same. Against a test copy on :4479 (own data folder, own tmux server, own .env).
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the app being checked lives, and a scratch folder for its data, profiles and screenshots.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.CLAUDE_CHAT_APP || path.resolve(HERE, "../..");
const WORK = process.env.CLAUDE_CHAT_WORK || path.join(HERE, ".work");
fs.mkdirSync(WORK, { recursive: true });

const W = APP;
const D = `${WORK}/t-links`;
const SHOTS = `${WORK}/shots-links`;
const PORT = 4479, CDP = 9341;
const SOCK = "claude-chat-links";
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
    env: { ...process.env, CLAUDE_CHAT_COMPUTER: "Test (4479)", CLAUDE_CHAT_DATA: D, CLAUDE_CHAT_SOCKET: SOCK,
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
      res.on("end", () => { let j; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    r.on("error", reject);
    r.setTimeout(120000, () => r.destroy(new Error("timeout")));
    if (data) r.write(data);
    r.end();
  });
}
const waitUp = async () => { for (let i = 0; i < 80; i++) { try { await req("GET", "/api/whoami"); return true; } catch {} await sleep(250); } return false; };
const list = async () => (await req("GET", "/api/chats")).json || [];
const one = async (id) => (await list()).find((c) => c.id === id);
const waitFor = async (id, want, ms) => { const end = Date.now() + ms; let c; while (Date.now() < end) { c = await one(id); if (want(c)) return c; await sleep(400); } return c; };

// Replies from Claude, written straight into a chat's transcript, so read marks can be checked without
// waiting for Claude to answer anything.
const transcriptOf = (id) => JSON.parse(fs.readFileSync(`${D}/chats.json`, "utf8"))[id].transcript;
let n = 0;
function fakeReply(id) {
  const file = transcriptOf(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  n++;
  fs.appendFileSync(file, JSON.stringify({ type: "assistant", uuid: `links-check-${Date.now()}-${n}`, timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text: `fake reply ${n}` }] } }) + "\n");
}

let chrome, A, B;
try {
  startServer();
  check("server starts", await waitUp());

  // ── the page is named after the kind of computer, so two Home Screen icons can be told apart ──
  const os = (await req("GET", "/api/whoami")).json?.os;
  const icon = os === "windows" ? "Claude PC" : os === "mac" ? "Claude Mac" : "Claude";
  const page = (await req("GET", "/")).text;
  const manifest = (await req("GET", "/manifest.json")).json;
  check(`the Home Screen name is "${icon}" on this ${os}`, page.includes(`name="apple-mobile-web-app-title" content="${icon}"`) && manifest?.name === icon && !page.includes("Claude Chats"),
    `manifest: ${manifest?.name}`);

  A = (await req("POST", "/api/chats", { body: { name: "first", terminal: false } })).json;
  B = (await req("POST", "/api/chats", { body: { name: "second", terminal: false } })).json;
  check("both chats reach online", (await waitFor(A.id, (c) => c?.status === "idle", 60000))?.status === "idle" && (await waitFor(B.id, (c) => c?.status === "idle", 60000))?.status === "idle");

  // ── pins, kept on the computer ──
  const pinA = (await req("PATCH", `/api/chats/${A.id}`, { body: { pinned: true } })).json;
  check("a chat can be pinned on the computer", typeof pinA?.pinnedAt === "number");
  await sleep(20);
  const pinB = (await req("PATCH", `/api/chats/${B.id}`, { body: { pinned: true } })).json;
  check("…a later pin has a later time, so it goes on top", pinB?.pinnedAt > pinA.pinnedAt);
  const again = (await req("PATCH", `/api/chats/${A.id}`, { body: { pinned: true } })).json;
  check("…pinning it again doesn't move it", again?.pinnedAt === pinA.pinnedAt);
  const unB = (await req("PATCH", `/api/chats/${B.id}`, { body: { pinned: false } })).json;
  check("…and unpinning clears it", unB?.pinnedAt === null && (await one(A.id))?.pinnedAt === pinA.pinnedAt);
  server.kill();
  await sleep(800);
  startServer();
  await waitUp();
  check("…pins survive the server restarting", (await one(A.id))?.pinnedAt === pinA.pinnedAt && (await one(B.id))?.pinnedAt === null);
  await req("PATCH", `/api/chats/${A.id}`, { body: { pinned: false } });

  // ── read marks, kept on the computer ──
  fakeReply(A.id); fakeReply(A.id); fakeReply(A.id);
  check("replies are counted", (await waitFor(A.id, (c) => c?.count === 3, 10000))?.count === 3);
  check("…and none are read yet", (await one(A.id))?.seen === 0);
  check("a read mark can't go past what's there", (await req("PATCH", `/api/chats/${A.id}`, { body: { seen: 99 } })).json?.seen === 3);
  await req("PATCH", `/api/chats/${A.id}`, { body: { seen: 1 } });
  check("…or go backwards", (await one(A.id))?.seen === 3);
  fakeReply(A.id);
  await waitFor(A.id, (c) => c?.count === 4, 10000);

  // ── the phone ──
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORK}/.chrome-links-${Date.now()}`,
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
  const base = `http://127.0.0.1:${PORT}`;

  // Pins and read marks from before, left on the phone: they move onto the computer and leave the phone.
  await S("Page.navigate", { url: `${base}/manifest.json` }); // same address, without the app running yet
  await sleep(500);
  await js(`localStorage.setItem("pinned", JSON.stringify(["home/${B.id}"])); localStorage.setItem("seen", JSON.stringify({ "${A.id}": 4 })); true`);
  await S("Page.navigate", { url: `${base}/#chats` });
  check("phone page connects", await until("home.online === true", 10000));
  check("a pin left on the phone moves onto the computer", !!(await waitFor(B.id, (c) => c?.pinnedAt, 8000))?.pinnedAt);
  check("…and so does a read mark", (await waitFor(A.id, (c) => c?.seen === 4, 8000))?.seen === 4);
  check("…then the phone forgets its own copies", await until(`localStorage.getItem("pinned") === null && localStorage.getItem("seen") === null`, 5000));
  check("…and the pinned chat is on top, with its pin", await until(`(() => { const r = document.querySelector("#chat-list .row"); return r?.dataset.id === "home/${B.id}" && !!r.querySelector(".pin"); })()`, 5000));

  // Unread counters come from the computer, and opening a chat clears them there.
  fakeReply(A.id);
  const badge = `document.querySelector('#chat-list .row[data-id="home/${A.id}"] .badge')?.textContent`;
  check("a new reply shows as 1 unread", await until(`${badge} === "1"`, 8000), await js(badge).catch(() => ""));
  await js(`go("chat/home/${A.id}"); true`);
  check("opening the chat marks it read on the computer", (await waitFor(A.id, (c) => c?.seen === 5, 8000))?.seen === 5);
  await js(`go("chats"); true`);
  check("…so its counter is gone", await until(`${badge} === undefined`, 5000));
  fakeReply(A.id);
  await until(`${badge} === "1"`, 8000);
  await js(`go("settings"); document.querySelector("#read-all").click(); true`);
  check("Mark everything read marks it read on the computer", (await waitFor(A.id, (c) => c?.seen === 6, 8000))?.seen === 6);

  // Settings: the computer buttons. This test has one server, so it plays a second computer at the same
  // address — tapping it must leave this page for that computer's own link, on its Settings.
  await js(`state.computers.push({ id: "other-4479", base: "${base}", name: "Other (test)", os: "windows", online: true }); go("settings"); document.querySelector("#profile-btn").click(); true`);
  check("the account screen shows a button for each computer", await until(`!document.querySelector("#profile-computers").hidden && document.querySelectorAll("#profile-computers .chip").length === 2`, 8000));
  check("…with this computer's button on", await js(`document.querySelector("#profile-computers .chip.on")?.dataset.comp === "home"`));
  await shot("1-account-computers");
  await js(`document.querySelector('#profile-computers .chip.on').click(); true`);
  await sleep(500);
  check("tapping this computer's own button stays put", await js(`state.computers.some((c) => c.id === "other-4479")`));

  // In the Home Screen app there is no other app iOS will open, so switching happens here, in place.
  await js(`window.inHomeScreenApp = () => true; window.stillHere = true; document.querySelector('#profile-computers .chip:not(.on)').click(); true`);
  check("in the Home Screen app it switches without leaving", await until(`document.querySelector("#profile-computers .chip.on")?.dataset.comp === "other-4479"`, 8000)
    && await js(`window.stillHere === true && location.search === ""`));
  check("…and the account screen is that computer's", await js(`accountOn.id === "other-4479"`));
  await shot("1b-switched-in-app");
  await js(`go("chats"); true`);
  await sleep(300);
  await js(`go("settings"); true`);
  check("…and it's still that computer when you come back to Settings", await until(`accountOn.id === "other-4479"`, 5000));
  await js(`document.querySelector('#profile-btn').click(); true`);
  await until(`document.querySelectorAll("#profile-computers .chip").length === 2`, 8000);
  const chipsNow = await js(`[...document.querySelectorAll("#profile-computers .chip")].map((c) => c.dataset.comp + (c.classList.contains("on") ? " (on)" : "")).join(", ") + " | accountOn=" + accountOn.id`);
  await js(`[...document.querySelectorAll('#profile-computers .chip')].find((c) => c.dataset.comp === "home").click(); true`);
  check("…tapping this computer again comes back", await until(`accountOn.id === "home" && document.querySelector("#profile-computers .chip.on")?.dataset.comp === "home"`, 8000), chipsNow);

  // In Safari there is no icon to go back to, so it opens that computer's own link instead.
  await js(`window.inHomeScreenApp = () => false; window.stillHere = true;
    [...document.querySelectorAll('#profile-computers .chip')].find((c) => c.dataset.comp === "other-4479").click(); true`);
  check("in Safari it opens the other computer's own link, on Settings", await until(`!window.stillHere && location.hash === "#settings" && !document.querySelector("#settings-view").hidden`, 10000));
  check("…the address is tidied, so it can be saved as an icon", await until(`location.search === ""`, 8000));
  check("…and it says where you are and how to add its icon", await until(`!document.querySelector("#link-hint").hidden`, 8000)
    && await js(`document.querySelector("#link-hint-title").textContent.includes("Test (4479)") && document.querySelector("#link-hint-text").textContent.includes(${JSON.stringify(icon)})`));
  await shot("2-arrived");
  await js(`document.querySelector("#link-hint-ok").click(); true`);
  check("Got it puts the tip away for good", await js(`document.querySelector("#link-hint").hidden && JSON.parse(localStorage.getItem("iconHint")) === true`));
  await S("Page.navigate", { url: `${base}/?from=Other#settings` });
  await until(`home.online === true && location.search === ""`, 10000);
  await sleep(800);
  check("…so it doesn't come back next time", await js(`document.querySelector("#link-hint").hidden`));
  check("no errors in the page", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("test run finished without crashing", false, e.stack);
} finally {
  for (const x of [A, B]) if (x?.id) await req("DELETE", `/api/chats/${x.id}`).catch(() => {});
  await sleep(400);
  server?.kill();
  chrome?.kill();
  try { execFileSync(TMUX, ["-L", SOCK, "kill-server"], { stdio: "ignore" }); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(0);
}

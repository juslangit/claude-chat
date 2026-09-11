// End-to-end checks for claude-chat's feat/photos-pins-search-reply-push, against a test copy on :4479
// (own data folder, own tmux server, Haiku, and its own .env file — the real ~/.claude/.env is never
// touched). A fake "Apple" on :4481 decrypts every notification and checks its signature.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import vm from "node:vm";
import { createRequire } from "node:module";

import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the app being checked lives, and a scratch folder for its data, profiles and screenshots.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.CLAUDE_CHAT_APP || path.resolve(HERE, "../..");
const WORK = process.env.CLAUDE_CHAT_WORK || path.join(HERE, ".work");
fs.mkdirSync(WORK, { recursive: true });

const W = APP;
const D = `${WORK}/t-data2`;
const ENV = `${D}/env`;
const SHOTS = `${WORK}/shots2`;
const PORT = 4479, RECV = 4481, CDP = 9335;
const TMUX = "/opt/homebrew/bin/tmux";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`);
};
const push = await import(`${W}/push.mjs`);
const b64u = (b) => Buffer.from(b).toString("base64url");

fs.mkdirSync(D, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.writeFileSync(ENV, "SOME_OTHER_KEY=keep-me\n", { mode: 0o600 });

let server;
function startServer() {
  const out = fs.openSync(`${D}/server.log`, "a");
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: W, stdio: ["ignore", out, out],
    env: { ...process.env, CLAUDE_CHAT_COMPUTER: "Test (4479)", CLAUDE_CHAT_DATA: D, CLAUDE_CHAT_SOCKET: "claude-chat-test",
      PORT: String(PORT), ANTHROPIC_MODEL: "claude-haiku-4-5", CLAUDE_CHAT_ENV_FILE: ENV },
  });
}
function req(method, p, { headers = {}, body, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw ?? (body ? JSON.stringify(body) : null);
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method,
      headers: { ...(data && { "content-type": "application/json", "content-length": Buffer.byteLength(data) }), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const buf = Buffer.concat(chunks); let j; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json: j, buf, type: res.headers["content-type"] }); });
    });
    r.on("error", reject);
    r.setTimeout(120000, () => r.destroy(new Error("timeout")));
    if (data) r.write(data);
    r.end();
  });
}
async function waitUp() {
  for (let i = 0; i < 80; i++) { try { await req("GET", "/api/whoami"); return true; } catch {} await sleep(250); }
  return false;
}

// ── a fake phone and a fake Apple push service ──
const phone = crypto.createECDH("prime256v1");
const phonePub = phone.generateKeys();
const auth = crypto.randomBytes(16);
const sub = (p) => ({ endpoint: `http://127.0.0.1:${RECV}${p}`, keys: { p256dh: b64u(phonePub), auth: b64u(auth) } });
function decrypt(body) {
  const salt = body.subarray(0, 16), idlen = body[20], from = body.subarray(21, 21 + idlen), sealed = body.subarray(21 + idlen);
  const hk = (s, ikm, info, n) => Buffer.from(crypto.hkdfSync("sha256", ikm, s, info, n));
  const ikm = hk(auth, phone.computeSecret(from), Buffer.concat([Buffer.from("WebPush: info\0"), phonePub, from]), 32);
  const d = crypto.createDecipheriv("aes-128-gcm", hk(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16), hk(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12));
  d.setAuthTag(sealed.subarray(-16));
  const pt = Buffer.concat([d.update(sealed.subarray(0, -16)), d.final()]);
  let i = pt.length - 1;
  while (pt[i] === 0) i--;
  if (pt[i] !== 2) throw new Error("bad padding");
  return JSON.parse(pt.subarray(0, i).toString());
}
function vapidProblem(header) {
  const m = String(header).match(/^vapid t=([^,]+), k=(.+)$/);
  if (!m) return "no vapid header";
  const [h, c, s] = m[1].split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  const pub = Buffer.from(m[2], "base64url");
  const key = crypto.createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) } });
  if (!crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))) return "bad signature";
  if (claims.aud !== `http://127.0.0.1:${RECV}`) return `aud ${claims.aud}`;
  if (!claims.sub) return "no sub";
  if (!(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400)) return `exp ${claims.exp}`;
  return null;
}
const received = [];
const apple = http.createServer((q, s) => {
  const chunks = [];
  q.on("data", (c) => chunks.push(c));
  q.on("end", () => {
    if (q.url === "/gone") { s.writeHead(410); return s.end(); }
    try {
      received.push({ path: q.url, payload: decrypt(Buffer.concat(chunks)), vapid: vapidProblem(q.headers.authorization), encoding: q.headers["content-encoding"], ttl: q.headers.ttl });
      s.writeHead(201);
    } catch (e) { received.push({ path: q.url, error: e.message }); s.writeHead(400); }
    s.end();
  });
}).listen(RECV, "127.0.0.1");
const waitPush = async (n, ms) => { const end = Date.now() + ms; while (Date.now() < end && received.length < n) await sleep(200); return received.length >= n; };

let chrome, A, B;
try {
  // ── 1. the push pieces on their own ──
  // Optional: check our own encryption against a well-known library. It isn't part of the app (D-005),
  // so it only runs if you've put it in the work folder:
  //   mkdir -p dev/checks/.work/pushcheck && cd dev/checks/.work/pushcheck && npm i http_ece
  try {
    const ece = createRequire(`${WORK}/pushcheck/`)("http_ece");
    const out = ece.decrypt(push.encrypt(JSON.stringify({ hi: "there" }), sub("/x")), { version: "aes128gcm", privateKey: phone, authSecret: auth });
    check("encryption matches the reference library (http_ece)", JSON.parse(out).hi === "there");
  } catch { console.log("SKIP  encryption against the reference library — http_ece isn't installed here"); }

  const swCode = fs.readFileSync(`${W}/public/sw.js`, "utf8");
  const shown = [], on = {};
  const self = { location: { origin: "https://luqman-mac.tail8806f8.ts.net" }, addEventListener: (t, f) => (on[t] = f), skipWaiting() {},
    clients: { claim() {} }, registration: { showNotification: async (title, o) => shown.push({ title, ...o }) } };
  vm.runInNewContext(swCode, { self, URL });
  for (const d of [{ title: "t", body: "b", chat: "abc", url: "https://luqman-mac.tail8806f8.ts.net" }, { title: "t", body: "b", chat: "def", url: "https://desktop-k2m7l30.tail8806f8.ts.net" }])
    on.push({ data: { json: () => d }, waitUntil: (p) => p });
  check("service worker: a Mac chat's notification opens home/<chat>", shown[0]?.data.key === "home/abc", shown[0]?.data.key);
  check("service worker: a PC chat's notification opens that computer's chat", shown[1]?.data.key === "desktop-k2m7l30-tail8806f8-ts-net/def", shown[1]?.data.key);

  // ── 2. the server's side of notifications ──
  startServer();
  check("server starts", await waitUp());
  const k1 = (await req("GET", "/api/push/key")).json?.key;
  const env = fs.readFileSync(ENV, "utf8");
  check("signing key made, 65-byte public half", Buffer.from(k1 || "", "base64url").length === 65);
  check("key added to the .env, other keys kept", env.includes("SOME_OTHER_KEY=keep-me") && env.includes(`CLAUDE_CHAT_VAPID_PUBLIC=${k1}`) && /CLAUDE_CHAT_VAPID_PRIVATE=\S{40,}/.test(env));
  check("asking again gives the same key", (await req("GET", "/api/push/key")).json?.key === k1);
  check("a bad push address is refused", (await req("POST", "/api/push/subscribe", { body: { endpoint: "http://evil.example.com/x", keys: sub("/").keys } })).status === 400);
  check("phone's push address accepted", (await req("POST", "/api/push/subscribe", { body: sub("/phone") })).json?.count === 1);
  await req("POST", "/api/push/subscribe", { body: sub("/gone") });
  const test = (await req("POST", "/api/push/test", { body: {} })).json;
  check("test notification: one delivered, the dead address reported", test?.sent === 1 && test.failed.length === 1, JSON.stringify(test));
  const t0 = received[0];
  check("it decrypts on the phone, with a valid signature", t0?.payload?.body?.startsWith("Notifications are on") && t0.vapid === null && t0.encoding === "aes128gcm" && t0.ttl, JSON.stringify(t0));
  check("the dead address is forgotten", JSON.parse(fs.readFileSync(`${D}/push.json`, "utf8")).length === 1);

  // ── 3. notifications from a real chat ──
  A = (await req("POST", "/api/chats", { body: { name: "push test", terminal: false } })).json;
  const status = async (id = A.id) => (await req("GET", "/api/chats")).json.find((x) => x.id === id)?.status;
  const waitFor = async (want, ms, id) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await status(id); if (want(s)) return s; await sleep(400); } return s; };
  const messages = async () => (await req("GET", `/api/chats/${A.id}/messages`)).json;
  const turn = async (text) => {
    const r = await req("POST", `/api/chats/${A.id}/send`, { body: { text } });
    await waitFor((s) => s === "working", 20000);
    await waitFor((s) => s === "idle", 120000);
    return r.status;
  };
  check("chat reaches online", (await waitFor((s) => s === "idle", 60000)) === "idle");
  const before = received.length;
  await turn("Reply with just the word: ok");
  check("a finished reply sends a notification", await waitPush(before + 1, 10000));
  const p1 = received[before]?.payload;
  check("…saying Claude's words, for that chat", p1?.title === "push test" && /\bok\b/i.test(p1.body) && p1.chat === A.id, JSON.stringify(p1));

  const secret = fs.readFileSync(`${D}/secret`, "utf8").trim();
  const n2 = received.length;
  const hook = req("POST", "/hook", { headers: { "x-secret": secret }, body: { chatId: A.id, event: { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "echo hi" } } } });
  check("Claude asking for approval sends a notification", await waitPush(n2 + 1, 5000));
  check("…saying what it wants to run", received[n2]?.payload?.body === "Needs your OK: echo hi", received[n2]?.payload?.body);
  const reqId = (await req("GET", "/api/chats")).json.find((x) => x.id === A.id)?.pending?.reqId;
  await req("POST", `/api/chats/${A.id}/approve`, { body: { decision: "deny", reqId } });
  await hook;
  await waitFor((s) => s === "idle", 20000);
  await sleep(2500);

  // ── 4. the phone page ──
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORK}/.chrome-e2e2-${Date.now()}`, // a fresh profile, so nothing is remembered from a previous run
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
  await S("Emulation.setDeviceMetricsOverride", { width: 500, height: 900, deviceScaleFactor: 2, mobile: true });
  const js = async (expression) => {
    const r = await S("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const shot = async (name, dark = false) => {
    await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await sleep(350);
    const { data } = await S("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, "base64"));
  };
  const until = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr).catch(() => false)) return true; await sleep(300); } return false; };
  // A finger dragged right across an element, as pointer events.
  const swipe = (selector, index) => js(`(() => {
    const all = document.querySelectorAll(${JSON.stringify(selector)}), el = all[${index} < 0 ? all.length + ${index} : ${index}];
    const r = el.getBoundingClientRect(), x = r.left + 20, y = r.top + r.height / 2;
    const ev = (type, dx) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x + dx, clientY: y, pointerId: 7, pointerType: "touch", button: 0, isPrimary: true }));
    ev("pointerdown", 0); for (const dx of [15, 30, 50, 70, 85]) ev("pointermove", dx); ev("pointerup", 85);
    return true;
  })()`);

  await S("Page.navigate", { url: `http://127.0.0.1:${PORT}/#chat/home/${A.id}` });
  check("phone page connects", await until("home.online === true", 10000));
  check("service worker registered", await until(`navigator.serviceWorker.ready.then((r) => r.active?.scriptURL.endsWith("/sw.js"))`, 8000));
  check("the phone turns the key into the 65 bytes Apple wants", await js(`fetch("/api/push/key").then((r) => r.json()).then((j) => fromB64u(j.key).length === 65 && toB64u(fromB64u(j.key)) === j.key)`));
  const quiet = received.length;

  // photo: a red picture, sent the way the + button sends it
  await js(`(async () => {
    const cv = Object.assign(document.createElement("canvas"), { width: 2400, height: 1800 });
    const g = cv.getContext("2d"); g.fillStyle = "#e00000"; g.fillRect(0, 0, 2400, 1800);
    const blob = await new Promise((r) => cv.toBlob(r, "image/png"));
    photo = await shrink(new File([blob], "red.png", { type: "image/png" }));
    document.querySelector("#photo-preview").src = photo.url;
    document.querySelector("#photo-caption").value = "What colour is this photo? Answer with one word.";
    openSheet("#photo-sheet");
    return true;
  })()`);
  check("photo shrunk to 1600 px across", await js(`new Promise((r) => { const i = new Image(); i.onload = () => r(i.naturalWidth === 1600 && i.naturalHeight === 1200); i.src = photo.url; })`));
  await shot("photo-sheet");
  await js("sendPhoto().then(() => true)");
  const dir = `${D}/photos/${A.id}`;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  check("photo saved on the computer", files.length === 1 && /^\d+\.jpg$/.test(files[0]), files.join(","));
  const got = await req("GET", `/api/chats/${A.id}/photos/${files[0]}`);
  check("…and served back as a JPEG", got.status === 200 && got.type === "image/jpeg" && got.buf[0] === 0xff);
  await waitFor((s) => s === "working", 20000);
  await waitFor((s) => s === "idle", 120000);
  await sleep(1500);
  const saw = (await messages()).filter((m) => m.role === "assistant").at(-1)?.text || "";
  check("Claude looked at the photo and saw red", /red/i.test(saw), saw.slice(0, 80));
  check("the photo shows in the chat", await until(`[...document.querySelectorAll("#messages .bubble.out img.photo")].some((i) => i.complete && i.naturalWidth > 0)`, 8000));
  const photoLine = (await messages()).filter((m) => m.role === "user").at(-1)?.text || "";
  console.log(`      (how the photo reached Claude: ${JSON.stringify(photoLine.slice(0, 120))})`);

  // swipe Claude's last message to reply to it
  await swipe("#messages .bubble.in:not(.tools)", -1);
  check("swiping a message quotes it above the typing box", await js(`!document.querySelector("#reply-bar").hidden && document.querySelector("#reply-who").textContent === "Claude" && /red/i.test(document.querySelector("#reply-text").textContent)`));
  await js(`input.value = "Reply with just the word: yes"; grow(); true`);
  await shot("reply-bar");
  await js("send().then(() => true)");
  check("reply bar clears once sent", await until(`document.querySelector("#reply-bar").hidden`, 20000));
  await waitFor((s) => s === "working", 20000);
  await waitFor((s) => s === "idle", 120000);
  await sleep(1500);
  const mine = (await messages()).filter((m) => m.role === "user").at(-1)?.text || "";
  check("Claude got the quote in front of the message", mine.startsWith('Replying to your message: "') && mine.endsWith("Reply with just the word: yes"), mine.slice(0, 90));
  check("the chat shows it as a quote, not as text", await until(`(() => { const b = [...document.querySelectorAll("#messages .bubble.out")].at(-1); return b?.querySelector(".quote b")?.textContent === "Claude" && !b.textContent.includes("Replying to"); })()`, 5000));
  check("no notifications while the app is open in front of you", received.length === quiet, `${received.length - quiet} arrived`);
  await shot("chat-photo-reply");
  await shot("chat-photo-reply-dark", true);
  await S("Emulation.setEmulatedMedia", { features: [] });

  // search inside the chat
  await js(`openFind(); document.querySelector("#find-input").value = "word"; runFind(); true`);
  const found = await js(`({ count: document.querySelector("#find-count").textContent, hits: finder.hits.length, marked: canMark && CSS.highlights.has("find") && CSS.highlights.has("find-now") })`);
  check("search finds the matches, newest first", found.hits >= 2 && found.count === `${found.hits} of ${found.hits}` && found.marked, JSON.stringify(found));
  await js("stepFind(-1); true");
  check("the arrows step to an earlier match", await js(`document.querySelector("#find-count").textContent === \`\${finder.hits.length - 1} of \${finder.hits.length}\``));
  await shot("search");
  await js(`document.querySelector("#find-input").value = "zebra-not-here"; runFind(); true`);
  check("no match says so", await js(`document.querySelector("#find-count").textContent === "No results"`));
  await js("closeFind(); true");

  // Chat info and the ⋯ menu
  await js(`document.querySelector("#chat-head").click(); true`);
  await sleep(300);
  check("Chat info has Search and Pin", await js(`!!document.querySelector("#info-search") && document.querySelector("#pin-label").textContent === "Pin chat"`));
  await shot("chat-info");
  await js("closeSheets(); true");

  // pins: a second chat is newer, so it's on top — until the first is pinned
  B = (await req("POST", "/api/chats", { body: { name: "second chat", terminal: false } })).json;
  await js(`go("chats"); true`);
  check("list shows both chats, newest on top", await until(`(() => { const r = document.querySelectorAll("#chat-list .row"); return r.length >= 2 && r[0].dataset.id === "home/${B.id}"; })()`, 10000));
  await swipe(`#chat-list .row[data-id="home/${A.id}"]`, 0);
  check("swiping a chat pins it to the top", await until(`(() => { const r = document.querySelector("#chat-list .row"); return r.dataset.id === "home/${A.id}" && !!r.querySelector(".pin") && JSON.parse(localStorage.pinned).includes("home/${A.id}"); })()`, 3000));
  check("the swipe didn't also open the chat", await js(`location.hash === "#chats"`));
  await shot("list-pinned");
  await js(`go("settings"); true`);
  await sleep(300);
  check("the Settings screen has Notifications", await js(`document.querySelector("#notify-state").textContent === "Off"`));
  await shot("menu");
  await js(`closeSheets(); go("chat/home/${A.id}"); true`);
  await sleep(800);
  await js(`document.querySelector("#chat-head").click(); document.querySelector("#pin-chat").click(); closeSheets(); go("chats"); true`);
  check("Chat info → Unpin puts it back", await until(`document.querySelector("#chat-list .row").dataset.id === "home/${B.id}" && JSON.parse(localStorage.pinned).length === 0`, 3000));
  check("no errors in the page", errors.length === 0, errors.join(" | "));

  // leave the app: the computer is told, and notifications come again
  await S("Page.navigate", { url: "about:blank" });
  await sleep(1500);
  const n4 = received.length;
  await turn("Reply with just the word: done");
  check("after leaving the app, a finished reply notifies again", await waitPush(n4 + 1, 10000) && /\bdone\b/i.test(received[n4]?.payload?.body), received[n4]?.payload?.body);
  check("every notification decrypted with a valid signature", received.every((r) => !r.error && r.vapid === null), JSON.stringify(received.filter((r) => r.error || r.vapid)));
} catch (e) {
  check("test run finished without crashing", false, e.stack);
} finally {
  for (const c of [A, B]) if (c?.id) await req("DELETE", `/api/chats/${c.id}`).catch(() => {});
  check("ending a chat removes its photos", !fs.existsSync(`${D}/photos/${A?.id}`));
  server?.kill();
  chrome?.kill();
  apple.close();
  try { execFileSync(TMUX, ["-L", "claude-chat-test", "kill-server"], { stdio: "ignore" }); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(0);
}

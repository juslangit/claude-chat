// End-to-end checks for claude-chat's fix/reliability-security branch, run against a test copy on :4479
// (own data folder, own tmux server, Haiku). A small proxy on :4480 stands in for tailscale serve: it
// answers 502 while the server is down, which is what left the phone stuck on "Connecting…".
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
const D = `${WORK}/t-data`;
const SHOTS = `${WORK}/shots`;
const PORT = 4479, PROXY = 4480, CDP = 9334;
const TMUX = "/opt/homebrew/bin/tmux";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`);
};

// ── test data: a half-written chat list and a 6 MB log ──
fs.mkdirSync(D, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
let big = "";
for (let i = 0; big.length < 6e6; i++) big += `old log line ${i}\n`;
fs.writeFileSync(`${D}/server.log`, big);
fs.writeFileSync(`${D}/chats.json`, '{"half-written": ');

let server;
function startServer() {
  const out = fs.openSync(`${D}/server.log`, "a");
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: W, stdio: ["ignore", out, out],
    env: { ...process.env, CLAUDE_CHAT_COMPUTER: "Test (4479)", CLAUDE_CHAT_DATA: D, CLAUDE_CHAT_SOCKET: "claude-chat-test", PORT: String(PORT), ANTHROPIC_MODEL: "claude-haiku-4-5", CLAUDE_CHAT_ENV_FILE: `${D}/env` },
  });
}
function req(method, p, { headers = {}, body, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port, path: p, method,
      headers: { ...(data && { "content-type": "application/json", "content-length": Buffer.byteLength(data) }), ...headers } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => { let j; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    r.on("error", reject);
    r.setTimeout(60000, () => r.destroy(new Error("timeout")));
    if (data) r.write(data);
    r.end();
  });
}
async function waitUp() {
  for (let i = 0; i < 80; i++) { try { await req("GET", "/api/whoami"); return true; } catch {} await sleep(250); }
  return false;
}

// ── stand-in for tailscale serve ──
// Like Go's reverse proxy: a connection cut on the computer's side is cut for the phone too, and a
// computer that isn't there gets a 502. `frozen` is a computer that dropped off the network: nothing
// arrives and nothing fails, the lines just go quiet.
let frozen = false;
const held = new Set();
const proxy = http.createServer((q, s) => {
  if (frozen) { held.add(s); return; }
  const up = http.request({ host: "127.0.0.1", port: PORT, path: q.url, method: q.method, headers: q.headers }, (r) => {
    s.writeHead(r.statusCode, r.headers);
    r.on("data", (ch) => { if (!frozen) s.write(ch); else held.add(s); });
    r.on("end", () => { if (!frozen) s.end(); });
    r.on("close", () => { if (!r.complete && !frozen) s.destroy(); });
  });
  up.on("error", () => { if (frozen) return; if (!s.headersSent) { s.writeHead(502); s.end("bad gateway"); } else s.destroy(); });
  s.on("close", () => up.destroy());
  q.pipe(up);
}).listen(PROXY, "127.0.0.1");
const thaw = () => { frozen = false; for (const s of held) s.destroy(); held.clear(); };

let chrome, c;
try {
  // ── 1. starting up ──
  startServer();
  check("server starts", await waitUp());
  const files = fs.readdirSync(D);
  check("unreadable chats.json was put aside, not overwritten", files.some((f) => f.startsWith("chats.json.unreadable-")), files.join(", "));
  const log = fs.readFileSync(`${D}/server.log`, "utf8");
  check("6 MB log trimmed to about 1 MB", log.length < 1.1e6 && log.length > 0.9e6, `${(log.length / 1e6).toFixed(2)} MB`);
  check("trimmed log starts on a whole line", /^old log line \d+\n/.test(log));
  check("log explains what happened to the chat list", log.includes("couldn't be read"));
  check("log still being written after the trim", log.includes(`claude-chat on http://127.0.0.1:${PORT}`));

  // ── 2. Host header (DNS rebinding) ──
  const who = async (headers) => (await req("GET", "/api/whoami", { headers })).status;
  check("request to 127.0.0.1 allowed", (await who({})) === 200);
  check("request to this tailnet's name allowed", (await who({ host: "luqman-mac.tail8806f8.ts.net" })) === 200);
  check("request to another site's name refused", (await who({ host: "evil.example.com:4479" })) === 403);
  check("forwarded to another site's name refused", (await who({ "x-forwarded-host": "evil.example.com" })) === 403);
  check("request to another tailnet's name refused", (await who({ host: "x.tail0000.ts.net" })) === 403);
  check("chat list refused to a rebinding page", (await req("GET", "/api/chats", { headers: { host: "evil.example.com" } })).status === 403);

  // ── 3. pages from elsewhere ──
  const post = async (origin) => (await req("POST", "/api/chats/nope/send", { headers: { origin }, body: { text: "x" } })).status;
  check("page from another tailnet refused", (await post("https://x.tail0000.ts.net")) === 403);
  check("page from another site refused", (await post("https://evil.example.com")) === 403);
  check("page from this tailnet let through", (await post("https://desktop-k2m7l30.tail8806f8.ts.net")) === 404, "404 = past the checks, chat doesn't exist");

  // ── 4. the live stream ──
  const pingSeen = new Promise((resolve) => {
    let got = "";
    const r = http.get({ host: "127.0.0.1", port: PORT, path: "/events" }, (res) => res.on("data", (ch) => {
      got += ch;
      if (got.includes("event: ping")) { r.destroy(); resolve(got); }
    }));
    setTimeout(() => { r.destroy(); resolve(got); }, 23000);
  });

  // ── 5. computers ──
  const comps = (await req("GET", "/api/computers")).json;
  check("computers list says online / last seen", Array.isArray(comps) && comps.length > 0 && comps.every((p) => "online" in p && "lastSeen" in p), JSON.stringify(comps));

  // ── 6. pairing codes (a bad Syncthing ID throughout, so nothing reaches Syncthing) ──
  const code = (await req("POST", "/api/sync/code", { body: {} })).json?.code;
  check("pairing code made", /^\d{6}$/.test(code || ""));
  const pair = (k) => req("POST", "/api/sync/pair", { body: { id: "NOT-AN-ID", name: "e2e", code: k } });
  check("right code gets past the code check", (await pair(code)).status === 400);
  const wrong = code === "000000" ? "111111" : "000000";
  const tries = [];
  for (let i = 0; i < 5; i++) tries.push((await pair(wrong)).status);
  check("five wrong codes refused", tries.every((s) => s === 403), tries.join(","));
  const after = await pair(code);
  check("right code no longer works after five wrong ones", after.status === 403, after.json?.error);

  // ── 7. a real chat ──
  const secret = fs.readFileSync(`${D}/secret`, "utf8").trim();
  c = (await req("POST", "/api/chats", { body: { name: "e2e test", terminal: false } })).json;
  check("chat created", !!c?.id);
  const status = async () => (await req("GET", "/api/chats")).json.find((x) => x.id === c.id)?.status;
  const waitFor = async (want, ms) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await status(); if (want(s)) return s; await sleep(400); } return s; };
  check("chat reaches online (idle)", (await waitFor((s) => s === "idle", 60000)) === "idle");
  await sleep(400);
  check("chats.json saved whole with the chat in it", !!JSON.parse(fs.readFileSync(`${D}/chats.json`, "utf8"))[c.id]);
  check("no spare .tmp file left behind", !fs.existsSync(`${D}/chats.json.tmp`));
  const sent = await req("POST", `/api/chats/${c.id}/send`, { body: { text: "First run the shell command: sleep 12 — then reply with just the word: ok" } });
  check("message sent", sent.status === 200, sent.json?.error);
  check("chat goes to working", (await waitFor((s) => s === "working", 20000)) === "working");
  // While Claude works (incl. a 12 s command), the screen check must not call it finished early.
  const answered = async () => (await req("GET", `/api/chats/${c.id}/messages`)).json.some((m) => m.role === "assistant" && /\bok\b/i.test(m.text));
  let early = false;
  for (const end = Date.now() + 120000; Date.now() < end;) {
    const s = await status();
    if (s === "idle") { early = !(await answered()) && !(await sleep(1500), await answered()); break; }
    await sleep(400);
  }
  check("chat back to idle after the reply", (await status()) === "idle");
  check("never marked finished before Claude had replied", !early);
  check("Claude answered", await answered());

  // ── 8. stuck "typing…": a hook says working, but Claude is sitting at its prompt ──
  await req("POST", "/hook", { headers: { "x-secret": secret }, body: { chatId: c.id, event: { hook_event_name: "UserPromptSubmit" } } });
  check("fake hook marked it working", (await status()) === "working");
  const t0 = Date.now();
  const un = await waitFor((s) => s === "idle", 20000);
  check("stuck 'typing…' clears by itself", un === "idle", `${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const pinged = await pingSeen;
  check("live stream sets a 3 s retry", pinged.includes("retry: 3000"));
  check("live stream sends a ping the page can see", pinged.includes("event: ping"));

  // ── 9. the phone page, in headless Chrome, through the proxy ──
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORK}/.chrome-e2e`,
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
    await sleep(300);
    const { data } = await S("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, "base64"));
  };
  const until = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr).catch(() => false)) return true; await sleep(300); } return false; };

  await S("Page.navigate", { url: `http://127.0.0.1:${PROXY}/` });
  check("phone page connects", await until("home.online === true", 10000));

  // messages that arrive while a chat's history is loading are kept
  const key = `home/${c.id}`;
  await js(`location.hash = "chat/${key}"; true`);
  await sleep(1500);
  const kept = await js(`(async () => {
    const real = window.fetch;
    window.fetch = (u, o) => String(u).includes("/messages") ? new Promise((r) => setTimeout(() => r(real(u, o)), 1500)) : real(u, o);
    const load = loadMessages(state.current);
    await new Promise((r) => setTimeout(r, 300));
    onEvent({ type: "messages", chatId: ${JSON.stringify(c.id)}, messages: [{ id: "e2e-live-1", role: "assistant", text: "arrived during the load", at: Date.now() }] });
    await load;
    window.fetch = real;
    return document.querySelector("#messages").textContent.includes("arrived during the load");
  })()`);
  check("message arriving mid-load is kept on screen", kept);

  // a call whose microphone keeps stopping straight away
  const callState = await js(`(async () => {
    window.SpeechRecognition = window.webkitSpeechRecognition = class { start() { setTimeout(() => this.onend?.(), 20); } stop() { setTimeout(() => this.onend?.(), 10); } abort() { this.stop(); } };
    speechSynthesis.speak = (u) => setTimeout(() => u.onend?.(), 50);
    speechSynthesis.cancel = () => {};
    await startCall();
    await new Promise((r) => setTimeout(r, 6000));
    return { text: document.querySelector("#call-state").textContent, muted: call.muted, listening: !!call.listener };
  })()`);
  check("call stops retrying a dead microphone and says so", callState.text === "The microphone stopped. Tap Mute to try again." && callState.muted && !callState.listening, JSON.stringify(callState));
  await shot("call-mic-stopped");
  await js("endCall(); true");

  // the server goes away (tailscale serve would answer 502), then comes back
  server.kill();
  await new Promise((r) => server.once("exit", r));
  check("page notices the computer is gone", await until("home.online === false", 15000));
  await sleep(4000);
  const sub = await js(`document.querySelector("#chat-status").textContent`);
  check("chat's top bar says offline since", /^offline since \d\d:\d\d$/.test(sub), sub);
  await shot("chat-offline");
  await js(`go("chats"); true`);
  await sleep(500);
  const note = await js(`document.querySelector("#offline-notes").textContent.replace(/\\s+/g, " ").trim()`);
  check("chat list shows an offline note", /Test \(4479\) — offline since \d\d:\d\d/.test(note), note);
  const comp = await js(`(() => { go("computers"); renderComputers(); return document.querySelector("#computer-list").textContent.replace(/\\s+/g, " "); })()`);
  check("the Computers screen says offline since", /offline since \d\d:\d\d/.test(comp), comp.trim());
  await js(`go("chats"); true`);
  await shot("list-offline-light");
  await shot("list-offline-dark", true);
  await S("Emulation.setEmulatedMedia", { features: [] });

  // messages typed while the computer is off wait on the phone, with a clock instead of ticks
  await js(`window.confirm = () => true; location.hash = "chat/${key}"; true`);
  await sleep(800);
  await js(`input.value = "first while it was off"; grow(); send(); true`);
  check("a message sent to a computer that's off waits on the phone", await until(`(() => {
    const b = document.querySelector('#waiting .bubble.waiting');
    return !!b && b.textContent.includes("first while it was off") && !!b.querySelector(".waiting-mark");
  })()`, 6000));
  check("…the typing box is cleared, as if it had gone", await js(`input.value === ""`));
  check("…and it's kept on the phone, so closing the app doesn't lose it", await js(`(JSON.parse(localStorage.queued || "{}")["${key}"] || []).length === 1`));
  await shot("chat-waiting");
  await js(`input.value = "second while it was off"; grow(); send(); true`);
  await until(`document.querySelectorAll('#waiting .bubble.waiting').length === 2`, 6000);
  await js(`go("chats"); true`);
  await sleep(400);
  const waitNote = await js(`document.querySelector("#chat-list .row .ptext").textContent.replace(/\\s+/g, " ").trim()`);
  check("the chat list says how many are waiting", /2 messages waiting to send/.test(waitNote), waitNote);
  await shot("list-waiting");
  await js(`location.hash = "chat/${key}"; true`);
  await sleep(600);
  await js(`document.querySelector('#waiting .bubble.waiting').click(); true`);
  check("tapping one throws it away", await until(`document.querySelectorAll('#waiting .bubble.waiting').length === 1
    && document.querySelector('#waiting .bubble.waiting').textContent.includes("second while it was off")`, 4000));

  const closed = await js("home.source.readyState");
  console.log(`      (live stream state while the server is down: ${["connecting", "open", "closed"][closed]})`);

  startServer();
  await waitUp();
  const t1 = Date.now();
  check("page reconnects by itself, no app switch needed", await until("home.online === true", 45000), `${((Date.now() - t1) / 1000).toFixed(1)} s after the server came back`);
  check("offline note gone once back", await until(`document.querySelector("#offline-notes").textContent.trim() === ""`, 5000));
  check("what waited is sent by itself once the computer is back", await until(`document.querySelectorAll('#waiting .bubble.waiting').length === 0`, 20000)
    && !(await js(`localStorage.queued`)));
  const saidBy = async () => ((await req("GET", `/api/chats/${c.id}/messages`)).json || []).filter((m) => m.role === "user").map((m) => m.text);
  let said = [];
  for (let i = 0; i < 40; i++) { said = await saidBy(); if (said.some((s) => s.includes("second while it was off"))) break; await sleep(500); }
  check("…and the computer really got it", said.some((s) => s.includes("second while it was off")), JSON.stringify(said).slice(0, 200));
  check("…while the one you threw away stayed away", !said.some((s) => s.includes("first while it was off")));
  await shot("list-back-online");

  // the computer drops off the network without a word (what the Mac did at 19:43)
  frozen = true;
  const t2 = Date.now();
  check("a silent computer is shown offline within about a minute", await until("home.online === false", 90000), `${((Date.now() - t2) / 1000).toFixed(0)} s`);
  const note2 = await js(`document.querySelector("#offline-notes").textContent.replace(/\\s+/g, " ").trim()`);
  check("its note says when it was last heard from", /offline since \d\d:\d\d/.test(note2), note2);
  thaw();
  const t3 = Date.now();
  check("back online once the network returns", await until("home.online === true", 45000), `${((Date.now() - t3) / 1000).toFixed(1)} s`);
  check("no errors in the page", errors.length === 0, errors.join(" | "));

  // ── 10. a chat that stops ──
  execFileSync(TMUX, ["-L", "claude-chat-test", "kill-session", "-t", c.tmux]);
  check("stopped chat shows as ended", (await waitFor((s) => s === "ended", 10000)) === "ended");
} catch (e) {
  check("test run finished without crashing", false, e.stack);
} finally {
  if (c?.id) await req("DELETE", `/api/chats/${c.id}`).catch(() => {});
  server?.kill();
  chrome?.kill();
  proxy.close();
  try { execFileSync(TMUX, ["-L", "claude-chat-test", "kill-server"], { stdio: "ignore" }); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(0);
}

// Android check: the page as Chrome on an Android phone sees it — installable (Chrome's own verdict),
// every icon loads, no script errors, and the words are Android's, not the iPhone's.
//   node dev/checks/android.mjs [out dir]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "../..");
const WORK = path.join(HERE, ".work");
const D = `${WORK}/t-android`, OUT = process.argv[2] || `${WORK}/shots-android`;
const PORT = 4481, CDP = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(D, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const log = fs.openSync(`${D}/server.log`, "a");
const server = spawn(process.execPath, ["server.mjs"], { cwd: APP, stdio: ["ignore", log, log],
  env: { ...process.env, CLAUDE_CHAT_COMPUTER: "Test Mac", CLAUDE_CHAT_DATA: D, CLAUDE_CHAT_SOCKET: "claude-chat-android",
    PORT: String(PORT), CLAUDE_CHAT_ENV_FILE: `${D}/env` } });
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new",
  `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORK}/.chrome-android-${Date.now()}`, "--no-first-run",
  "--no-default-browser-check", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

let pass = 0, fail = 0;
const check = (ok, what, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "✓" : "✗"} ${what}${extra && !ok ? ` — ${extra}` : ""}`); };

try {
  let ver;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(250); ver = await fetch(`http://127.0.0.1:${CDP}/json/version`).then((r) => r.json()).catch(() => null); }
  for (let i = 0; i < 60; i++) { if (await fetch(`http://127.0.0.1:${PORT}/`).then(() => true).catch(() => false)) break; await sleep(250); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let seq = 0; const waiting = new Map(), errors = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) { const w = waiting.get(d.id); waiting.delete(d.id); d.error ? w.rej(new Error(d.error.message)) : w.res(d.result); }
    if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Runtime.enable"); await S("Page.enable");
  // A Pixel 8: its screen, its touch, and Chrome on Android's own user agent.
  await S("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true });
  await S("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await S("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36", platform: "Android" });
  await S("Page.navigate", { url: `http://localhost:${PORT}/` });
  await sleep(3500);
  const ev = async (e) => (await S("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result.value;

  const man = await S("Page.getAppManifest");
  check(!man.errors?.length, "manifest parses", JSON.stringify(man.errors));
  const m = JSON.parse(man.data || "{}");
  check(m.name === "Claude Mac" || m.name === "Claude PC" || m.name === "Claude", "manifest named after the computer", m.name);
  check(m.icons?.some((i) => i.sizes === "192x192") && m.icons?.some((i) => i.purpose === "maskable"), "192px and maskable icons listed");
  for (const src of [...(m.icons || []).map((i) => i.src), "/badge.png"]) {
    const r = await fetch(`http://localhost:${PORT}${src}`);
    check(r.ok && r.headers.get("content-type") === "image/png", `${src} served as a PNG`, `${r.status} ${r.headers.get("content-type")}`);
  }
  const inst = await S("Page.getInstallabilityErrors");
  check(!inst.installabilityErrors.length, "Chrome says it can be installed", JSON.stringify(inst.installabilityErrors));
  check(await ev("ANDROID === true && PHONE === 'phone' && BROWSER === 'Chrome'"), "sees itself on Android");
  check(await ev("navigator.serviceWorker.ready.then((r) => !!r.active)"), "service worker running");
  check(await ev("document.querySelector('#call-where').textContent.includes('Android')"), "voice call label is Android's");
  await ev("Object.defineProperty(navigator, 'onLine', { get: () => false }); renderOfflineNotes(); 0");
  check(await ev("document.querySelector('#offline-notes').textContent.includes('This phone is offline')"), "offline note says phone, not iPhone");
  // Android listens one phrase at a time (continuous listening repeats words there).
  check(await ev(`(() => { let made; window.SpeechRecognition = window.webkitSpeechRecognition = function () { made = this; this.start = () => {}; this.stop = () => {}; this.abort = () => {}; };
    listen(() => {}).abort(); return made.continuous === false; })()`), "speech listens one phrase at a time");
  const shot = await S("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`${OUT}/android-home.png`, Buffer.from(shot.data, "base64"));
  check(!errors.length, "no script errors", errors.join(" | "));
} catch (e) { check(false, "ran to the end", e.message); }
finally { chrome.kill(); server.kill(); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

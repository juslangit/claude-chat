// How full Claude's memory is in a chat, and compacting it from the phone.
// Most of the counting is checked with transcript fixtures, so it doesn't depend on how much a real
// conversation happens to use; one real /compact runs at the end.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.CLAUDE_CHAT_APP || path.resolve(HERE, "../..");
const WORK = process.env.CLAUDE_CHAT_WORK || path.join(HERE, ".work");
fs.mkdirSync(WORK, { recursive: true });

const W = APP;
const D = path.join(WORK, "t-context");
const SHOTS = path.join(WORK, "shots-context");
const PORT = 4479, CDP = 9341;
const TMUX = "/opt/homebrew/bin/tmux";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`); };
fs.mkdirSync(D, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

let server;
function startServer() {
  const out = fs.openSync(path.join(D, "server.log"), "a");
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: W, stdio: ["ignore", out, out],
    env: { ...process.env, CLAUDE_CHAT_COMPUTER: "Test (4479)", CLAUDE_CHAT_DATA: D, CLAUDE_CHAT_SOCKET: "claude-chat-ctx",
      PORT: String(PORT), ANTHROPIC_MODEL: "claude-haiku-4-5", CLAUDE_CHAT_ENV_FILE: path.join(D, "env") },
  });
}
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method,
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => { let j; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on("error", reject);
    r.setTimeout(180000, () => r.destroy(new Error("timeout")));
    if (data) r.write(data);
    r.end();
  });
}
const waitUp = async () => { for (let i = 0; i < 80; i++) { try { await req("GET", "/api/whoami"); return true; } catch {} await sleep(250); } return false; };

let chrome, A, B;
try {
  startServer();
  check("server starts", await waitUp());
  A = (await req("POST", "/api/chats", { body: { name: "long one", terminal: false } })).json;
  B = (await req("POST", "/api/chats", { body: { name: "fresh one", terminal: false } })).json;
  const one = async (id) => ((await req("GET", "/api/chats")).json || []).find((c) => c.id === id);
  const waitFor = async (id, want, ms) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = (await one(id))?.status; if (want(s)) return s; await sleep(400); } return s; };
  check("chats reach online", (await waitFor(A.id, (s) => s === "idle", 60000)) === "idle" && (await waitFor(B.id, (s) => s === "idle", 60000)) === "idle");

  // fixtures: an answer that used this much of Claude's memory
  const transcript = path.join(process.env.HOME, ".claude/projects",
    path.join(process.env.HOME, "Desktop/project").replace(/[^a-zA-Z0-9]/g, "-"), `${A.id}.jsonl`);
  const used = async (tokens, text) => {
    fs.appendFileSync(transcript, `${JSON.stringify({
      type: "assistant", uuid: `ctx-${tokens}-${Date.now()}`, timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text }], usage: { input_tokens: 1000, cache_read_input_tokens: tokens - 1000 } },
    })}\n`);
    await sleep(1200);
    return (await one(A.id))?.context;
  };

  const half = await used(120000, "Half way through.");
  check("the chat says how full Claude's memory is", half?.used === 120000 && half.limit === 200000, JSON.stringify(half));
  check("a chat that's said nothing yet is at zero", (await one(B.id))?.context?.used === 0);

  // ── the phone ──
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(WORK, `chrome-ctx-${Date.now()}`)}`,
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
  const until = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr).catch(() => false)) return true; await sleep(300); } return false; };
  const bar = () => js(`(() => { const b = document.querySelector("#context-bar"); return { hidden: b.hidden, text: document.querySelector("#context-text").textContent,
    width: document.querySelector("#context-fill").style.width, warm: b.classList.contains("warm"), hot: b.classList.contains("hot") }; })()`);
  const shot = async (name) => { await sleep(300); const { data } = await S("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64")); };

  await S("Page.navigate", { url: `http://127.0.0.1:${PORT}/#chat/home/${A.id}` });
  check("phone page connects", await until("home.online === true", 10000));
  const at60 = await bar();
  check("the bar shows once a chat is half full", !at60.hidden && at60.width === "60%" && /60% full/.test(at60.text), JSON.stringify(at60));
  check("…and it's calm at 60%", !at60.warm && !at60.hot);
  await shot("1-sixty");

  await used(150000, "Getting long now.");
  check("it turns orange past 70%", await until(`document.querySelector("#context-bar").classList.contains("warm")`, 5000) && (await bar()).width === "75%");
  await shot("2-seventy-five");
  await used(190000, "Nearly full.");
  check("…and red past 90%", await until(`document.querySelector("#context-bar").classList.contains("hot")`, 5000) && (await bar()).width === "95%");
  await shot("3-ninety-five");

  await js(`go("chat/home/${B.id}"); true`);
  await sleep(900);
  check("a fresh chat shows no bar at all", (await bar()).hidden);

  // ── compacting for real, from the phone ──
  await js(`go("chat/home/${A.id}"); window.confirm = () => true; true`);
  await sleep(800);
  await js(`document.querySelector("#context-bar").click(); true`);
  check("tapping it compacts, and the answer comes back as a card", await until(`[...document.querySelectorAll("#messages .bubble.command b")].some((b) => b.textContent === "/compact")`, 180000));
  check("no errors in the page", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("test run finished without crashing", false, e.stack);
} finally {
  for (const x of [A, B]) if (x?.id) await req("DELETE", `/api/chats/${x.id}`).catch(() => {});
  await sleep(400);
  server?.kill();
  chrome?.kill();
  try { execFileSync(TMUX, ["-L", "claude-chat-ctx", "kill-server"], { stdio: "ignore" }); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(0);
}

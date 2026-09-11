// Screenshots of the redesigned phone app, filled with lifelike sample chats (no Claude turns needed).
//   node shots-ui.mjs [worktree] [out dir]
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
const OUT = process.argv[3] || `${WORK}/shots-ui`;
const D = `${WORK}/t-ui`;
const PORT = 4479, CDP = 9338;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(D, { recursive: true });

const out = fs.openSync(`${D}/server.log`, "a");
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: W, stdio: ["ignore", out, out],
  env: { ...process.env, CLAUDE_CHAT_COMPUTER: "Luqman’s MacBook Air", CLAUDE_CHAT_DATA: D, CLAUDE_CHAT_SOCKET: "claude-chat-ui",
    PORT: String(PORT), CLAUDE_CHAT_ENV_FILE: `${D}/env` },
});
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORK}/.chrome-ui-${Date.now()}`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

const SAMPLE = `(() => {
  const now = Date.now();
  home.name = "Luqman’s MacBook Air";
  const mk = (id, name, extra) => ({ id, name, createdAt: now - 36e5, alive: true, project: null,
    status: "idle", lastText: "", lastAt: now - 12e4, count: 3, note: null, pending: null, ...extra });
  onEvent({ type: "chat", chat: mk("a1", "claude-chat", { lastText: "Both computers are on the new version now.", count: 6, lastAt: now - 9e4 }) });
  onEvent({ type: "chat", chat: mk("a2", "referee-for-fun", { status: "working", note: "Rebuilding the badminton arena lighting so the shuttle reads against the crowd.", lastAt: now - 6e4, project: "referee-for-fun" }) });
  onEvent({ type: "chat", chat: mk("a4", "print-quote", { status: "approval", lastAt: now - 3e5, project: "print-quote",
    pending: { reqId: "r1", tool: "Bash", detail: "npm run deploy -- --prod", why: "Publish the quote page", questions: null } }) });
  onEvent({ type: "chat", chat: mk("a3", "kedai-runtuh", { lastText: "You: add a new shelf sprite for the drinks", lastAt: now - 36e5, project: "kedai-runtuh" }) });
  onEvent({ type: "chat", chat: mk("a5", "sky", { status: "ended", lastText: "Session finished.", lastAt: now - 9e6, count: 2 }) });
  state.seen = { a1: 4, a2: 3, a3: 3, a4: 3, a5: 2 };
  if (!state.computers.some((c) => c.id === "pc")) {
    state.computers.push({ id: "pc", base: "", name: "DESKTOP-K2M7L30", os: "windows", online: false, offlineSince: now - 52e5 });
  }
  state.pinned = ["home/a1"];
  renderList(); renderComputers();
  return true;
})()`;

const MESSAGES = `(() => {
  const now = Date.now();
  const msgs = [
    { id: "m1", role: "user", text: "Can you check why the Mac dropped off tonight?", at: now - 9e5 },
    { id: "m2", role: "tool", text: "Read tailscaled.log", detail: "~/Library/Application Support/tailscale-user/tailscaled.log", at: now - 88e4 },
    { id: "m3", role: "tool", text: "Looked for sleep events", detail: "pmset -g log | grep -E 'Sleep|Wake'", at: now - 87e4 },
    { id: "m4", role: "assistant", text: "Found it. At **19:43** the Wi-Fi dropped completely — \`all links down\` — and came back at 20:21 on a different network. Not the app.", at: now - 86e4 },
    { id: "m5", role: "user", text: 'Replying to your message: "Found it. At 19:43 the Wi-Fi dropped completely and came back at 20:21 on a different network."\\n\\nok, show that on the phone then', at: now - 60e4 },
    { id: "m6", role: "command", command: "/usage", asks: false, at: now - 40e4,
      text: "Settings  Status   Config   Usage   Stats\\n\\nCurrent week (all models)\\nResets Sep 13 at 11:59pm\\n\\n86% of your usage was at >150k context" },
    { id: "m7", role: "assistant", text: "Done — the chat list now says “offline since 19:43”, and the phone notices within a minute.", at: now - 20e4 },
  ];
  state.messages.set("home/a1", msgs);
  resetGroups();
  document.querySelector("#messages").innerHTML = "";
  addMessages(msgs);
  markAllRead();
  scrollDown();
  return true;
})()`;

try {
  for (let i = 0; i < 80; i++) { try { await new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}/api/whoami`, res).on("error", rej)); break; } catch { await sleep(250); } }
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
  const shot = async (name) => { await sleep(400); const { data } = await S("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64")); console.log(name); };

  for (const dark of [true, false]) {
    const tag = dark ? "dark" : "light";
    await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: dark ? "dark" : "light" }] });
    await S("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    await sleep(1600);
    await js(SAMPLE);
    await sleep(400);
    await shot(`${tag}-1-home`);
    await js(`go("chats"); true`);
    await sleep(500);
    await shot(`${tag}-2-chats`);
    await js(`go("chat/home/a1"); true`);
    await sleep(700);
    await js(MESSAGES);
    await shot(`${tag}-3-chat`);
    if (dark) {
      await js(`document.querySelector("#commands-btn").click(); true`);
      await sleep(500);
      await shot(`${tag}-4-commands`);
      await js(`closeSheets(); document.querySelector("#chat-head").click(); true`);
      await sleep(400);
      await shot(`${tag}-5-chat-info`);
      await js(`closeSheets(); document.querySelector("#screen-btn").click(); document.querySelector("#screen-text").textContent = "  Select model\\n  Switch between Claude models.\\n\\n   1. Default (recommended)  Sonnet 5\\n   2. Sonnet                 Sonnet 5\\n   3. Fable                  Fable 5.1\\n   4. Opus                   Opus 5\\n   5. Haiku                  Haiku 4.5\\n ❯ 6. Haiku 4.5 ✔            Fastest\\n\\n Enter to set as default · Esc to cancel"; true`);
      await sleep(400);
      await shot(`${tag}-6-screen`);
      await js(`closeSheets(); go("computers"); true`);
      await sleep(500);
      await shot(`${tag}-7-computers`);
      await js(`go("settings"); true`);
      await sleep(400);
      await shot(`${tag}-8-settings`);
      await js(`go("chat/home/a4"); true`);
      await sleep(700);
      await shot(`${tag}-9-approval`);
      await js(`(() => { const c = state.chats.get("home/a1"); startCall(); document.querySelector("#call-heard").textContent = "can you check the windows pc as well"; document.querySelector("#call-said").textContent = "Yes — the PC is online and running the same version."; setCallMode("listening", "Listening…"); return true; })()`);
      await sleep(500);
      await shot(`${tag}-10-call`);
      await js(`endCall(); go("home"); true`);
    }
  }
  console.log(errors.length ? `\npage errors:\n${errors.join("\n")}` : "\nno page errors");
} catch (e) {
  console.log("failed:", e.stack);
} finally {
  server.kill();
  chrome.kill();
  try { execFileSync("/opt/homebrew/bin/tmux", ["-L", "claude-chat-ui", "kill-server"], { stdio: "ignore" }); } catch {}
  process.exit(0);
}

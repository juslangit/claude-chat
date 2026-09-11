// End-to-end checks for claude-chat's feat/commands, against a test copy on :4479 (Haiku, own data
// folder, own tmux server, own .env). Nothing here touches the live app or the real ~/.claude.
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
const D = `${WORK}/t-cmd2`;
const PROJECTS = `${WORK}/t-projects`;
const SHOTS = `${WORK}/shots3`;
const PORT = 4479, CDP = 9336;
const TMUX = "/opt/homebrew/bin/tmux";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`);
};

fs.mkdirSync(D, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
// a pretend project with a command of its own, to check the app lists those too
fs.mkdirSync(`${PROJECTS}/demo/.claude/commands`, { recursive: true });
fs.writeFileSync(`${PROJECTS}/demo/.claude/commands/deploy.md`, `---\ndescription: Put the site live\n---\nDeploy it.\n`);

let server;
function startServer(extra = {}) {
  const out = fs.openSync(`${D}/server.log`, "a");
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: W, stdio: ["ignore", out, out],
    env: { ...process.env, CLAUDE_CHAT_COMPUTER: "Test (4479)", CLAUDE_CHAT_DATA: D, CLAUDE_CHAT_SOCKET: "claude-chat-cmd",
      PORT: String(PORT), ANTHROPIC_MODEL: "claude-haiku-4-5", CLAUDE_CHAT_ENV_FILE: `${D}/env`, ...extra },
  });
}
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method,
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
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
const stopServer = async () => { server?.kill(); await sleep(800); };

let chrome, c, demo;
try {
  // ── 1. commands through the API ──
  startServer();
  check("server starts", await waitUp());
  c = (await req("POST", "/api/chats", { name: "commands", terminal: false })).json;
  const status = async () => (await req("GET", "/api/chats")).json.find((x) => x.id === c.id)?.status;
  const waitFor = async (want, ms) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await status(); if (want(s)) return s; await sleep(400); } return s; };
  const screen = async () => (await req("GET", `/api/chats/${c.id}/screen`)).json?.text || "";
  const command = (text) => req("POST", `/api/chats/${c.id}/command`, { command: text });
  check("chat reaches online", (await waitFor((s) => s === "idle", 60000)) === "idle");

  const usage = (await command("/usage")).json;
  check("/usage comes back as a card", usage?.role === "command" && usage.command === "/usage" && usage.text.length > 40, JSON.stringify(usage?.text || "").slice(0, 90));
  check("…that says what it's about", /limit|usage/i.test(usage?.text || ""));
  check("…and isn't waiting for an answer", usage?.asks === false);
  check("…with none of the Terminal's own furniture, and no wasted margin",
    !/^[▔▝▘▗▖█─\s]/.test(usage?.text || "x") && !/^[▔▁─━═▬█]+$/m.test(usage?.text || "x"), JSON.stringify((usage?.text || "").slice(0, 60)));
  check("the panel was closed afterwards, so the chat still works", /❯/.test(await screen()));

  const stat = (await command("/status")).json;
  check("/status comes back as a card", /Version:|Session ID|Model:/.test(stat?.text || ""), (stat?.text || "").slice(0, 60).replace(/\n/g, " "));

  const model = (await command("/model")).json;
  check("/model is marked as needing your answer", model?.asks === true, JSON.stringify(model?.text || "").slice(0, 80));
  check("…and its menu is still on screen", /Select model|Esc to cancel/.test(await screen()));
  await req("POST", `/api/chats/${c.id}/key`, { key: "esc" });
  await sleep(800);
  check("Esc from the phone closes the menu", /❯/.test(await screen()));

  check("something that isn't a command is refused", (await command("usage")).status === 400);
  check("the cards are kept in the chat", ((await req("GET", `/api/chats/${c.id}/messages`)).json || []).filter((m) => m.role === "command").length === 3);

  const after = await req("POST", `/api/chats/${c.id}/send`, { text: "Reply with just the word: fine" });
  check("a normal message still works after all that", after.status === 200);
  await waitFor((s) => s === "working", 20000);
  await waitFor((s) => s === "idle", 120000);
  await sleep(1200);
  const said = ((await req("GET", `/api/chats/${c.id}/messages`)).json || []).filter((m) => m.role === "assistant").at(-1)?.text || "";
  check("…and Claude answered it", /fine/i.test(said), said.slice(0, 40));

  check("no commands of your own yet", Array.isArray((await req("GET", "/api/commands")).json) && (await req("GET", "/api/commands")).json.length === 0);

  // ── 2. a project with a command of its own ──
  await req("DELETE", `/api/chats/${c.id}`);
  c = null;
  await stopServer();
  startServer({ CLAUDE_CHAT_WORKDIR: PROJECTS });
  await waitUp();
  demo = (await req("POST", "/api/chats", { project: "demo", terminal: false })).json;
  await sleep(1500);
  const mine = (await req("GET", `/api/commands?chat=${demo.id}`)).json;
  check("a project's own command is listed, with its description", mine?.[0]?.name === "/deploy" && mine[0].about === "Put the site live" && mine[0].where === "this project", JSON.stringify(mine));
  await req("DELETE", `/api/chats/${demo.id}`);
  demo = null;

  // a chat ended a moment before the server stops must stay ended
  const brief = (await req("POST", "/api/chats", { name: "briefly", terminal: false })).json;
  await sleep(1500);
  await req("DELETE", `/api/chats/${brief.id}`);
  await stopServer(); // straight away, before the 200 ms save would have fired by itself
  startServer({ CLAUDE_CHAT_WORKDIR: PROJECTS });
  await waitUp();
  check("a chat ended just before the server stops stays gone", !((await req("GET", "/api/chats")).json || []).some((x) => x.id === brief.id));
  await stopServer();

  // ── 3. the phone page ──
  startServer();
  await waitUp();
  c = (await req("POST", "/api/chats", { name: "commands", terminal: false })).json;
  await waitFor((s) => s === "idle", 60000);

  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORK}/.chrome-e2e3`,
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
  const shot = async (name) => { await sleep(350); const { data } = await S("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${SHOTS}/${name}.png`, Buffer.from(data, "base64")); };
  const until = async (expr, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await js(expr).catch(() => false)) return true; await sleep(300); } return false; };
  const tap = (cmd) => js(`[...document.querySelectorAll("#command-list .command-run")].find((b) => b.dataset.command === ${JSON.stringify(cmd)}).click(); true`);

  await S("Page.navigate", { url: `http://127.0.0.1:${PORT}/#chat/home/${c.id}` });
  check("phone page connects", await until("home.online === true", 10000));
  await js(`document.querySelector("#commands-btn").click(); true`);
  check("the ⌘ button opens the commands sheet", await until(`!document.querySelector("#commands").hidden && document.querySelectorAll("#command-list .command-run").length >= 12`, 5000));
  check("risky ones are marked", await js(`!!document.querySelector('.command-run[data-command="/clear"] .command-warn')`));
  await shot("commands-sheet");
  await js(`document.querySelector("#command-search").value = "mod"; renderCommands(); true`);
  check("search finds /model", await js(`document.querySelectorAll("#command-list .command-run").length >= 1 && !!document.querySelector('.command-run[data-command="/model"]')`));
  await js(`document.querySelector("#command-search").value = "zzz"; renderCommands(); true`);
  check("an unknown one can still be sent by hand", await js(`!!document.querySelector('.command-run[data-command="/zzz"]')`));
  await js(`document.querySelector("#command-search").value = ""; renderCommands(); true`);

  await tap("/usage");
  check("tapping /usage puts a card in the chat", await until(`[...document.querySelectorAll("#messages .bubble.command b")].some((b) => b.textContent === "/usage")`, 30000));
  check("the sheet closed itself", await js(`document.querySelector("#commands").hidden`));
  await shot("command-card");

  await js(`document.querySelector("#commands-btn").click(); true`);
  await sleep(400);
  await tap("/model");
  check("a menu command opens the screen by itself", await until(`!document.querySelector("#screen").hidden && /Select model/.test(document.querySelector("#screen-text").textContent)`, 30000));
  check("the screen offers keys 1 to 9", await js(`[...document.querySelectorAll("#screen .keys button")].filter((b) => /^[1-9]$/.test(b.dataset.key)).length === 9`));
  await shot("screen-keys");
  await js(`[...document.querySelectorAll("#screen .keys button")].find((b) => b.dataset.key === "esc").click(); true`);
  await sleep(1200);
  check("Esc on the screen closes the menu", await until(`/❯/.test(document.querySelector("#screen-text").textContent)`, 8000));
  await js(`closeSheets(); true`);

  // the risky ones ask first
  await js(`window.confirm = () => false; document.querySelector("#commands-btn").click(); true`);
  await sleep(400);
  const cardsBefore = await js(`document.querySelectorAll("#messages .bubble.command").length`);
  await tap("/clear");
  await sleep(2500);
  check("saying no to /clear does nothing", await js(`document.querySelectorAll("#messages .bubble.command").length === ${cardsBefore}`));
  await js(`window.confirm = () => true; document.querySelector("#commands-btn").click(); true`);
  await sleep(400);
  await tap("/clear");
  check("saying yes to /clear starts a fresh conversation", await until(`[...document.querySelectorAll("#messages .system")].some((s) => /cleared|New session/i.test(s.textContent))`, 30000), await js(`[...document.querySelectorAll("#messages .system")].map((s) => s.textContent).join(" | ")`));
  check("no errors in the page", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("test run finished without crashing", false, e.stack);
} finally {
  for (const x of [c, demo]) if (x?.id) await req("DELETE", `/api/chats/${x.id}`).catch(() => {});
  server?.kill();
  chrome?.kill();
  try { execFileSync(TMUX, ["-L", "claude-chat-cmd", "kill-server"], { stdio: "ignore" }); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(0);
}

// Which Claude account a chat runs as: reading the signed-in one, adding a second, switching
// between them, and the token actually reaching the chat's tmux session.
// No real second account is signed in here — one is written straight into a scratch .env instead,
// so nothing touches ~/.claude/.env and no real token is ever needed.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { planName, addAccount, addedAccounts, removeAccount, tokenFor } from "../../accounts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.CLAUDE_CHAT_APP || path.resolve(HERE, "../..");
const WORK = process.env.CLAUDE_CHAT_WORK || path.join(HERE, ".work");
const D = path.join(WORK, "t-accounts");
const SHOTS = path.join(WORK, "shots-accounts");
const ENV = path.join(D, "env");
const PORT = 4479, CDP = 9343;
const TMUX = "/opt/homebrew/bin/tmux";
const SOCKET = "claude-chat-acct";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`); };
fs.rmSync(D, { recursive: true, force: true });
fs.mkdirSync(D, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

let server;
function startServer() {
  const out = fs.openSync(path.join(D, "server.log"), "a");
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: APP, stdio: ["ignore", out, out],
    env: { ...process.env, CLAUDE_CHAT_COMPUTER: "Test (4479)", CLAUDE_CHAT_DATA: D, CLAUDE_CHAT_SOCKET: SOCKET,
      PORT: String(PORT), ANTHROPIC_MODEL: "claude-haiku-4-5", CLAUDE_CHAT_ENV_FILE: ENV,
      BROWSER: "true" }, // best effort at keeping the sign-in check from opening a real browser tab
  });
}
function req(method, p, { body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method,
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
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

let chrome, chat;
try {
  // ── reading a plan out of what Anthropic calls a subscription ──
  check("claude_pro reads as Pro", planName("claude_pro", "default_claude_ai") === "Pro");
  check("claude_max reads as Max", planName("claude_max", null) === "Max");
  check("the 20× tier says so", planName("claude_max", "default_claude_max_20x") === "Max 20×");
  check("the 5× tier says so", planName("claude_max", "default_claude_max_5x") === "Max 5×");
  check("anything else stays blank", planName(null, null) === null);

  // ── an account is four lines in the key file, and nothing else in it is disturbed ──
  fs.writeFileSync(ENV, "SOMETHING_ELSE=keep-me\nCLAUDE_CHAT_VAPID_PUBLIC=abc\n", { mode: 0o600 });
  const id = addAccount(ENV, { label: "Max account", plan: "Max", email: "other@example.com", token: "sk-ant-oat01-pretend" });
  check("adding an account names it after its label", id === "MAX_ACCOUNT", id);
  const listed = addedAccounts(ENV);
  check("it reads back with its label, plan and email",
    listed.length === 1 && listed[0].label === "Max account" && listed[0].plan === "Max" && listed[0].email === "other@example.com",
    JSON.stringify(listed));
  check("its token comes back for that account only",
    tokenFor(ENV, id) === "sk-ant-oat01-pretend" && tokenFor(ENV, "signed-in") === null);
  check("the other keys in the file are untouched", fs.readFileSync(ENV, "utf8").includes("SOMETHING_ELSE=keep-me"));
  const second = addAccount(ENV, { label: "Max account", plan: "Max", token: "sk-ant-oat01-two" });
  check("a second account with the same name gets its own slug", second === "MAX_ACCOUNT_2" && addedAccounts(ENV).length === 2, second);
  removeAccount(ENV, second);
  check("removing one leaves the other", addedAccounts(ENV).length === 1 && tokenFor(ENV, id) === "sk-ant-oat01-pretend");
  check("…and still leaves the rest of the file alone", fs.readFileSync(ENV, "utf8").includes("CLAUDE_CHAT_VAPID_PUBLIC=abc"));

  // ── the server ──
  startServer();
  check("server starts", await waitUp());
  let acc = (await req("GET", "/api/accounts")).json;
  check("it lists the account this computer is signed in to", acc.accounts.some((a) => a.signedIn), JSON.stringify(acc.accounts.map((a) => a.label)));
  check("the signed-in one says which plan it is", !!acc.accounts.find((a) => a.signedIn)?.plan, acc.accounts.find((a) => a.signedIn)?.plan);
  check("the added account is listed too", acc.accounts.some((a) => a.id === id && a.plan === "Max"));
  check("the signed-in one is used until told otherwise", acc.current === "signed-in", acc.current);

  const used = (await req("POST", "/api/accounts/use", { body: { id } })).json;
  check("switching accounts takes", used.current === id, used.current);
  check("…and is remembered on the computer, not just the phone",
    JSON.parse(fs.readFileSync(path.join(D, "accounts.json"), "utf8")).current === id);
  check("an account that isn't there is refused", (await req("POST", "/api/accounts/use", { body: { id: "NOPE" } })).status === 400);

  // ── the token reaches the chat ──
  chat = (await req("POST", "/api/chats", { body: { name: "on the other account", terminal: false } })).json;
  await sleep(1500);
  const env = execFileSync(TMUX, ["-L", SOCKET, "show-environment", "-t", `cc-${chat.id.slice(0, 8)}`], { encoding: "utf8" });
  check("a new chat starts with that account's token", env.includes("CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-pretend"));
  const summary = ((await req("GET", "/api/chats")).json || []).find((c) => c.id === chat.id);
  check("the chat says which account it is on", summary?.account === "Max account", summary?.account);

  // Taking the account away must not leave the computer pointing at a token that no longer exists.
  await req("POST", "/api/accounts/remove", { body: { id } });
  acc = (await req("GET", "/api/accounts")).json;
  check("removing the account in use falls back to the signed-in one", acc.current === "signed-in" && !acc.accounts.some((a) => a.id === id));
  check("the signed-in account can't be removed", (await req("POST", "/api/accounts/remove", { body: { id: "signed-in" } })).status === 400);

  // ── adding one from the phone ──
  check("an account with no name is refused", (await req("POST", "/api/accounts/add", { body: { label: "  " } })).status === 400);
  check("a code that isn't a code is refused", (await req("POST", "/api/accounts/code", { body: { code: "no spaces allowed here" } })).status === 400);
  const adding = (await req("POST", "/api/accounts/add", { body: { label: "Second account", plan: "Max" } })).json;
  check("asking to add one starts the sign-in", adding.adding === true, JSON.stringify(adding));
  let link = null;
  for (let i = 0; i < 40 && !link; i++) { await sleep(1000); link = (await req("GET", "/api/accounts")).json?.url; }
  check("a sign-in link comes back for the phone to open", /^https:\/\/claude\.com\/.*oauth/.test(link || ""), link ? `${link.slice(0, 46)}…` : "none");
  await req("POST", "/api/accounts/cancel");
  check("cancelling stops it", (await req("GET", "/api/accounts")).json?.adding !== true);

  // ── the phone ──
  addAccount(ENV, { label: "Max account", plan: "Max", email: "other@example.com", token: "sk-ant-oat01-pretend" });
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(WORK, `chrome-acct-${Date.now()}`)}`,
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
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++seq; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
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
  const shot = async (name) => { await sleep(400); const { data } = await S("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, "base64")); };

  await S("Page.navigate", { url: `http://127.0.0.1:${PORT}/#settings` });
  check("phone page connects", await until("home.online === true", 10000));
  check("Settings wears the account's face on the right of the bar",
    await until(`document.querySelector("#profile-btn .avatar")?.textContent?.trim().length === 1`, 8000),
    await js(`document.querySelector("#profile-btn .avatar")?.textContent`));
  await shot("1-settings");

  await js(`document.querySelector("#profile-btn").click(); true`);
  check("tapping it opens the account sheet", await until(`!document.querySelector("#profile-sheet").hidden`, 3000));
  check("it says Pro or Max for the account in use",
    await until(`/^Claude (Pro|Max)/.test(document.querySelector(".plan-chip")?.textContent || "")`, 5000),
    await js(`document.querySelector(".plan-chip")?.textContent`));
  check("both accounts are listed", (await js(`document.querySelectorAll("#profile-list .account-row").length`)) === 2);
  check("the one in use has the tick", (await js(`document.querySelector("#profile-list .account-row .tick")?.closest(".account-row").dataset.account`)) === "signed-in");
  await shot("2-account");

  await js(`document.querySelector('.account-row[data-account="MAX_ACCOUNT"]').click(); true`);
  check("tapping the other account switches to it",
    await until(`document.querySelector("#profile-list .account-row .tick")?.closest(".account-row").dataset.account === "MAX_ACCOUNT"`, 5000));
  check("…and the computer agrees", (await req("GET", "/api/accounts")).json?.current === "MAX_ACCOUNT");
  check("the badge now says Max", /Max/.test(await js(`document.querySelector(".plan-chip").textContent`)));
  await shot("3-switched");

  await js(`document.querySelector("#profile-add").click(); true`);
  check("Add another account asks for a name and a plan",
    await until(`!document.querySelector("#profile-login").hidden && document.querySelectorAll("#login-plan .chip").length === 2`, 3000));
  await shot("4-adding");

  check("no errors in the page", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("test run finished without crashing", false, e.stack);
} finally {
  if (chat?.id) await req("DELETE", `/api/chats/${chat.id}`).catch(() => {});
  await sleep(400);
  server?.kill();
  chrome?.kill();
  try { execFileSync(TMUX, ["-L", SOCKET, "kill-server"], { stdio: "ignore" }); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(0);
}

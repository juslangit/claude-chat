// Files coming back the other way: `cchat send`, files Claude names in a reply, and what the phone
// shows for them. Runs against its own copy on :4479 — see dev/checks/run.mjs.
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
const D = path.join(WORK, "t-files");
const SHOTS = path.join(WORK, "shots-files");
const PORT = 4479, CDP = 9340;
const TMUX = "/opt/homebrew/bin/tmux";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`); };
fs.mkdirSync(D, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

// a small red PNG and a plain text file to send over
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAXklEQVR42u3PQREAAAgDINc/9Mzg" +
  "C0RgcrYKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
  "AAAAAAAAAAAAAAAAAAAAAAB4NnwCAAHc1DhaAAAAAElFTkSuQmCC", "base64");
const RENDER = path.join(D, "render.png");
const NOTES = path.join(D, "notes.txt");
fs.writeFileSync(RENDER, PNG);
fs.writeFileSync(NOTES, "shelf sprite notes\nthree drinks, one shelf\n");

let server;
function startServer() {
  const out = fs.openSync(path.join(D, "server.log"), "a");
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: W, stdio: ["ignore", out, out],
    env: { ...process.env, CLAUDE_CHAT_COMPUTER: "Test (4479)", CLAUDE_CHAT_DATA: D, CLAUDE_CHAT_SOCKET: "claude-chat-files",
      PORT: String(PORT), ANTHROPIC_MODEL: "claude-haiku-4-5", CLAUDE_CHAT_ENV_FILE: path.join(D, "env") },
  });
}
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method,
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const buf = Buffer.concat(chunks); let j; try { j = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, json: j, buf, type: res.headers["content-type"], disposition: res.headers["content-disposition"] }); });
    });
    r.on("error", reject);
    r.setTimeout(120000, () => r.destroy(new Error("timeout")));
    if (data) r.write(data);
    r.end();
  });
}
const waitUp = async () => { for (let i = 0; i < 80; i++) { try { await req("GET", "/api/whoami"); return true; } catch {} await sleep(250); } return false; };

let chrome, c;
try {
  startServer();
  check("server starts", await waitUp());
  c = (await req("POST", "/api/chats", { name: "files", terminal: false })).json;
  const status = async () => ((await req("GET", "/api/chats")).json || []).find((x) => x.id === c.id)?.status;
  const waitFor = async (want, ms) => { const end = Date.now() + ms; let s; while (Date.now() < end) { s = await status(); if (want(s)) return s; await sleep(400); } return s; };
  const messages = async () => (await req("GET", `/api/chats/${c.id}/messages`)).json || [];
  check("chat reaches online", (await waitFor((s) => s === "idle", 60000)) === "idle");

  // ── sending a file over ──
  const sent = (await req("POST", `/api/chats/${c.id}/share`, { path: RENDER, caption: "the shelf render" })).json;
  check("a file can be sent to the phone", sent?.role === "file" && sent.name === "render.png" && sent.kind === "image" && sent.size === PNG.length, JSON.stringify(sent));
  const got = await req("GET", `/api/chats/${c.id}/files/${sent.token}`);
  check("…and fetched back whole", got.status === 200 && got.type === "image/png" && got.buf.equals(PNG));
  check("…shown inline rather than downloaded", /^inline/.test(got.disposition || ""), got.disposition);
  check("it lands in the chat with its caption", (await messages()).some((m) => m.role === "file" && m.caption === "the shelf render"));

  const doc = (await req("POST", `/api/chats/${c.id}/share`, { path: NOTES })).json;
  check("a plain file goes as a file, not a picture", doc?.kind === "file" && doc.name === "notes.txt");
  const docGot = await req("GET", `/api/chats/${c.id}/files/${doc.token}`);
  check("…and comes back as a download", docGot.status === 200 && /^attachment/.test(docGot.disposition || ""));

  check("a file that isn't there is refused", (await req("POST", `/api/chats/${c.id}/share`, { path: path.join(D, "nope.png") })).status === 404);
  check("a folder is refused too", (await req("POST", `/api/chats/${c.id}/share`, { path: D })).status === 404);
  check("nothing else on the computer can be fetched", (await req("GET", `/api/chats/${c.id}/files/0123456789abcdef`)).status === 404);

  // ── cchat send, the way Claude will use it ──
  const out = execFileSync(path.join(W, "bin/cchat"), ["send", NOTES, "from the command line"], {
    encoding: "utf8", env: { ...process.env, CLAUDE_CHAT_ID: c.id, CLAUDE_CHAT_PORT: String(PORT) },
  });
  check("cchat send works from inside a chat", /Sent to the phone: notes\.txt/.test(out), out.trim());
  check("…and it arrives with its caption", (await messages()).some((m) => m.role === "file" && m.caption === "from the command line"));
  // Outside a chat it should say so plainly and exit with an error, which is what execFileSync throws on.
  let noChat = "", failed = false;
  try { execFileSync(path.join(W, "bin/cchat"), ["send", NOTES], { encoding: "utf8", env: { ...process.env, CLAUDE_CHAT_ID: "", CLAUDE_CHAT_PORT: String(PORT) } }); }
  catch (e) { failed = true; noChat = `${e.stdout || ""}`.trim(); }
  check("outside a chat it says so, and stops", failed && /Run this inside a chat/.test(noChat), noChat);

  // ── a file Claude simply mentions ──
  // Written straight into the transcript, so the check doesn't depend on how a model words its reply
  // (a real one abbreviated the path when this was first tried).
  const transcript = path.join(process.env.HOME, ".claude/projects",
    path.join(process.env.HOME, "Desktop/project").replace(/[^a-zA-Z0-9]/g, "-"), `${c.id}.jsonl`);
  const line = (text) => JSON.stringify({ type: "assistant", uuid: `named-${Date.now()}`, timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] } });
  fs.appendFileSync(transcript, `${line(`Rendered it — saved it to ${RENDER}`)}\n`);
  await sleep(1500);
  let said = (await messages()).filter((m) => m.role === "assistant").at(-1);
  check("a full path Claude names is picked up", said?.files?.[0]?.name === "render.png", JSON.stringify(said?.text || "").slice(0, 70));
  check("…and that one is fetchable too", said?.files?.[0] && (await req("GET", `/api/chats/${c.id}/files/${said.files[0].token}`)).status === 200);

  // the way Claude usually writes it: a path relative to the folder the chat is in
  fs.mkdirSync(path.join(process.env.HOME, "Desktop/project/claude-chat/dev/checks/.work/t-files"), { recursive: true });
  fs.copyFileSync(RENDER, path.join(process.env.HOME, "Desktop/project/claude-chat/dev/checks/.work/t-files/relative.png"));
  fs.appendFileSync(transcript, `${line("Put the new one in claude-chat/dev/checks/.work/t-files/relative.png — have a look.")}\n`);
  await sleep(1500);
  said = (await messages()).filter((m) => m.role === "assistant").at(-1);
  check("a path relative to the chat's folder is picked up too", said?.files?.[0]?.name === "relative.png", JSON.stringify(said?.files || []).slice(0, 80));

  // ── the phone ──
  chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${path.join(WORK, `chrome-files-${Date.now()}`)}`,
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

  await S("Page.navigate", { url: `http://127.0.0.1:${PORT}/#chat/home/${c.id}` });
  check("phone page connects", await until("home.online === true", 10000));
  check("the picture Claude sent is shown, not a path", await until(`[...document.querySelectorAll("#messages .bubble.file-msg img.photo")].some((i) => i.complete && i.naturalWidth > 0)`, 10000));
  check("the plain file is a card you can open", await js(`(() => { const a = document.querySelector("#messages .file-card"); return !!a && a.textContent.includes("notes.txt") && a.href.includes("/files/"); })()`));
  check("a file named in a reply shows under it", await until(`[...document.querySelectorAll("#messages .bubble.in:not(.file-msg) img.photo")].some((i) => i.complete && i.naturalWidth > 0)`, 8000));
  await sleep(400);
  const { data } = await S("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SHOTS, "files-in-a-chat.png"), Buffer.from(data, "base64"));
  check("no errors in the page", errors.length === 0, errors.join(" | "));
} catch (e) {
  check("test run finished without crashing", false, e.stack);
} finally {
  if (c?.id) await req("DELETE", `/api/chats/${c.id}`).catch(() => {});
  await sleep(400);
  server?.kill();
  chrome?.kill();
  try { execFileSync(TMUX, ["-L", "claude-chat-files", "kill-server"], { stdio: "ignore" }); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(0);
}

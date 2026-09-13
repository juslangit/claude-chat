// Checks for the New chat project list when projects are sorted into subject folders ("game", "3d"…),
// against a test copy on :4479 with its own data folder, tmux server and a made-up project folder.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.CLAUDE_CHAT_APP || path.resolve(HERE, "../..");
const WORK = process.env.CLAUDE_CHAT_WORK || path.join(HERE, ".work");
const D = `${WORK}/t-projects-data`;
const P = `${WORK}/t-subjects`;
const PORT = 4479;
const TMUX = "/opt/homebrew/bin/tmux";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`); };

// A project folder with a plain project, two subject folders, an empty new project, and a
// folder that holds a subfolder but is really a project (it has a file of its own).
fs.rmSync(P, { recursive: true, force: true });
fs.rmSync(D, { recursive: true, force: true });
for (const dir of ["flat-app/.git", "game/racer/.git", "game/chess", "3d/addon/src", "new-idea", "site/assets"]) fs.mkdirSync(`${P}/${dir}`, { recursive: true });
fs.writeFileSync(`${P}/game/chess/index.html`, "");
fs.writeFileSync(`${P}/site/index.html`, "");
fs.writeFileSync(`${P}/game/racer/.git/config`, `[remote "origin"]\n\turl = https://github.com/someone/racer.git\n`);
fs.writeFileSync(`${P}/game/.DS_Store`, "");
fs.mkdirSync(D, { recursive: true });

let server;
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
    if (data) r.write(data);
    r.end();
  });
}
const waitUp = async () => { for (let i = 0; i < 80; i++) { try { await req("GET", "/api/whoami"); return true; } catch {} await sleep(250); } return false; };

// What project cchat would ask for when run from a folder: a fake curl writes down what it was sent.
function cchatFrom(cwd) {
  const bin = `${WORK}/t-projects-bin`;
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(`${bin}/curl`, `#!/bin/bash\nwhile [ $# -gt 0 ]; do [ "$1" = -d ] && echo "$2" > "${bin}/sent"; shift; done\nexit 1\n`, { mode: 0o755 });
  fs.rmSync(`${bin}/sent`, { force: true });
  try { execFileSync(path.join(APP, "bin/cchat"), [], { cwd, stdio: "ignore", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CLAUDE_CHAT_WORKDIR: P } }); } catch {}
  try { return JSON.parse(fs.readFileSync(`${bin}/sent`, "utf8")).project; } catch { return "(nothing sent)"; }
}

const made = [];
try {
  const out = fs.openSync(`${D}/server.log`, "a");
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: APP, stdio: ["ignore", out, out],
    env: { ...process.env, CLAUDE_CHAT_COMPUTER: "Test (4479)", CLAUDE_CHAT_DATA: D, CLAUDE_CHAT_SOCKET: "claude-chat-proj",
      CLAUDE_CHAT_WORKDIR: P, PORT: String(PORT), ANTHROPIC_MODEL: "claude-haiku-4-5", CLAUDE_CHAT_ENV_FILE: `${D}/env` },
  });
  check("server starts", await waitUp());

  const names = ((await req("GET", "/api/projects")).json || []).map((p) => p.name).sort();
  check("New chat lists projects inside subject folders as subject/project",
    JSON.stringify(names) === JSON.stringify(["3d/addon", "flat-app", "game/chess", "game/racer", "new-idea", "site"]), names.join(", "));
  const racer = ((await req("GET", "/api/projects")).json || []).find((p) => p.name === "game/racer");
  check("…and still reads a nested project's GitHub address", racer?.remote === "https://github.com/someone/racer.git");

  const chat = (await req("POST", "/api/chats", { terminal: false, project: "game/racer" })).json;
  if (chat?.id) made.push(chat.id);
  check("a chat can start in a project inside a subject folder", chat?.project === "game/racer", JSON.stringify(chat)?.slice(0, 120));
  const listed = ((await req("GET", "/api/chats")).json || []).find((c) => c.id === chat?.id);
  check("…and the chat list names it the same way, so New chat counts it as open", listed?.project === "game/racer");
  const flat = (await req("POST", "/api/chats", { terminal: false, project: "flat-app" })).json;
  if (flat?.id) made.push(flat.id);
  check("a project not in a subject folder still works", flat?.project === "flat-app");

  for (const bad of ["game", "game/../flat-app", "../t-projects-data", "game/missing", "3d/addon/src"]) {
    const r = await req("POST", "/api/chats", { terminal: false, project: bad });
    if (r.json?.id) made.push(r.json.id);
    check(`refuses "${bad}"`, r.status >= 400, `status ${r.status}`);
  }

  check("cchat inside a nested project picks subject/project", cchatFrom(`${P}/game/chess`) === "game/chess");
  check("…also from deeper inside it", cchatFrom(`${P}/3d/addon/src`) === "3d/addon");
  check("cchat in a plain project picks just its name", cchatFrom(`${P}/site/assets`) === "site");
  check("cchat in a subject folder itself uses the whole project folder", cchatFrom(`${P}/game`) === null);
} catch (e) {
  check("test run finished without crashing", false, e.stack);
} finally {
  for (const id of made) await req("DELETE", `/api/chats/${id}`).catch(() => {});
  await sleep(400);
  server?.kill();
  try { execFileSync(TMUX, ["-L", "claude-chat-proj", "kill-server"], { stdio: "ignore" }); } catch {}
  console.log(`\n${results.filter(Boolean).length}/${results.length} passed`);
  process.exit(0);
}

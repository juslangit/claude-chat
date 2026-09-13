// A new person's computer, and the setup scripts that make one.
//
//   1. The server, run with a pretend home folder: chats follow that computer's own permission mode
//      (acceptEdits when none is set), Sky AI Brain is only mentioned where its `mem` tool is, the
//      first computer to be paired with starts sharing its Claude setup, and nothing Claude reads
//      says "Luqman".
//   2. setup/mac.sh and setup/wsl.sh, run for real in a sandbox — a pretend home folder, and pretend
//      brew, curl, git, gh, tailscale, syncthing, launchctl and sudo that only write down what they
//      were asked to do. So nothing is installed and nothing on this Mac changes.
// Claude never answers here: `claude` itself is a pretend one that writes down how it was started.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.CLAUDE_CHAT_APP || path.resolve(HERE, "../..");
const WORK = process.env.CLAUDE_CHAT_WORK || path.join(HERE, ".work");
const D = path.join(WORK, "t-setup");
const PORT = 4479;
const TMUX = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"].find((p) => fs.existsSync(p));
const SOCKET = "claude-chat-setup";
const REPO = "https://github.com/juslangit/claude-chat.git";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = "") => { results.push(!!ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  — ${extra}` : ""}`); };
fs.rmSync(D, { recursive: true, force: true });

// A small shell script, made executable.
const script = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `#!/bin/bash\n${body}`, { mode: 0o755 }); };
const read = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
// The environment this suite is run from may itself be a claude-chat chat; none of that may leak in.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CHAT_|CLAUDE_CODE_DISABLE_AUTO_MEMORY$|TMUX$)/.test(k)));

// A pretend Syncthing that keeps its lists in plain files next to it and writes down every call.
function pretendSyncthing(dir) {
  script(path.join(dir, "syncthing"), `
S="$(dirname "$0")/syncthing-state"; mkdir -p "$S"; touch "$S/folders" "$S/devices" "$S/folder-devices"
echo "syncthing $*" >> "$(dirname "$0")/calls.log"
case "$*" in
  "device-id") echo "NEWIDAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH" ;;
  "cli show system") echo "{}" ;;
  "cli config folders list") cat "$S/folders" ;;
  "cli config devices list") cat "$S/devices" ;;
  "cli config folders claude-home devices list") cat "$S/folder-devices" ;;
  "cli config folders add --id "*) echo "$6" >> "$S/folders" ;;
  "cli config devices add --device-id "*) echo "$6" >> "$S/devices" ;;
  "cli config folders claude-home devices add --device-id "*) echo "$8" >> "$S/folder-devices" ;;
esac
`);
}

// ── 1. the server, on a pretend fresh computer ──────────────────────────────────────────────

const HOME = path.join(D, "home");
const STUB = path.join(D, "stub");
const OUT = path.join(D, "claude-started");
fs.mkdirSync(path.join(HOME, "Desktop/project"), { recursive: true });
fs.mkdirSync(path.join(HOME, ".claude"), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
// The pretend claude writes down its arguments (one per line) and whether auto memory was switched off.
script(path.join(STUB, "claude"), `{ printf '%s\\n' "$@"; echo "AUTO_MEMORY_OFF=\${CLAUDE_CODE_DISABLE_AUTO_MEMORY:-no}"; } > "${OUT}/$CLAUDE_CHAT_ID.txt"\nsleep 300\n`);
pretendSyncthing(STUB);

let server;
function startServer() {
  const out = fs.openSync(path.join(D, "server.log"), "a");
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: APP, stdio: ["ignore", out, out],
    env: { ...cleanEnv(), HOME, PORT: String(PORT), CLAUDE_CHAT_DATA: path.join(D, "data"), CLAUDE_CHAT_SOCKET: SOCKET,
      CLAUDE_CHAT_COMPUTER: "New person's Mac", CLAUDE_CHAT_WORKDIR: path.join(HOME, "Desktop/project"),
      CLAUDE_BIN: path.join(STUB, "claude"), SYNCTHING_BIN: path.join(STUB, "syncthing") },
  });
}
function req(method, p, { body, port = PORT } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: "127.0.0.1", port, path: p, method,
      headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => { let j; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
    });
    r.on("error", reject);
    r.setTimeout(30000, () => r.destroy(new Error("timeout")));
    if (data) r.write(data);
    r.end();
  });
}
const waitUp = async () => { for (let i = 0; i < 80; i++) { try { await req("GET", "/api/whoami"); return true; } catch {} await sleep(250); } return false; };

// Start a chat and read back how the pretend claude was started.
async function startedWith() {
  const r = await req("POST", "/api/chats", { body: { terminal: false } });
  const file = path.join(OUT, `${r.json?.id}.txt`);
  for (let i = 0; i < 40 && !read(file); i++) await sleep(250);
  const lines = read(file).split("\n");
  const after = (flag) => lines[lines.indexOf(flag) + 1];
  return { mode: after("--permission-mode"), note: after("--append-system-prompt") || "", memoryOff: lines.includes("AUTO_MEMORY_OFF=1") };
}

try {
  startServer();
  check("the server starts on a computer with nothing set up", await waitUp());

  let s = await startedWith();
  check("with no permission mode set, chats ask before commands (acceptEdits)", s.mode === "acceptEdits", s.mode);
  check("without the mem tool, Claude Code's own memory stays on", !s.memoryOff);
  check("…and Claude isn't told about Sky AI Brain", s.note.includes("cchat send") && !/Sky AI Brain|mem remember/.test(s.note));

  fs.writeFileSync(path.join(HOME, ".claude/settings.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions", deny: ["Bash(sudo:*)"] } }));
  script(path.join(HOME, ".local/bin/mem"), "exit 0\n");
  s = await startedWith();
  check("with defaultMode set, chats use it — Luqman's bypassPermissions", s.mode === "bypassPermissions", s.mode);
  check("with the mem tool, Claude Code's own memory is switched off", s.memoryOff);
  check("…and Claude is told to save with mem remember", /mem remember/.test(s.note));

  fs.writeFileSync(path.join(HOME, ".claude/settings.json"), "{ not json");
  s = await startedWith();
  check("a settings file that can't be read falls back to acceptEdits", s.mode === "acceptEdits", s.mode);

  // ── the first computer to be paired with starts sharing ~/.claude ──
  const ID1 = "AAAAAAA-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
  const ID2 = "ZZZZZZZ-BBBBBBB-CCCCCCC-DDDDDDD-EEEEEEE-FFFFFFF-GGGGGGG-HHHHHHH";
  let code = (await req("POST", "/api/sync/code")).json?.code;
  const pair1 = await req("POST", "/api/sync/pair", { body: { id: ID1, name: "Second computer", code } });
  const state = (f) => read(path.join(STUB, "syncthing-state", f));
  check("pairing works on a computer that has never shared anything", pair1.status === 200 && pair1.json?.folder === "claude-home", pair1.text);
  check("…it starts sharing its Claude setup as claude-home", state("folders").trim() === "claude-home" &&
    read(path.join(STUB, "calls.log")).includes(`folders add --id claude-home --label Claude setup --path ${path.join(HOME, ".claude")}`));
  const ignore = read(path.join(HOME, ".claude/.stignore"));
  check("…only the parts in .stignore", ignore.includes("!/settings.json") && ignore.includes("!/.env") && ignore.trim().endsWith("*"));
  check("…and the new computer is let into it", state("folder-devices").includes(ID1) && state("devices").includes(ID1));
  code = (await req("POST", "/api/sync/code")).json?.code;
  await req("POST", "/api/sync/pair", { body: { id: ID2, name: "Third computer", code } });
  check("a second pairing reuses the folder instead of adding it again",
    read(path.join(STUB, "calls.log")).split("\n").filter((l) => l.includes("folders add --id")).length === 1 && state("folder-devices").includes(ID2));
  fs.writeFileSync(path.join(HOME, ".claude/.stignore"), "mine\n");
  fs.writeFileSync(path.join(STUB, "syncthing-state/folders"), "");
  code = (await req("POST", "/api/sync/code")).json?.code;
  await req("POST", "/api/sync/pair", { body: { id: ID1, name: "Again", code } });
  check("a .stignore that's already there is left alone", read(path.join(HOME, ".claude/.stignore")) === "mine\n");

  const served = await req("GET", "/setup/mac");
  check("a setup script isn't handed out before this computer knows its Tailscale address", served.status === 503, String(served.status));

  // ── nothing Claude reads says "Luqman" ──
  const hookServer = http.createServer((q, res) => { q.resume(); q.on("end", () => res.end(JSON.stringify({ behavior: "deny" }))); });
  await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
  fs.mkdirSync(path.join(D, "hookdata"), { recursive: true });
  fs.writeFileSync(path.join(D, "hookdata/secret"), "s");
  // Not spawnSync: the pretend phone above lives in this process and has to be free to answer.
  const hook = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(APP, "hook.mjs")], {
      env: { ...cleanEnv(), CLAUDE_CHAT_ID: "x", CLAUDE_CHAT_DATA: path.join(D, "hookdata"), CLAUDE_CHAT_PORT: String(hookServer.address().port) },
    });
    let stdout = "";
    p.stdout.on("data", (c) => (stdout += c));
    p.on("close", () => resolve({ stdout }));
    p.stdin.end(JSON.stringify({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "ls" } }));
  });
  hookServer.close();
  const denied = (() => { try { return JSON.parse(hook.stdout).hookSpecificOutput.decision; } catch { return null; } })();
  check("a denial from the phone tells Claude 'the user', not a name", denied?.behavior === "deny" && denied.message === "The user denied this from their phone.", hook.stdout);
  check("…and so does skipping a question", read(path.join(APP, "server.mjs")).includes(`"The user skipped this question from their phone."`) &&
    !/"[^"\n]*Luqman[^"\n]*"/.test(read(path.join(APP, "server.mjs")).replace(/^\s*\/\/.*$/gm, "")));
} catch (e) {
  check("the server part ran without an error", false, e.stack);
} finally {
  server?.kill();
  spawnSync(TMUX, ["-L", SOCKET, "kill-server"]);
}

// ── 2. the setup scripts, in a sandbox ─────────────────────────────────────────────────────

// An address line still holding its placeholder is how a script knows it came straight from GitHub. The
// server fills in every copy of the placeholder, so the line that checks for it mustn't spell it out.
for (const f of ["setup/mac.sh", "setup/windows.ps1"]) {
  const line = read(path.join(APP, f)).split("\n").find((l) => /^(FIRST|\$First)\b|^case "\$HOME_URL"/.test(l)) || "";
  check(`${f} tells the two kinds of computer apart without naming the placeholder`, line && !line.includes("__HOME_URL__"), line.trim());
}

if (fs.existsSync("/Applications/Tailscale.app")) {
  // The scripts would find the real Tailscale app ahead of the pretend one, and change its settings.
  console.log("SKIP  the setup scripts — this Mac has the Tailscale app, which the sandbox can't hide");
} else {
  const BOX = path.join(D, "box");
  const LOG = path.join(BOX, "calls.log");
  const SHIMS = path.join(BOX, "bin");
  const log = `echo "$(basename "$0") $*" >> "${LOG}"`;
  // Pretend installers. Each writes down what it was asked, and a few answer the way the real one would.
  for (const tool of ["brew", "launchctl", "apt-get"]) script(path.join(SHIMS, tool), `${log}\n`);
  script(path.join(SHIMS, "sudo"), `${log}\ncat >/dev/null\n`);
  script(path.join(SHIMS, "scutil"), `echo "Test Mac"\n`);
  script(path.join(SHIMS, "pgrep"), `exit 0\n`);
  script(path.join(SHIMS, "node"), `echo v22.12.0\n`);
  script(path.join(SHIMS, "gh"), `${log}\n[ "$1 $2" = "auth status" ] && exit "\${GH_SIGNED_IN:-1}"\nexit 0\n`);
  script(path.join(SHIMS, "tailscale"), `${log}
[ "\${TS_SIGNED_OUT:-}" = 1 ] && [ "$1" = status ] && exit 1
[ "$*" = "status --json" ] && echo '{"BackendState":"Running","Self":{"DNSName":"new-mac.tail1234.ts.net."}}'
exit 0
`);
  script(path.join(SHIMS, "curl"), `${log}
case "$*" in
  *claude.ai/install.sh*) echo 'echo "(pretend) Claude Code installed"' ;;
  */api/whoami*) echo '{"name":"Main"}' ;;
  */api/projects*) echo '[{"name":"ai/claude-chat","remote":"${REPO}"},{"name":"My Game","remote":"https://github.com/someone/my-game.git"},{"name":"game/racer","remote":"https://github.com/someone/racer.git"},{"name":"notes","remote":null}]' ;;
esac
`);
  // git clone copies in just enough of claude-chat for its own install.sh to run.
  script(path.join(SHIMS, "git"), `${log}
if [ "$1" = clone ]; then
  dest="\${@: -1}"; mkdir -p "$dest/.git"
  case "$dest" in */claude-chat) cp -R "${APP}/install.sh" "${APP}/bin" "$dest/" ;; esac
fi
exit 0
`);
  pretendSyncthing(SHIMS);
  fs.symlinkSync("/usr/bin/jq", path.join(SHIMS, "jq"));

  // Runs a script with the pretend home and tools. Only the Mac's own basics are left on the PATH.
  const runIn = (home, file, args = [], env = {}) => {
    fs.rmSync(LOG, { force: true });
    fs.mkdirSync(home, { recursive: true });
    const r = spawnSync("/bin/bash", [file, ...args], {
      env: { HOME: home, PATH: `${SHIMS}:/usr/bin:/bin`, TERM: "dumb", ...env }, encoding: "utf8", timeout: 60000, input: "",
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls: read(LOG) };
  };

  // ── a Mac, first computer: downloaded straight from GitHub ──
  const firstHome = path.join(BOX, "first-mac");
  let r = runIn(firstHome, path.join(APP, "setup/mac.sh"));
  const cc = path.join(firstHome, "Desktop/project/claude-chat");
  check("mac.sh from GitHub finishes on a brand-new Mac", r.code === 0, r.code === 0 ? "" : r.out.slice(-800));
  check("…installs the tools and Claude Code", r.calls.includes("brew install --quiet tmux node gh jq syncthing") && r.calls.includes("curl -fsSL https://claude.ai/install.sh"));
  check("…downloads claude-chat itself from GitHub", r.calls.includes(`git clone -q ${REPO} ${cc}`));
  check("…and nothing else: no other computer, no GitHub sign-in, no pairing",
    !r.calls.includes("/api/") && !r.calls.includes("gh auth") && !r.calls.includes("folders add") && !/Pairing code/.test(r.out));
  check("…starts claude-chat at login", fs.existsSync(path.join(firstHome, "Library/LaunchAgents/com.juslangit.claude-chat.plist")) &&
    r.calls.includes("launchctl bootstrap") && fs.lstatSync(path.join(firstHome, ".local/bin/cchat"), { throwIfNoEntry: false })?.isSymbolicLink());
  check("…publishes it on Tailscale", r.calls.includes("tailscale serve --bg 4477"));
  check("…and ends with the address to open on the iPhone", r.out.includes("https://new-mac.tail1234.ts.net") && r.out.includes("Add to Home Screen"));
  r = runIn(firstHome, path.join(APP, "setup/mac.sh"));
  check("running it again is fine, and doesn't download claude-chat twice", r.code === 0 && !r.calls.includes("git clone") && r.out.includes("already here"));

  r = runIn(path.join(BOX, "signed-out-mac"), path.join(APP, "setup/mac.sh"), [], { TS_SIGNED_OUT: "1" });
  check("with Tailscale signed out it stops first, before installing anything",
    r.code === 1 && r.out.includes("App Store") && !r.calls.includes("brew install"), r.out.slice(-300));

  // ── a Mac added from the phone: the script as another computer hands it out ──
  const joinScript = path.join(BOX, "mac-join.sh");
  fs.writeFileSync(joinScript, read(path.join(APP, "setup/mac.sh")).replaceAll("__HOME_URL__", "https://main.tail1234.ts.net"));
  const joinHome = path.join(BOX, "join-mac");
  fs.mkdirSync(path.join(SHIMS, "syncthing-state"), { recursive: true });
  fs.writeFileSync(path.join(SHIMS, "syncthing-state/folders"), "claude-home\n"); // already paired: no code to type
  r = runIn(joinHome, joinScript, [], { GH_SIGNED_IN: "0" });
  check("mac.sh handed out by another computer finishes", r.code === 0, r.code === 0 ? "" : r.out.slice(-800));
  check("…finds that computer, and checks GitHub", r.calls.includes("https://main.tail1234.ts.net/api/whoami") && r.calls.includes("gh auth status"));
  check("…copies every project that has a GitHub address, spaces and all",
    r.calls.includes(`git clone -q ${REPO} ${path.join(joinHome, "Desktop/project/claude-chat")}`) &&
    r.calls.includes(`git clone -q https://github.com/someone/my-game.git ${path.join(joinHome, "Desktop/project/My Game")}`) && !r.calls.includes("/notes"));
  check("…keeps subject folders for projects, but not a second copy of claude-chat",
    r.calls.includes(`git clone -q https://github.com/someone/racer.git ${path.join(joinHome, "Desktop/project/game/racer")}`) &&
    !r.calls.includes(path.join(joinHome, "Desktop/project/ai/claude-chat")) && r.calls.split(`git clone -q ${REPO} `).length === 2);
  check("…and says it now shows on the iPhone", r.out.includes("now shows on your iPhone") && r.out.includes("Already paired"));
  fs.writeFileSync(path.join(SHIMS, "syncthing-state/folders"), "");

  // ── the Linux half of a Windows PC ──
  const pcHome = path.join(BOX, "pc");
  const pcProjects = path.join(BOX, "pc-c-drive/Users/test/Desktop/project");
  const pcWork = path.join(BOX, "pc-setup");
  fs.mkdirSync(pcProjects, { recursive: true });
  fs.mkdirSync(pcWork, { recursive: true });
  fs.writeFileSync(path.join(pcWork, "projects.txt"), `claude-chat\t${REPO}\r\n`); // PowerShell writes Windows line endings
  r = runIn(pcHome, path.join(APP, "setup/wsl.sh"), ["install", pcProjects, pcWork, "TEST-PC", "first"]);
  check("wsl.sh on a first PC finishes", r.code === 0, r.code === 0 ? "" : r.out.slice(-800));
  check("…downloads claude-chat into the Windows project folder", r.calls.includes(`git clone -q ${REPO} ${path.join(pcProjects, "claude-chat")}`));
  check("…without asking to sign in to GitHub", !r.calls.includes("gh auth"));
  check("…writes the start-at-login script for that folder", read(path.join(pcHome, ".claude-chat/start.sh")).includes(`CLAUDE_CHAT_WORKDIR="${pcProjects}"`));
  check("…and gets Syncthing ready for a second computer", read(path.join(pcWork, "sync-id.txt")).startsWith("NEWIDAA") && r.out.includes("When you add another computer"));
  r = runIn(path.join(BOX, "pc-join"), path.join(APP, "setup/wsl.sh"), ["install", pcProjects, pcWork, "TEST-PC"]);
  const pcSorted = path.join(BOX, "pc-sorted/Desktop/project");
  fs.mkdirSync(pcSorted, { recursive: true });
  fs.writeFileSync(path.join(pcWork, "projects.txt"), `ai/claude-chat\t${REPO}\r\ngame/racer\thttps://github.com/someone/racer.git\r\n`);
  r = runIn(path.join(BOX, "pc-sorted-home"), path.join(APP, "setup/wsl.sh"), ["install", pcSorted, pcWork, "TEST-PC", "join"]);
  check("wsl.sh adding a PC from a computer with subject folders finishes", r.code === 0, r.code === 0 ? "" : r.out.slice(-800));
  check("…puts claude-chat where it starts it from, and the rest in their subject folders",
    r.calls.includes(`git clone -q ${REPO} ${path.join(pcSorted, "claude-chat")}`) && !r.calls.includes(path.join(pcSorted, "ai/claude-chat")) &&
    r.calls.includes(`git clone -q https://github.com/someone/racer.git ${path.join(pcSorted, "game/racer")}`));
  fs.writeFileSync(path.join(pcWork, "projects.txt"), `claude-chat\t${REPO}\r\n`);
  check("wsl.sh without a mode still adds a computer the old way, GitHub sign-in and all", r.code === 0 && r.calls.includes("gh auth login"), r.out.slice(-300));
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);

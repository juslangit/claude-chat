// Update claude-chat on another of your computers, from this one: a short helper chat there pulls main
// and restarts its server (start.sh or the LaunchAgent brings it back), then the helper chat is deleted.
//   node dev/update-computer.mjs <tailscale host> [the version it has now]
import { execFileSync } from "node:child_process";

const REACH = new URL("./reach.mjs", import.meta.url).pathname;
const HOST = process.argv[2];
if (!HOST) { console.log("usage: node dev/update-computer.mjs <tailscale host> [the version it has now]"); process.exit(1); }
const OLD = process.argv[3]; // what it was on before, so the change shows
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T = (method, path, body) => {
  try {
    const out = execFileSync(process.execPath, [REACH, HOST, method, path, ...(body ? [JSON.stringify(body)] : [])], { encoding: "utf8", timeout: 40000 });
    const [status, ...rest] = out.trim().split("\n");
    let json; try { json = JSON.parse(rest.join("\n")); } catch {}
    return { status: Number(status) || 0, json };
  } catch { return { status: 0 }; }
};
const status = (id) => T("GET", "/api/chats").json?.find?.((x) => x.id === id)?.status;

const c = T("POST", "/api/chats", { name: "Update claude-chat", terminal: false }).json;
if (!c?.id) { console.log("couldn't start the helper chat"); process.exit(1); }
console.log("helper chat", c.id);
for (let i = 0; i < 45 && status(c.id) !== "idle"; i++) await sleep(2000);
console.log("helper status:", status(c.id));

const sent = T("POST", `/api/chats/${c.id}/send`, { text:
  "Update claude-chat on this computer, please, without asking me anything. 1) In the claude-chat folder inside the project folder, " +
  "run `git pull --ff-only` (branch main). 2) Restart the claude-chat server: find the PID of the `node server.mjs` process " +
  "listening on port 4477 (e.g. `ss -ltnp | grep 4477`) and kill only that one process — start.sh starts it again within a " +
  "few seconds. Don't touch tmux or any other process. 3) Reply with the output of `git log --oneline -1`." });
console.log("sent:", sent.status, JSON.stringify(sent.json));

let version;
for (let i = 0; i < 60; i++) {
  await sleep(4000);
  version = T("GET", "/api/whoami").json?.version;
  if (version && version !== OLD) break;
}
console.log("page version now:", version, version !== OLD ? "(changed)" : "(NOT changed)");

for (let i = 0; i < 30 && status(c.id) !== "idle"; i++) await sleep(2000);
const msgs = T("GET", `/api/chats/${c.id}/messages`).json || [];
console.log("helper's last words:", msgs.filter((m) => m.role === "assistant").map((m) => m.text).at(-1));
console.log("delete helper chat:", T("DELETE", `/api/chats/${c.id}`).status);

// Claude Code runs this for each hook event in a claude-chat session. It passes the event on
// to server.mjs, and for a permission request it waits for the answer from the phone.
//
// If the server isn't running it quietly does nothing, so Claude Code just carries on with its
// normal prompt in the Terminal.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;

const chatId = process.env.CLAUDE_CHAT_ID; // set only for sessions started by claude-chat
if (!chatId) process.exit(0);

let secret;
try { secret = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "data/secret"), "utf8").trim(); }
catch { process.exit(0); }

const event = JSON.parse(input);
const payload = JSON.stringify({ chatId, event });

// Plain http.request rather than fetch: fetch gives up after 5 minutes, and an approval can take longer.
const req = http.request({
  host: "127.0.0.1", port: Number(process.env.CLAUDE_CHAT_PORT || 4477), path: "/hook", method: "POST",
  headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-secret": secret },
}, (res) => {
  let data = "";
  res.on("data", (chunk) => (data += chunk));
  res.on("end", () => {
    if (event.hook_event_name !== "PermissionRequest") return; // other events: print nothing
    let answer = {};
    try { answer = JSON.parse(data); } catch {}
    if (!answer.behavior) return; // no answer from the phone: the Terminal prompt stays up
    const decision = answer.behavior === "allow"
      ? { behavior: "allow" }
      : { behavior: "deny", message: "Luqman denied this from his phone." };
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
  });
});
req.on("error", () => process.exit(0));
req.end(payload);

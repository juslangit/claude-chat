// Make one HTTPS request to a computer's claude-chat the way the iPhone does: through Tailscale
// (`tailscale nc <host> 443`) and tailscale serve. This Mac's userspace Tailscale can't open normal
// connections into the tailnet, so the TLS runs over nc's stdin/stdout.
//
//   node tsreq.mjs <host> <METHOD> <path> [json body] [origin]
//   → prints "<status>\n<body>" (for /events: the first bytes of the stream)
import { spawn } from "node:child_process";
import { Duplex } from "node:stream";
import tls from "node:tls";
import http from "node:http";

const [host, method = "GET", path = "/api/whoami", body, origin] = process.argv.slice(2);
const fqdn = `${host}.tail8806f8.ts.net`;
const nc = spawn("/opt/homebrew/opt/tailscale/bin/tailscale", [
  `--socket=${process.env.HOME}/Library/Application Support/tailscale-user/tailscaled.sock`, "nc", host, "443"]);
const socket = tls.connect({ socket: Duplex.from({ readable: nc.stdout, writable: nc.stdin }), servername: fqdn });
const done = (code) => { nc.kill(); process.exit(code); };
setTimeout(() => { console.log("timed out"); done(1); }, 30000);

const req = http.request({
  createConnection: () => socket, host: fqdn, path, method,
  headers: { host: fqdn, ...(body && { "content-type": "application/json" }), ...(origin && { origin }) },
}, (res) => {
  let text = "";
  res.on("data", (c) => {
    text += c;
    if (path === "/events") { console.log(`${res.statusCode}\n${text}`); done(0); }
  });
  res.on("end", () => { console.log(`${res.statusCode}\n${text}`); done(0); });
});
req.on("error", (e) => { console.log(`error: ${e.message}`); done(1); });
if (body) req.write(body);
req.end();

// Test copy of the phone page on :4478. Page files come from the folder given; /api and /events
// are passed through to the real server on :4477, READ-ONLY (anything but GET is refused), so
// testing can't send messages, start or end chats.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const DIR = path.resolve(process.argv[2]);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/") || url.pathname === "/events") {
    if (req.method !== "GET") {
      res.writeHead(403, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "test copy is read-only" }));
    }
    const up = http.request({ host: "127.0.0.1", port: 4477, path: req.url, method: "GET", headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.end());
    req.on("close", () => up.destroy());
    return up.end();
  }
  const file = path.join(DIR, url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(DIR)) { res.writeHead(404); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(data);
  });
}).listen(4478, "127.0.0.1", () => console.log("stage on http://127.0.0.1:4478"));

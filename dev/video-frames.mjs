// Pull still frames out of the reference video, without ffmpeg: serve the file to headless Chrome,
// seek the <video> to each moment and draw it into a canvas.
//   node frames.mjs <video file> <how many frames>
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = process.env.CLAUDE_CHAT_WORK || path.join(HERE, "checks/.work");
const VIDEO = process.argv[2];
const COUNT = Number(process.argv[3] || 24);
const OUT = `${WORK}/frames`;
const PORT = 4482, CDP = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">
<video id="v" src="/video" preload="auto" muted playsinline></video>
<canvas id="c" hidden></canvas>`;
const server = http.createServer((q, s) => {
  if (q.url === "/video") {
    const size = fs.statSync(VIDEO).size;
    const range = q.headers.range?.match(/bytes=(\d+)-(\d*)/);
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : size - 1;
    s.writeHead(range ? 206 : 200, {
      "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": end - start + 1,
      ...(range && { "content-range": `bytes ${start}-${end}/${size}` }),
    });
    return fs.createReadStream(VIDEO, { start, end }).pipe(s);
  }
  s.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  s.end(page);
}).listen(PORT, "127.0.0.1");

const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${CDP}`, `--user-data-dir=${WORK}/.chrome-frames`,
  "--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required", "about:blank"], { stdio: "ignore" });

try {
  let ver;
  for (let i = 0; i < 60 && !ver; i++) { await sleep(250); ver = await fetch(`http://127.0.0.1:${CDP}/json/version`).then((r) => r.json()).catch(() => null); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let seq = 0;
  const waiting = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { const { res, rej } = waiting.get(m.id); waiting.delete(m.id); return m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const id = ++seq; waiting.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Page.enable");
  await S("Runtime.enable");
  const js = async (expression) => {
    const r = await S("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  await S("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await sleep(1500);
  const info = await js(`new Promise((done) => { const v = document.getElementById("v");
    const ready = () => done({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    if (v.readyState >= 2) ready(); else v.addEventListener("loadeddata", ready, { once: true }); })`);
  console.log(`video: ${info.width}×${info.height}, ${info.duration.toFixed(1)} s`);

  for (let i = 0; i < COUNT; i++) {
    const at = (info.duration * (i + 0.5)) / COUNT;
    const data = await js(`new Promise((done) => { const v = document.getElementById("v"), c = document.getElementById("c");
      v.addEventListener("seeked", () => {
        c.width = v.videoWidth; c.height = v.videoHeight;
        c.getContext("2d").drawImage(v, 0, 0);
        done(c.toDataURL("image/png").split(",")[1]);
      }, { once: true });
      v.currentTime = ${at}; })`);
    const file = `${OUT}/frame-${String(i).padStart(2, "0")}-${at.toFixed(1)}s.png`;
    fs.writeFileSync(file, Buffer.from(data, "base64"));
    console.log(path.basename(file));
  }
} catch (e) {
  console.log("failed:", e.message);
} finally {
  chrome.kill();
  server.close();
  process.exit(0);
}

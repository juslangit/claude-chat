// Screenshots of the test copy, sized like an iPhone (390×844 @2x), driven through Chrome's DevTools protocol.
// usage: node shot.mjs <out-dir> <scenarios.json>
// Each scenario: { name?, url?, dark?, eval?, wait? } — url navigates fresh, eval runs in the page, name saves a PNG.
import { spawn } from "node:child_process";
import fs from "node:fs";

const [OUT, SCEN] = process.argv.slice(2);
const BASE = "http://127.0.0.1:4478/";
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${OUT}/.profile`,
  "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank",
], { stdio: "ignore" });
const done = (code) => { chrome.kill(); process.exit(code); };
setTimeout(() => { console.log("timed out"); done(1); }, 90000);

let ver;
for (let i = 0; i < 60 && !ver; i++) {
  await sleep(250);
  ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null);
}
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const waiting = new Map();
const logs = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    const { res, rej } = waiting.get(m.id);
    waiting.delete(m.id);
    return m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
  if (m.method === "Runtime.exceptionThrown") logs.push("EXCEPTION " + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(m.params.type)) logs.push(`console.${m.params.type} ` + m.params.args.map((a) => a.value ?? a.description).join(" "));
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++seq;
  waiting.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (m, p) => send(m, p, sessionId);
await S("Page.enable");
await S("Runtime.enable");
await S("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await S("Emulation.setTouchEmulationEnabled", { enabled: true });

for (const sc of JSON.parse(fs.readFileSync(SCEN, "utf8"))) {
  await S("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: sc.dark ? "dark" : "light" }] });
  if (sc.url !== undefined) {
    await S("Page.navigate", { url: "about:blank" });
    await sleep(200);
    await S("Page.navigate", { url: BASE + sc.url });
    await sleep(1800);
  }
  if (sc.eval) {
    const r = await S("Runtime.evaluate", { expression: sc.eval, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) logs.push(`eval error (${sc.name || "-"}): ${r.exceptionDetails.exception?.description}`);
    else if (r.result?.value !== undefined) logs.push(`${sc.name || "eval"}: ${JSON.stringify(r.result.value)}`);
    await sleep(sc.wait ?? 600);
  }
  if (sc.name) {
    const { data } = await S("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${OUT}/${sc.name}.png`, Buffer.from(data, "base64"));
  }
}
console.log(logs.join("\n") || "no errors");
done(0);

// Run the checks on this copy of claude-chat.
//
//   node dev/checks/run.mjs                 every suite, in order
//   node dev/checks/run.mjs commands        just one (or several by name)
//   node dev/checks/run.mjs --quick         only the ones that don't need Claude to answer
//
// Each suite starts its own server on :4479 with its own data folder, tmux server and .env, so none of
// this touches the app you actually use. They run one after another because they share those ports.
// Anything a suite leaves behind lives in dev/checks/.work (git-ignored).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES = [
  { name: "commands", about: "Claude Code's own commands, run from the phone", minutes: 3, claude: true },
  { name: "archive", about: "archiving, deleting, and staying quiet", minutes: 3, claude: false },
  { name: "features", about: "photos, pins, search, replies, notifications", minutes: 6, claude: true },
  { name: "fixes", about: "reconnecting, offline, and the safety checks", minutes: 6, claude: true },
];

const args = process.argv.slice(2);
const quick = args.includes("--quick");
const picked = args.filter((a) => !a.startsWith("--"));
const todo = SUITES.filter((s) => (picked.length ? picked.includes(s.name) : true) && (!quick || !s.claude));
if (!todo.length) {
  console.log(`Nothing to run. Suites: ${SUITES.map((s) => s.name).join(", ")}`);
  process.exit(1);
}
console.log(`Running ${todo.length} suite${todo.length > 1 ? "s" : ""} (about ${todo.reduce((n, s) => n + s.minutes, 0)} minutes).\n`);

const results = [];
for (const suite of todo) {
  console.log(`──── ${suite.name}: ${suite.about} ────`);
  const started = Date.now();
  const out = await new Promise((resolve) => {
    let text = "";
    const child = spawn(process.execPath, [path.join(HERE, `${suite.name}.mjs`)], { env: process.env });
    child.stdout.on("data", (c) => { text += c; process.stdout.write(c); });
    child.stderr.on("data", (c) => { text += c; process.stderr.write(c); });
    child.on("close", () => resolve(text));
  });
  const score = out.match(/(\d+)\/(\d+) passed/);
  results.push({ ...suite, passed: score ? Number(score[1]) : 0, total: score ? Number(score[2]) : 0,
    seconds: Math.round((Date.now() - started) / 1000) });
  console.log("");
}

console.log("──── in short ────");
let passed = 0, total = 0;
for (const r of results) {
  passed += r.passed;
  total += r.total;
  console.log(`${r.passed === r.total && r.total ? "✓" : "✗"} ${r.name.padEnd(10)} ${String(r.passed).padStart(3)}/${r.total}  ${r.seconds}s`);
}
console.log(`\n${passed}/${total} checks passed`);
process.exit(passed === total && total ? 0 : 1);

// Claude's progress notes, read off the Terminal screen.
//
// Claude Code doesn't reliably write the short notes Claude says between steps ("Now I'll check
// the server…") into its transcript, but it always shows them on screen, each starting with ⏺.
// This picks out the finished ones from the current turn, so the phone can show them while Claude
// works — instead of a silent "typing…".
//
// What the screen looks like:
//
//   ❯ make the send button bigger            ← the message you sent (the turn starts after it)
//   ⏺ I'll look at the styles first.          ← a note: ⏺ + text, carried on by indented lines
//     Ran 3 shell commands                    ← folded steps
//   ⏺ Update(public/style.css)                ← a step: ⏺ Tool(…)
//     ⎿  Updated 2 lines                      ← a step's result
//   ✻ Working… (12s)                          ← spinner
//   ────────────────────
//   ❯                                         ← the input box (never read)
//   ────────────────────

const DOT = /^[⏺●] /;
const TOOL_CALL = /^[\w.:-]+\(/; // ⏺ Bash(…), ⏺ Read(…), ⏺ mcp__server__tool(…)
const FOLDED_STEPS = /^(Running|Ran|Reading|Read|Searching|Searched|Listing|Listed|Writing|Wrote|Updating|Updated|Editing|Edited|Fetching|Fetched)\b.*\d/;

// → the text of each finished note in the current turn, oldest first. A note counts as finished
// once something comes after it; the last one might still be appearing, or be Claude's final reply
// (which the phone gets from the transcript anyway).
export function notesFromScreen(screen) {
  const lines = screen.split("\n").map((l) => l.trimEnd());
  const rules = lines.flatMap((l, i) => (/^\s*─{10,}/.test(l) ? [i] : []));
  const end = rules.length >= 2 ? rules[rules.length - 2] : lines.length;
  let start = 0;
  for (let i = end - 1; i >= 0; i--) if (lines[i].startsWith("❯ ")) { start = i + 1; break; }

  const blocks = [];
  let cur = null;
  for (const line of lines.slice(start, end)) {
    if (DOT.test(line)) {
      const head = line.slice(2);
      cur = { step: TOOL_CALL.test(head) || FOLDED_STEPS.test(head), lines: [head] };
      blocks.push(cur);
    } else if (line === "") {
      cur?.lines.push("");
    } else if (/^\s/.test(line)) {
      const body = line.replace(/^ {2}/, "");
      if (body.trimStart().startsWith("⎿")) { if (cur) cur.step = true; continue; }
      if (FOLDED_STEPS.test(body.trim())) { cur = { step: true, lines: [] }; blocks.push(cur); continue; }
      cur?.lines.push(body);
    } else {
      cur = null; // spinner, "✻ Worked for 3s", anything else that isn't part of a block
    }
  }
  return blocks.slice(0, -1).filter((b) => !b.step).map((b) => tidy(b.lines)).filter(Boolean);
}

// Claude Code wraps text to the window width; join it back into paragraphs and list items.
function tidy(lines) {
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) { if (out.length && out.at(-1) !== "") out.push(""); continue; }
    const startsItem = /^([-•*]|\d+\.) /.test(t);
    if (out.length && out.at(-1) !== "" && !startsItem) out[out.length - 1] += " " + t;
    else out.push(t);
  }
  return out.join("\n").replace(/\n{2,}/g, "\n\n").trim();
}

// Two versions of the same note (e.g. wrapped differently) get the same key.
export const noteKey = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 200);

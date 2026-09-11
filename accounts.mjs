// Which Claude account a chat runs as.
//
// Claude Code signs in once per computer and keeps that login in the Mac's Keychain, so there is no
// way to swap accounts from a phone — which is exactly what this is for. A second account is added
// as a long-lived token (`claude setup-token`), kept in ~/.claude/.env with the other keys, and
// handed to a chat as CLAUDE_CODE_OAUTH_TOKEN when it starts. That variable wins over the signed-in
// login, so one chat can run on Max and the next on Pro with nothing logged out.
//
// The tokens live in ~/.claude/.env, which Syncthing shares between the computers, so an account
// added on one is there on the other. Which account a computer starts new chats with is its own
// business, and is kept in data/accounts.json.

import fs from "node:fs";
import path from "node:path";

const SIGNED_IN = "signed-in"; // the account Claude Code is logged in as on this computer

// "Pro", "Max", "Max 20×" — from the two fields Anthropic uses to say what a subscription is.
export function planName(type, tier) {
  const s = `${type || ""} ${tier || ""}`.toLowerCase();
  if (s.includes("max")) return s.includes("20x") ? "Max 20×" : s.includes("5x") ? "Max 5×" : "Max";
  if (s.includes("pro")) return "Pro";
  if (s.includes("enterprise")) return "Enterprise";
  if (s.includes("team")) return "Team";
  return null;
}

function readEnv(file) {
  const env = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*["']?([^"'\n]*)["']?\s*$/);
      if (m) env[m[1]] = m[2];
    }
  } catch {}
  return env;
}

// Who Claude Code is signed in as here. ~/.claude.json holds the profile it fetched at sign-in —
// no token needed to read it, which is why the plan can be shown without touching the Keychain.
export function signedInAccount(home) {
  let a = {};
  try { a = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8")).oauthAccount || {}; } catch {}
  if (!a.emailAddress) return null;
  return {
    id: SIGNED_IN, signedIn: true,
    label: a.displayName || a.fullName || a.emailAddress,
    email: a.emailAddress,
    org: a.organizationName && !a.organizationName.startsWith(a.emailAddress) ? a.organizationName : null,
    plan: planName(a.organizationType, a.organizationRateLimitTier),
  };
}

// The added accounts, read back out of ~/.claude/.env. Four variables each, sharing a slug:
// CLAUDE_CHAT_ACCOUNT_<SLUG>_TOKEN, _LABEL, _PLAN, _EMAIL.
export function addedAccounts(envFile) {
  const env = readEnv(envFile);
  return Object.keys(env)
    .map((k) => k.match(/^CLAUDE_CHAT_ACCOUNT_(.+)_TOKEN$/)?.[1])
    .filter((slug) => slug && env[`CLAUDE_CHAT_ACCOUNT_${slug}_TOKEN`])
    .map((slug) => ({
      id: slug, signedIn: false,
      label: env[`CLAUDE_CHAT_ACCOUNT_${slug}_LABEL`] || slug,
      email: env[`CLAUDE_CHAT_ACCOUNT_${slug}_EMAIL`] || null,
      org: null,
      plan: env[`CLAUDE_CHAT_ACCOUNT_${slug}_PLAN`] || null,
    }));
}

export function allAccounts(envFile, home) {
  return [signedInAccount(home), ...addedAccounts(envFile)].filter(Boolean);
}

// The token to start a chat with, or null for the signed-in account (which needs no token).
export function tokenFor(envFile, id) {
  if (!id || id === SIGNED_IN) return null;
  return readEnv(envFile)[`CLAUDE_CHAT_ACCOUNT_${id}_TOKEN`] || null;
}

const slugOf = (label) => (label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "ACCOUNT").slice(0, 24);

export function addAccount(envFile, { label, plan, email, token }) {
  const taken = new Set(addedAccounts(envFile).map((a) => a.id));
  let slug = slugOf(label);
  for (let n = 2; taken.has(slug); n++) slug = `${slugOf(label)}_${n}`;
  let before = "";
  try { before = fs.readFileSync(envFile, "utf8"); } catch {}
  const line = (suffix, value) => `CLAUDE_CHAT_ACCOUNT_${slug}_${suffix}=${String(value).replace(/[\r\n]/g, "")}\n`;
  fs.appendFileSync(envFile,
    `${before && !before.endsWith("\n") ? "\n" : ""}# claude-chat: another Claude account, switchable from the phone\n` +
    line("LABEL", label) + (plan ? line("PLAN", plan) : "") + (email ? line("EMAIL", email) : "") + line("TOKEN", token),
    { mode: 0o600 });
  return slug;
}

// Takes the four variables back out, leaving every other key in the file alone.
export function removeAccount(envFile, id) {
  let text;
  try { text = fs.readFileSync(envFile, "utf8"); } catch { return false; }
  const mine = new RegExp(`^\\s*(?:export\\s+)?CLAUDE_CHAT_ACCOUNT_${id}_(TOKEN|LABEL|PLAN|EMAIL)\\s*=`);
  const kept = text.split("\n").filter((l) => !mine.test(l));
  if (kept.length === text.split("\n").length) return false;
  fs.writeFileSync(envFile, kept.join("\n"), { mode: 0o600 });
  return true;
}

// What Anthropic says an account is, asked with the token itself. A token made by `claude setup-token`
// may only be allowed to run Claude and not to read the profile, so this is a bonus, never a
// requirement — whatever it can't answer stays as whatever was typed in on the phone.
export async function fetchProfile(token) {
  try {
    const r = await fetch("https://api.anthropic.com/api/oauth/profile", {
      headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const { account, organization } = await r.json();
    if (!account?.email) return null;
    return {
      email: account.email,
      label: account.display_name || account.full_name || account.email,
      plan: account.has_claude_max ? planName("max", organization?.rate_limit_tier) || "Max"
        : account.has_claude_pro ? "Pro" : planName(organization?.organization_type, organization?.rate_limit_tier),
    };
  } catch { return null; }
}

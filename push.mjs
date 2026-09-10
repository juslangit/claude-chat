// Push notifications to the iPhone, using only Node's own crypto — no packages (D-005, D-018).
//
// When you turn notifications on, the iPhone asks Apple for a private push address and gives it to
// each computer, with two keys. To send a notification, a computer:
//   1. encrypts it so only that iPhone can read it (RFC 8291) — Apple just passes it on, and
//   2. signs a short note saying who's sending (VAPID, RFC 8292), with the key the iPhone was shown
//      when it subscribed.
// Every computer must sign with that same key, so it lives in ~/.claude/.env, which Syncthing already
// keeps the same on all your computers (D-014).

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const unb64u = (s) => Buffer.from(String(s || ""), "base64url");

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

// The signing key, or null if none has been made yet.
export function vapidKeys(envFile) {
  const env = readEnv(envFile);
  return env.CLAUDE_CHAT_VAPID_PUBLIC && env.CLAUDE_CHAT_VAPID_PRIVATE
    ? { publicKey: env.CLAUDE_CHAT_VAPID_PUBLIC, privateKey: env.CLAUDE_CHAT_VAPID_PRIVATE } : null;
}

// Made once, the first time the phone asks for it, and added to the end of ~/.claude/.env.
export function makeVapidKeys(envFile) {
  const have = vapidKeys(envFile);
  if (have) return have;
  const jwk = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "jwk" });
  const keys = { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)])), privateKey: jwk.d };
  let before = "";
  try { before = fs.readFileSync(envFile, "utf8"); } catch {}
  fs.appendFileSync(envFile, `${before && !before.endsWith("\n") ? "\n" : ""}# claude-chat push notifications (made by its server, shared by Syncthing)\n` +
    `CLAUDE_CHAT_VAPID_PUBLIC=${keys.publicKey}\nCLAUDE_CHAT_VAPID_PRIVATE=${keys.privateKey}\n`, { mode: 0o600 });
  return keys;
}

// What the phone hands over: { endpoint, keys: { p256dh, auth } }. Apple's addresses are https; a plain
// http one is allowed only on this computer itself, for testing.
export function validSubscription(s) {
  try {
    const u = new URL(s.endpoint);
    if (!(u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "127.0.0.1"))) return false;
    const p256dh = unb64u(s.keys.p256dh), auth = unb64u(s.keys.auth);
    return p256dh.length === 65 && p256dh[0] === 4 && auth.length === 16;
  } catch { return false; }
}

// RFC 8291: encrypt `text` for one phone. What comes back is the whole request body.
export function encrypt(text, sub) {
  const phoneKey = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const ecdh = crypto.createECDH("prime256v1");
  const ourKey = ecdh.generateKeys(); // a fresh key pair for every message
  const secret = ecdh.computeSecret(phoneKey);
  const hkdf = (salt, ikm, info, length) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, info, length));
  const ikm = hkdf(auth, secret, Buffer.concat([Buffer.from("WebPush: info\0"), phoneKey, ourKey]), 32);
  const salt = crypto.randomBytes(16);
  const key = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = crypto.createCipheriv("aes-128-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(text), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = ourKey.length;
  return Buffer.concat([head, ourKey, sealed]);
}

// RFC 8292: the signed note saying this message comes from whoever holds the key.
function vapid(endpoint, keys, subject) {
  const pub = unb64u(keys.publicKey);
  const signer = crypto.createPrivateKey({ format: "jwk",
    key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)), d: keys.privateKey } });
  const part = (o) => b64u(JSON.stringify(o));
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const sig = crypto.sign("sha256", Buffer.from(unsigned), { key: signer, dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${keys.publicKey}`;
}

// Send one notification. Always resolves, to { status, text }: 201 means Apple took it; 404 or 410
// means that address is gone (the phone turned notifications off).
export function send(sub, payload, keys, subject) {
  return new Promise((resolve) => {
    try {
      const body = encrypt(JSON.stringify(payload), sub);
      const url = new URL(sub.endpoint);
      const req = (url.protocol === "https:" ? https : http).request(url, {
        method: "POST", timeout: 15000,
        headers: { "content-type": "application/octet-stream", "content-encoding": "aes128gcm", "content-length": body.length,
          ttl: "86400", urgency: "high", authorization: vapid(sub.endpoint, keys, subject) },
      }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => resolve({ status: res.statusCode, text: text.slice(0, 300) }));
      });
      req.on("timeout", () => req.destroy(new Error("no answer in 15 s")));
      req.on("error", (e) => resolve({ status: 0, text: e.message }));
      req.end(body);
    } catch (e) { resolve({ status: 0, text: e.message }); }
  });
}

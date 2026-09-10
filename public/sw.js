// Claude Chats' service worker. It has one job: when a computer pushes a notification (Claude finished,
// or needs you), show it — and when you tap it, open that chat.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// A chat's key on the phone is "<computer>/<chat id>": "home" for the computer this app comes from,
// otherwise the computer's address with its dots turned into dashes (the same as app.js).
function keyOf(d) {
  if (!d.chat) return null;
  const from = d.url ? new URL(d.url) : null;
  return `${!from || from.origin === self.location.origin ? "home" : from.host.replace(/[^\w]/g, "-")}/${d.chat}`;
}

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data.json(); } catch {}
  const key = keyOf(d);
  e.waitUntil(self.registration.showNotification(d.title || "Claude Chats", {
    body: d.body || "", tag: d.tag || key || "claude-chat", icon: "/icon.png", data: { key },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const key = e.notification.data?.key;
  e.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (open.length) { open[0].postMessage({ open: key }); return open[0].focus(); }
    return self.clients.openWindow(key ? `/#chat/${key}` : "/");
  })());
});

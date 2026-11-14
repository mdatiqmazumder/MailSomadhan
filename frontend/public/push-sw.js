/* MailSomadhan push service worker: shows new-mail notifications sent through Firebase Cloud Messaging,
   also while no webmail tab is open. Plain Push API, no Firebase code needed here. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_) {
    payload = {};
  }
  // FCM wraps the fields we send in "data" (and a "notification" block if one was sent).
  const d = Object.assign({}, payload.notification || {}, payload.data || {});
  event.waitUntil(
    (async () => {
      if (d.kind === "mail") {
        // The webmail tab the user is looking at already shows new mail live; no need to pop up.
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        const watching = windows.some(
          (c) => c.visibilityState === "visible" && c.focused && new URL(c.url).pathname.startsWith("/mail"),
        );
        if (watching) return;
      }
      await self.registration.showNotification(d.title || "New message", {
        body: d.body || "",
        tag: d.tag || "mail",
        renotify: true,
        icon: "/notification-icon.png",
        badge: "/notification-icon.png",
        data: { url: d.url || "/mail" },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/mail", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = windows.find((c) => new URL(c.url).pathname.startsWith("/mail"));
      if (existing) {
        await existing.focus();
        if (!existing.url.startsWith(target)) await existing.navigate(target).catch(() => {});
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});

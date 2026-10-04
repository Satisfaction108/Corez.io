// Push pings only (server/accounts/push.js): "your daily reward is ready"
// and "Raid Night in 30 minutes", for players who said yes on the menu
// (client/account/retention.js registers this file then). There is no fetch
// handler on purpose: nothing is cached or intercepted, the game loads
// exactly as it does without a worker. An older version of this file cached
// pages, so any cache left behind is cleared when this one takes over.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
    e.waitUntil((async () => {
        try {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        } catch (err) { /* nothing cached */ }
        await self.clients.claim();
    })());
});

self.addEventListener("push", (e) => {
    let msg = {};
    try { msg = e.data ? e.data.json() : {}; } catch (err) { msg = {}; }
    const title = typeof msg.title === "string" && msg.title ? msg.title.slice(0, 80) : "Corez.io";
    const body = typeof msg.body === "string" ? msg.body.slice(0, 200) : "";
    const url = typeof msg.url === "string" && msg.url.charAt(0) === "/" ? msg.url : "/";
    e.waitUntil(self.registration.showNotification(title, {
        body,
        icon: "/img/icon-192.png",
        tag: typeof msg.tag === "string" ? msg.tag.slice(0, 64) : "dw",
        data: { url },
        actions: [{ action: "off", title: "Turn these off" }],
    }));
});

self.addEventListener("notificationclick", (e) => {
    e.notification.close();
    if (e.action === "off") {
        // unsubscribe here and on the server; no tab needs to open for it
        e.waitUntil((async () => {
            try {
                const sub = await self.registration.pushManager.getSubscription();
                if (!sub) return;
                await fetch("/api/push/unsubscribe", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json", "X-DW": "1" },
                    body: JSON.stringify({ endpoint: sub.endpoint }),
                });
                await sub.unsubscribe();
            } catch (err) { /* a dead subscription is dropped on its next send anyway */ }
        })());
        return;
    }
    const url = new URL((e.notification.data && e.notification.data.url) || "/", self.location.origin).href;
    e.waitUntil((async () => {
        const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const w of wins) {
            if (new URL(w.url).origin === self.location.origin && "focus" in w) return w.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow(url);
    })());
});

// Self-removing worker: unregisters itself and reloads open tabs.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", async () => {
    await self.registration.unregister();
    for (var e of await self.clients.matchAll({ type: "window" })) e.navigate(e.url);
});

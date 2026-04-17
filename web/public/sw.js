const CACHE_NAME = "koder-shell-v2";
const SHELL_ASSETS = ["/", "/index.html", "/manifest.webmanifest", "/pwa-icon.svg"];

const isSameOriginGet = (request) => request.method === "GET" && new URL(request.url).origin === self.location.origin;
const isShellAsset = (pathname) => SHELL_ASSETS.includes(pathname);
const isViteRuntimeAsset = (pathname) => pathname.startsWith("/src/") || pathname.startsWith("/@vite/") || pathname.startsWith("/node_modules/");

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (!isSameOriginGet(event.request)) {
    return;
  }

  const requestUrl = new URL(event.request.url);
  if (isViteRuntimeAsset(requestUrl.pathname)) {
    return;
  }

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/index.html", responseClone));
          return response;
        })
        .catch(async () => (await caches.match("/index.html")) ?? (await caches.match("/")))
    );
    return;
  }

  if (!isShellAsset(requestUrl.pathname)) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => (
      cachedResponse
      || fetch(event.request).then((response) => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        return response;
      })
    ))
  );
});

self.addEventListener("push", (event) => {
  const payload = safeParseJSON(event.data?.text()) || {};
  const title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title.trim()
    : "Koder";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const url = typeof payload.url === "string" && payload.url.trim() ? payload.url.trim() : "/";

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: typeof payload.tag === "string" ? payload.tag : "koder-push",
      data: { url },
      icon: "/pwa-icon.svg",
      badge: "/pwa-icon.svg",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetUrl = new URL(event.notification.data?.url || "/", self.location.origin).toString();

  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients) {
      if ("focus" in client) {
        if ("navigate" in client && client.url !== targetUrl) {
          await client.navigate(targetUrl);
        }
        await client.focus();
        return;
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

function safeParseJSON(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

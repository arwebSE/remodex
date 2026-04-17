const SW_URL = "/sw.js";

export async function registerServiceWorker(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  const shouldRegister = window.isSecureContext
    && (import.meta.env.PROD || import.meta.env.VITE_KODER_ENABLE_SW === "true");

  if (!shouldRegister) {
    await unregisterExistingServiceWorkers();
    return;
  }

  try {
    await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  } catch {
    // PWA support stays best-effort for self-hosted installs.
  }
}

async function unregisterExistingServiceWorkers(): Promise<void> {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ("caches" in window) {
      const cacheKeys = await caches.keys();
      await Promise.all(cacheKeys
        .filter((key) => key.startsWith("koder-shell-"))
        .map((key) => caches.delete(key)));
    }
  } catch {
    // Cleanup stays best-effort for local dev shells.
  }
}

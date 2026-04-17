export type NotificationPermissionState = NotificationPermission | "unsupported";

interface NotificationPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  silent?: boolean;
}

export function isStandaloneDisplayMode(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  if (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches) {
    return true;
  }

  return Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}

export function readNotificationPermissionState(): NotificationPermissionState {
  if (!canUseSystemNotifications()) {
    return "unsupported";
  }
  return Notification.permission;
}

export function canUseSystemNotifications(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function canUseAppBadges(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const badgeNavigator = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };

  return typeof badgeNavigator.setAppBadge === "function" || typeof badgeNavigator.clearAppBadge === "function";
}

export async function requestNotificationPermissionFromUser(): Promise<NotificationPermissionState> {
  if (!canUseSystemNotifications()) {
    return "unsupported";
  }

  return Notification.requestPermission();
}

export async function showSystemNotification(payload: NotificationPayload): Promise<boolean> {
  if (readNotificationPermissionState() !== "granted") {
    return false;
  }

  const registration = await readyServiceWorkerRegistration();
  const options = {
    body: payload.body,
    tag: payload.tag,
    data: {
      url: payload.url || "/",
    },
    icon: "/pwa-icon.svg",
    badge: "/pwa-icon.svg",
    silent: Boolean(payload.silent),
  };

  if (registration?.showNotification) {
    await registration.showNotification(payload.title, options);
    return true;
  }

  new Notification(payload.title, options);
  return true;
}

export async function syncAppBadge(count: number): Promise<void> {
  if (!canUseAppBadges()) {
    return;
  }

  const badgeNavigator = navigator as Navigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };

  if (count > 0 && typeof badgeNavigator.setAppBadge === "function") {
    await badgeNavigator.setAppBadge(count);
    return;
  }

  if (typeof badgeNavigator.clearAppBadge === "function") {
    await badgeNavigator.clearAppBadge();
  }
}

async function readyServiceWorkerRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }

  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

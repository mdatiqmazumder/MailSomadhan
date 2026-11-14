/** Browser side of new-mail push notifications (Firebase Cloud Messaging). Firebase is only loaded
 * when the server has notifications set up, so other pages never download it. */
import { api } from "./api";

type PushConfig = {
  enabled: boolean;
  web?: Record<string, string>;
  vapid_key?: string;
  devices?: number;
};

export type PushState = "unavailable" | "off" | "on" | "blocked";

const TOKEN_KEY = "ms.pushToken";
const SW_URL = "/push-sw.js";

function storedToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function storeToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

function browserCanPush() {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

let configPromise: Promise<PushConfig> | null = null;
function loadConfig(): Promise<PushConfig> {
  configPromise ??= api<PushConfig>("/mail/push/config").catch(() => ({ enabled: false }));
  return configPromise;
}

async function fcmToken(config: PushConfig): Promise<string> {
  const [{ initializeApp, getApps }, messaging] = await Promise.all([import("firebase/app"), import("firebase/messaging")]);
  if (!(await messaging.isSupported())) throw new Error("This browser does not support push notifications");
  const app = getApps().find((a) => a.name === "mailsomadhan") || initializeApp(config.web!, "mailsomadhan");
  const registration = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
  await navigator.serviceWorker.ready;
  return messaging.getToken(messaging.getMessaging(app), { vapidKey: config.vapid_key, serviceWorkerRegistration: registration });
}

/** Current state for the toggle; also re-registers quietly so a rotated token keeps working. */
export async function pushState(): Promise<PushState> {
  if (!browserCanPush()) return "unavailable";
  const config = await loadConfig();
  if (!config.enabled) return "unavailable";
  if (Notification.permission === "denied") return "blocked";
  if (Notification.permission !== "granted" || !storedToken()) return "off";
  try {
    const token = await fcmToken(config);
    await api("/mail/push/subscribe", { json: { token } });
    storeToken(token);
    return "on";
  } catch {
    return "off";
  }
}

/** Must run from a click: browsers only show the permission prompt for a user gesture. */
export async function enablePush(): Promise<PushState> {
  const config = await loadConfig();
  if (!config.enabled || !browserCanPush()) return "unavailable";
  const permission = await Notification.requestPermission();
  if (permission === "denied") return "blocked";
  if (permission !== "granted") return "off";
  const token = await fcmToken(config);
  await api("/mail/push/subscribe", { json: { token } });
  storeToken(token);
  return "on";
}

export async function disablePush(): Promise<void> {
  const token = storedToken();
  storeToken("");
  if (token) await api("/mail/push/unsubscribe", { json: { token } }).catch(() => {});
  try {
    const config = await loadConfig();
    if (config.enabled && browserCanPush()) {
      const [{ getApps }, messaging] = await Promise.all([import("firebase/app"), import("firebase/messaging")]);
      const app = getApps().find((a) => a.name === "mailsomadhan");
      if (app) await messaging.deleteToken(messaging.getMessaging(app));
    }
  } catch {
    /* the server forgot the token already; that is what matters */
  }
}

/** Called before signing out, so the next person on this browser does not get this mailbox's notifications. */
export async function pushSignOut(): Promise<void> {
  if (storedToken()) await disablePush();
}

import { Capacitor } from "@capacitor/core";
import { PushNotifications, type Token } from "@capacitor/push-notifications";

export interface NativePushRegistration {
  platform: "android" | "ios";
  token: string;
}

const wakeListeners = new Set<() => void>();
const pushEnabled = import.meta.env.VITE_BRIDGE_PUSH_ENABLED === "true";
let listenersInstalled = false;
let registrationPromise: Promise<NativePushRegistration | undefined> | undefined;

async function installListeners(): Promise<void> {
  if (!pushEnabled || listenersInstalled || !Capacitor.isNativePlatform()) return;
  listenersInstalled = true;
  await PushNotifications.addListener("pushNotificationReceived", () => {
    for (const listener of wakeListeners) listener();
  });
  await PushNotifications.addListener("pushNotificationActionPerformed", () => {
    for (const listener of wakeListeners) listener();
  });
}

export function onNativePushWake(listener: () => void): () => void {
  wakeListeners.add(listener);
  void installListeners();
  return () => wakeListeners.delete(listener);
}

export function nativePushRegistration(): Promise<NativePushRegistration | undefined> {
  if (registrationPromise) return registrationPromise;
  registrationPromise = (async () => {
    if (!pushEnabled || !Capacitor.isNativePlatform()) return undefined;
    await installListeners();
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive === "prompt") permission = await PushNotifications.requestPermissions();
    if (permission.receive !== "granted") return undefined;
    return new Promise<NativePushRegistration | undefined>((resolve) => {
      const timeout = setTimeout(() => resolve(undefined), 15_000);
      void PushNotifications.addListener("registration", (token: Token) => {
        clearTimeout(timeout);
        const platform = Capacitor.getPlatform();
        resolve({
          platform: platform === "ios" ? "ios" : "android",
          token: token.value,
        });
      });
      void PushNotifications.addListener("registrationError", () => {
        clearTimeout(timeout);
        resolve(undefined);
      });
      void PushNotifications.register();
    });
  })();
  return registrationPromise;
}

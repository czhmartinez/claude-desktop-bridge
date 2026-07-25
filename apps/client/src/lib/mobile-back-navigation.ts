import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor, type PluginListenerHandle } from "@capacitor/core";

export type MobileBackHandler = () => boolean;

interface MobileBackHandlerEntry {
  handler: MobileBackHandler;
  order: number;
  priority: number;
}

export interface EdgeBackPoint {
  x: number;
  y: number;
  at: number;
}

const EDGE_START_PX = 28;
const EDGE_TRIGGER_PX = 72;
const EDGE_MAX_DURATION_MS = 800;
const handlers = new Map<symbol, MobileBackHandlerEntry>();
let nextOrder = 0;

export function registerMobileBackHandler(
  handler: MobileBackHandler,
  priority = 0,
): () => void {
  const id = Symbol("mobile-back-handler");
  handlers.set(id, { handler, priority, order: nextOrder++ });
  return () => {
    handlers.delete(id);
  };
}

export function dispatchMobileBack(): boolean {
  const ordered = [...handlers.values()].sort((left, right) => (
    right.priority - left.priority || right.order - left.order
  ));
  for (const entry of ordered) {
    if (entry.handler()) return true;
  }
  return false;
}

export function isEdgeBackGesture(start: EdgeBackPoint, end: EdgeBackPoint): boolean {
  const deltaX = end.x - start.x;
  const deltaY = Math.abs(end.y - start.y);
  return (
    start.x <= EDGE_START_PX &&
    end.at - start.at <= EDGE_MAX_DURATION_MS &&
    deltaX >= EDGE_TRIGGER_PX &&
    deltaX > deltaY * 1.25
  );
}

export function installMobileBackNavigation(): () => void {
  if (!Capacitor.isNativePlatform()) return () => undefined;

  let disposed = false;
  let androidListener: PluginListenerHandle | undefined;
  let touchStart: EdgeBackPoint | undefined;

  if (Capacitor.getPlatform() === "android") {
    void CapacitorApp.addListener("backButton", () => {
      dispatchMobileBack();
    }).then((listener) => {
      if (disposed) void listener.remove();
      else androidListener = listener;
    }).catch(() => undefined);
  }

  const onTouchStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      touchStart = undefined;
      return;
    }
    const touch = event.touches[0]!;
    touchStart = touch.clientX <= EDGE_START_PX
      ? { x: touch.clientX, y: touch.clientY, at: Date.now() }
      : undefined;
  };
  const onTouchMove = (event: TouchEvent): void => {
    if (!touchStart || event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    const deltaX = touch.clientX - touchStart.x;
    const deltaY = Math.abs(touch.clientY - touchStart.y);
    if (deltaX > 12 && deltaX > deltaY) event.preventDefault();
  };
  const onTouchEnd = (event: TouchEvent): void => {
    const start = touchStart;
    touchStart = undefined;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    if (isEdgeBackGesture(start, {
      x: touch.clientX,
      y: touch.clientY,
      at: Date.now(),
    })) dispatchMobileBack();
  };
  const onTouchCancel = (): void => {
    touchStart = undefined;
  };

  if (Capacitor.getPlatform() === "ios") {
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchmove", onTouchMove, { passive: false });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchCancel, { passive: true });
  }

  return () => {
    disposed = true;
    void androidListener?.remove();
    document.removeEventListener("touchstart", onTouchStart);
    document.removeEventListener("touchmove", onTouchMove);
    document.removeEventListener("touchend", onTouchEnd);
    document.removeEventListener("touchcancel", onTouchCancel);
  };
}

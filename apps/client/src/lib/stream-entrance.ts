import { useRef } from "react";

/**
 * Above this many fresh keys in one commit we treat the change as a bulk
 * load (initial history, "load older") and skip entrance animations
 * entirely — a wall of rising cards is worse than no animation.
 */
export const STREAM_ENTRANCE_BULK_THRESHOLD = 6;

/**
 * Entrance bookkeeping for live conversation streams. Only items that
 * arrive after the current view has painted report as entering, so opening
 * a long history never replays dozens of rise-in animations. A view-key
 * change (session switch) reseeds the tracker.
 */
export class StreamEntrance {
  private seen = new Set<string>();
  private view: string | undefined;

  entering(viewKey: string | undefined, keys: readonly string[]): Set<string> {
    if (this.view !== viewKey) {
      this.view = viewKey;
      this.seen = new Set(keys);
      return new Set();
    }
    const fresh = new Set<string>();
    for (const key of keys) {
      if (!this.seen.has(key)) fresh.add(key);
    }
    for (const key of fresh) this.seen.add(key);
    if (fresh.size > STREAM_ENTRANCE_BULK_THRESHOLD) return new Set();
    return fresh;
  }
}

export function useStreamEntrance(
  viewKey: string | undefined,
  keys: readonly string[],
): (key: string) => boolean {
  const tracker = useRef<StreamEntrance | undefined>(undefined);
  if (!tracker.current) tracker.current = new StreamEntrance();
  const entering = tracker.current.entering(viewKey, keys);
  return (key: string) => entering.has(key);
}

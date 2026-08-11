import { useEffect, useState } from "react";
import { formatElapsed, type SessionActivity } from "../lib/session-activity.js";

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  return <small className="session-activity-elapsed">已持续 {formatElapsed((now - since) / 1_000)}</small>;
}

/**
 * Liveness line above the composer: pulsing dots plus what the task is
 * doing right now. Rendered only while the session is queued/running, so
 * its disappearance is itself the "task settled" signal.
 */
export function SessionActivityIndicator({ activity }: { activity?: SessionActivity | undefined }) {
  if (!activity) return null;
  return (
    <div className={`session-activity ${activity.kind}`} role="status" aria-live="polite">
      <span className="session-activity-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="session-activity-label">{activity.label}</span>
      {activity.since ? <Elapsed since={activity.since} /> : null}
    </div>
  );
}

"use client";

import { Bell, BellOff, BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { disablePush, enablePush, pushState, type PushState } from "@/lib/push";
import { cx, toast } from "@/components/ui";

/** Sidebar control for new-mail notifications. Hidden when the server has no Firebase setup or the
 * browser cannot receive push messages. */
export default function PushToggle() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    pushState().then(setState).catch(() => setState("unavailable"));
  }, []);

  if (!state || state === "unavailable") return null;

  async function turnOn() {
    setBusy(true);
    try {
      const next = await enablePush();
      setState(next);
      if (next === "on") {
        toast.ok("Notifications are on for this browser");
        api("/mail/push/test", { method: "POST" }).catch(() => {});
      } else if (next === "blocked") {
        toast.error("Notifications are blocked. Allow them in the browser's site settings, then try again.");
      }
    } catch (err) {
      toast.error((err as Error).message || "Could not turn on notifications");
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    await disablePush();
    setState("off");
    setBusy(false);
    toast.ok("Notifications are off for this browser");
  }

  if (state === "blocked") {
    return (
      <p className="mb-3 flex items-start gap-2 rounded-lg bg-sunken px-2.5 py-2 text-xs text-muted" title="Allow notifications for this site in the browser's settings">
        <BellOff className="mt-px h-3.5 w-3.5 shrink-0" /> Notifications are blocked in this browser
      </p>
    );
  }
  const on = state === "on";
  return (
    <button
      onClick={on ? turnOff : turnOn}
      disabled={busy}
      aria-pressed={on}
      title={on ? "You get a notification for new mail, even when this tab is closed. Click to turn off." : "Get a notification for new mail, even when this tab is closed"}
      className={cx(
        "mb-3 flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left text-[13px] transition-colors disabled:opacity-60",
        on ? "border-border text-muted hover:bg-hover" : "border-accent/40 bg-accent-soft font-medium text-accent hover:bg-accent-soft/70",
      )}
    >
      {on ? <BellRing className="h-4 w-4 shrink-0" /> : <Bell className="h-4 w-4 shrink-0" />}
      <span className="min-w-0 flex-1">{on ? "Notifications on" : "Turn on notifications"}</span>
    </button>
  );
}

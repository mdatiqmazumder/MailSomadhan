export type Counts = Record<"pending" | "sent" | "delivered" | "bounced" | "failed" | "skipped" | "unsubscribed", number>;

export type Campaign = {
  id: number; name: string; subject: string; status: string; mode: "instant" | "fixed" | "random";
  interval_seconds: number; random_min_seconds: number; random_max_seconds: number; unsubscribe: boolean; total: number;
  start_at: string; next_send_at: string; waiting_reason: string; created_at: string; finished_at: string | null;
  attachments: { name: string; size: number }[]; counts: Counts; owner?: string;
};

export type Limits = { daily_limit: number; used_24h: number; max_recipients: number; domain_hourly_limit: number; approval_over: number; max_attachment_mb: number };

export const STATUS_LABEL: Record<string, string> = {
  pending_approval: "Awaiting approval", scheduled: "Scheduled", running: "Sending", paused: "Paused",
  completed: "Completed", cancelled: "Cancelled", draft: "Draft",
};

export const STATUS_TONE: Record<string, "ok" | "warn" | "danger" | "muted" | "accent"> = {
  pending_approval: "warn", scheduled: "accent", running: "accent", paused: "warn", completed: "ok", cancelled: "muted",
};

export function done(c: Counts) {
  return c.sent + c.delivered + c.bounced + c.failed + c.skipped + c.unsubscribed;
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.floor(seconds / 86400);
  const h = Math.round((seconds % 86400) / 3600);
  return h ? `${d} d ${h} h` : `${d} d`;
}

export function pacing(c: Pick<Campaign, "mode" | "interval_seconds" | "random_min_seconds" | "random_max_seconds">): string {
  if (c.mode === "instant") return "As fast as allowed";
  if (c.mode === "fixed") return `One every ${duration(c.interval_seconds)}`;
  return `One every ${duration(c.random_min_seconds)}–${duration(c.random_max_seconds)} (random)`;
}

/** Average seconds between two messages. */
export function averageGap(c: Pick<Campaign, "mode" | "interval_seconds" | "random_min_seconds" | "random_max_seconds">): number {
  if (c.mode === "instant") return 1;
  if (c.mode === "fixed") return c.interval_seconds;
  return (c.random_min_seconds + c.random_max_seconds) / 2;
}

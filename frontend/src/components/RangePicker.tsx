"use client";

import { CalendarDays, Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, Input, Menu, cx } from "./ui";

export type RangeValue = { preset: string; from?: string; to?: string };

const PRESETS = [
  { id: "24h", label: "Last 24 hours", hours: 24 },
  { id: "7d", label: "Last 7 days", hours: 24 * 7 },
  { id: "30d", label: "Last 30 days", hours: 24 * 30 },
  { id: "90d", label: "Last 90 days", hours: 24 * 90 },
  { id: "mtd", label: "This month", hours: 0 },
];

const KEY = "ms.range";

function dayStart(d: string) {
  return new Date(`${d}T00:00:00`);
}

/** Converts the picker value into API query parameters (start, end, tz). */
export function rangeParams(r: RangeValue): Record<string, string> {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const now = new Date();
  let start: Date;
  let end = now;
  if (r.preset === "custom" && r.from && r.to) {
    start = dayStart(r.from);
    end = new Date(dayStart(r.to).getTime() + 86_400_000);
  } else if (r.preset === "mtd") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
  } else {
    const p = PRESETS.find((x) => x.id === r.preset) || PRESETS[1];
    start = new Date(now.getTime() - p.hours * 3_600_000);
  }
  return { start: start.toISOString(), end: end.toISOString(), tz };
}

export function rangeLabel(r: RangeValue): string {
  if (r.preset === "custom" && r.from && r.to) {
    const f = (d: string) => dayStart(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    return `${f(r.from)} – ${f(r.to)}`;
  }
  return PRESETS.find((p) => p.id === r.preset)?.label || "Last 7 days";
}

/** Range state remembered per browser. */
export function useRange() {
  const [range, setRange] = useState<RangeValue>({ preset: "7d" });
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) setRange(JSON.parse(saved));
    } catch {
      /* storage unavailable */
    }
  }, []);
  const update = (r: RangeValue) => {
    setRange(r);
    try {
      localStorage.setItem(KEY, JSON.stringify(r));
    } catch {
      /* storage unavailable */
    }
  };
  const query = useMemo(() => new URLSearchParams(rangeParams(range)).toString(), [range]);
  return { range, setRange: update, query };
}

export default function RangePicker({ value, onChange }: { value: RangeValue; onChange: (r: RangeValue) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(value.from || new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(value.to || today);
  return (
    <Menu
      trigger={(toggle) => (
        <Button onClick={toggle} aria-haspopup="menu">
          <CalendarDays className="h-4 w-4 text-muted" />
          {rangeLabel(value)}
        </Button>
      )}
    >
      {(close) => (
        <div className="w-64">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              role="menuitemradio"
              aria-checked={value.preset === p.id}
              onClick={() => {
                onChange({ preset: p.id });
                close();
              }}
              className={cx("flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover", value.preset === p.id && "font-semibold")}
            >
              {p.label}
              {value.preset === p.id && <Check className="h-4 w-4 text-accent" strokeWidth={2.5} />}
            </button>
          ))}
          <div className="mt-1 border-t border-border p-2.5">
            <p className="mb-2 text-xs font-medium text-muted">Custom range</p>
            <div className="grid grid-cols-2 gap-2">
              <Input type="date" aria-label="From" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-8 px-2 text-xs" />
              <Input type="date" aria-label="To" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className="h-8 px-2 text-xs" />
            </div>
            <Button
              size="sm"
              variant="primary"
              className="mt-2 w-full"
              disabled={!from || !to || from > to}
              onClick={() => {
                onChange({ preset: "custom", from, to });
                close();
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      )}
    </Menu>
  );
}

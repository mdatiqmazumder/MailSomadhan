"use client";

import { Table2, LineChart as LineIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "./ui";

/* Charts follow the validated categorical palette (--series-N), fixed per entity:
   sent=1, received=2, spam=3, rejected=4, bounced=5. Text always uses text tokens. */
export const SERIES = {
  sent: { label: "Sent", color: "var(--series-1)" },
  received: { label: "Received", color: "var(--series-2)" },
  spam: { label: "Spam", color: "var(--series-3)" },
  rejected: { label: "Blocked", color: "var(--series-4)" },
  bounced: { label: "Bounced", color: "var(--series-5)" },
} as const;

export function compact(n: number): string {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return n.toLocaleString();
}

function niceMax(v: number): number {
  // Four gridline steps of a "nice" size (1, 2, 5 × 10^n) so every tick is a round number.
  if (v <= 4) return 4;
  const rough = v / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const n = rough / pow;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
  return step * 4;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function formatBucket(t: string, unit: "hour" | "day", long = false): string {
  const d = new Date(t);
  if (unit === "hour") {
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return long ? `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}` : time;
  }
  return d.toLocaleDateString(undefined, long ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
}

export function Legend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] text-text-2">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: it.color }} aria-hidden />
          {it.label}
          {it.value && <span className="font-medium text-text tabular">{it.value}</span>}
        </li>
      ))}
    </ul>
  );
}

type Point = Record<string, number | string>;

/** Multi-series line chart with a crosshair tooltip and an optional table view. */
export function TimeSeriesChart({ data, keys, unit, height = 240, title }: {
  data: Point[]; keys: (keyof typeof SERIES)[]; unit: "hour" | "day"; height?: number; title: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const pad = { top: 12, right: 12, bottom: 26, left: 44 };
  const w = Math.max(width, 200);
  const innerW = w - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = useMemo(() => niceMax(Math.max(1, ...data.flatMap((d) => keys.map((k) => Number(d[k]) || 0)))), [data, keys]);
  const x = (i: number) => pad.left + (data.length <= 1 ? innerW / 2 : (i / (data.length - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(innerW / 70))));
  const totals = keys.map((k) => data.reduce((s, d) => s + (Number(d[k]) || 0), 0));

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - pad.left;
    const i = data.length <= 1 ? 0 : Math.round((px / innerW) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Legend items={keys.map((k, i) => ({ label: SERIES[k].label, color: SERIES[k].color, value: compact(totals[i]) }))} />
        <button
          onClick={() => setTable((t) => !t)}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-text"
          aria-pressed={table}
        >
          {table ? <LineIcon className="h-3.5 w-3.5" /> : <Table2 className="h-3.5 w-3.5" />}
          {table ? "Chart" : "Table"}
        </button>
      </div>
      {table ? (
        <div className="max-h-[260px] overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <caption className="sr-only">{title}</caption>
            <thead className="sticky top-0 bg-raised text-xs text-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Period</th>
                {keys.map((k) => <th key={k} className="px-3 py-2 text-right font-medium">{SERIES[k].label}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((d) => (
                <tr key={String(d.t)} className="border-t border-border">
                  <td className="px-3 py-1.5 whitespace-nowrap">{formatBucket(String(d.t), unit, true)}</td>
                  {keys.map((k) => <td key={k} className="px-3 py-1.5 text-right tabular">{Number(d[k]).toLocaleString()}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative" style={{ height }}>
          {width > 0 && (
            <svg width={w} height={height} role="img" aria-label={title} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block">
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={pad.left} x2={w - pad.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--chart-axis)" : "var(--chart-grid)"} strokeWidth={1} />
                  <text x={pad.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--muted)" className="tabular">
                    {compact(Math.round(t))}
                  </text>
                </g>
              ))}
              {data.map((d, i) =>
                i % labelEvery === 0 ? (
                  <text key={String(d.t)} x={x(i)} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
                    {formatBucket(String(d.t), unit)}
                  </text>
                ) : null,
              )}
              {keys.map((k) => {
                const path = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(Number(d[k]) || 0).toFixed(1)}`).join("");
                const area = `${path}L${x(data.length - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z`;
                return (
                  <g key={k}>
                    {keys.length === 1 && <path d={area} fill={SERIES[k].color} opacity={0.1} />}
                    <path d={path} fill="none" stroke={SERIES[k].color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  </g>
                );
              })}
              {hover !== null && (
                <g>
                  <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="var(--border-strong)" strokeWidth={1} />
                  {keys.map((k) => (
                    <circle key={k} cx={x(hover)} cy={y(Number(data[hover][k]) || 0)} r={4.5} fill={SERIES[k].color} stroke="var(--surface)" strokeWidth={2} />
                  ))}
                </g>
              )}
              <rect x={pad.left} y={pad.top} width={innerW} height={innerH} fill="transparent" />
            </svg>
          )}
          {hover !== null && data[hover] && (
            <div
              className="pointer-events-none absolute top-1 z-10 min-w-36 rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-pop"
              style={{ left: Math.min(Math.max(x(hover) + 12, 0), w - 170) }}
            >
              <p className="mb-1 font-medium text-text">{formatBucket(String(data[hover].t), unit, true)}</p>
              {keys.map((k) => (
                <p key={k} className="flex items-center justify-between gap-4 text-text-2">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full" style={{ background: SERIES[k].color }} />
                    {SERIES[k].label}
                  </span>
                  <span className="font-medium text-text tabular">{Number(data[hover][k]).toLocaleString()}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Ranked horizontal bars (single measure). */
export function BarList({ items, color = "var(--series-1)", empty = "No data for this period", onSelect, format = (n: number) => n.toLocaleString() }: {
  items: { label: string; value: number; sub?: string; key?: string }[]; color?: string; empty?: string; onSelect?: (key: string) => void; format?: (n: number) => string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length) return <p className="py-8 text-center text-sm text-muted">{empty}</p>;
  return (
    <ul className="space-y-2.5">
      {items.map((it) => {
        const content = (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
              <span className="min-w-0 truncate text-text">{it.label}</span>
              <span className="shrink-0 font-medium tabular">
                {format(it.value)}
                {it.sub && <span className="ml-1.5 font-normal text-muted">{it.sub}</span>}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
              <div className="h-full rounded-full" style={{ width: `${Math.max(2, (it.value / max) * 100)}%`, background: color }} />
            </div>
          </>
        );
        return (
          <li key={it.key || it.label} title={`${it.label}: ${it.value.toLocaleString()}`}>
            {onSelect ? (
              <button className="-mx-2 block w-[calc(100%+1rem)] rounded-lg px-2 py-1 text-left hover:bg-hover" onClick={() => onSelect(it.key || it.label)}>
                {content}
              </button>
            ) : (
              content
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One whole split into parts (thin bar + legend with values). */
export function SegmentedBar({ parts, label }: { parts: { label: string; value: number; color: string }[]; label: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div>
      <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${p.value}`).join(", ")}`}>
        {total > 0 &&
          parts.filter((p) => p.value > 0).map((p) => (
            <div key={p.label} className="h-full first:rounded-l-full last:rounded-r-full" style={{ width: `${(p.value / total) * 100}%`, background: p.color }} title={`${p.label}: ${p.value.toLocaleString()} (${((p.value / total) * 100).toFixed(1)}%)`} />
          ))}
      </div>
      <ul className="mt-3 space-y-1.5 text-[13px]">
        {parts.map((p) => (
          <li key={p.label} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-1.5 text-text-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: p.color }} aria-hidden />
              <span className="truncate">{p.label}</span>
            </span>
            <span className="font-medium tabular">
              {p.value.toLocaleString()}
              <span className="ml-1 font-normal text-muted">{total ? `${((p.value / total) * 100).toFixed(0)}%` : ""}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Day-of-week × hour-of-day activity (sequential blue ramp). */
export function Heatmap({ grid, label }: { grid: number[][]; label: string }) {
  const max = Math.max(1, ...grid.flat());
  const steps = ["var(--seq-0)", "var(--seq-1)", "var(--seq-2)", "var(--seq-3)", "var(--seq-4)", "var(--seq-5)", "var(--seq-6)"];
  const color = (v: number) => (v === 0 ? steps[0] : steps[Math.min(6, 1 + Math.floor((v / max) * 5.999))]);
  const order = [1, 2, 3, 4, 5, 6, 0];
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[560px]" role="img" aria-label={label}>
        <div className="grid grid-cols-[36px_repeat(24,minmax(0,1fr))] gap-[3px]">
          <span />
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className="text-center text-[10px] text-muted tabular">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</span>
          ))}
          {order.map((d) => (
            <div key={d} className="contents">
              <span className="pr-1 text-right text-[11px] leading-[18px] text-muted">{DAYS[d]}</span>
              {grid[d].map((v, h) => (
                <span key={h} className="h-[18px] rounded-[3px]" style={{ background: color(v) }} title={`${DAYS[d]} ${String(h).padStart(2, "0")}:00 – ${v} message${v === 1 ? "" : "s"}`} />
              ))}
            </div>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5 text-[11px] text-muted">
          Less
          {steps.map((s) => <span key={s} className="h-2.5 w-4 rounded-[2px]" style={{ background: s }} />)}
          More
        </div>
      </div>
    </div>
  );
}

export function Sparkline({ values, color = "var(--series-1)", height = 32 }: { values: number[]; color?: string; height?: number }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const max = Math.max(1, ...values);
  const w = Math.max(width, 40);
  const path = values.map((v, i) => `${i ? "L" : "M"}${((i / Math.max(1, values.length - 1)) * (w - 4) + 2).toFixed(1)},${(height - 3 - (v / max) * (height - 6)).toFixed(1)}`).join("");
  return (
    <div ref={ref} style={{ height }} aria-hidden>
      {width > 0 && values.length > 1 && (
        <svg width={w} height={height} className="block">
          <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      )}
    </div>
  );
}

export function StatTile({ label, value, hint, icon: Icon, tone, spark, sparkColor }: {
  label: string; value: string; hint?: React.ReactNode; icon?: React.ComponentType<{ className?: string }>;
  tone?: "ok" | "warn" | "danger"; spark?: number[]; sparkColor?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-muted">{label}</span>
        {Icon && <Icon className="h-4 w-4 text-faint" />}
      </div>
      <p className="mt-2 text-[26px] leading-none font-semibold tracking-tight">{value}</p>
      {hint && (
        <p className={cx("mt-2 text-xs", tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : "text-muted")}>{hint}</p>
      )}
      {spark && <div className="mt-3"><Sparkline values={spark} color={sparkColor} /></div>}
    </div>
  );
}

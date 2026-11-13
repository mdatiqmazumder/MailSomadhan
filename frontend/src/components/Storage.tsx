"use client";

import { cx } from "./ui";

export function formatMb(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

/** Used vs. allotted storage, coloured by how full it is. */
export function UsageBar({ usedKb, quotaMb, compact }: { usedKb: number | null | undefined; quotaMb: number; compact?: boolean }) {
  if (usedKb == null) return <span className="text-sm text-text-2 tabular">{formatMb(quotaMb)}</span>;
  const pct = Math.min(100, (usedKb / Math.max(1, quotaMb * 1024)) * 100);
  const tone = pct >= 95 ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-accent";
  const used = usedKb >= 1024 * 1024 ? `${(usedKb / 1024 / 1024).toFixed(1)} GB` : usedKb >= 1024 ? `${Math.round(usedKb / 1024)} MB` : `${usedKb} KB`;
  return (
    <div className={cx(compact ? "w-36" : "w-full")} title={`${used} of ${formatMb(quotaMb)} used (${pct.toFixed(0)}%)`}>
      <div className="mb-1 flex justify-between gap-2 text-xs">
        <span className="tabular">{used}</span>
        <span className="text-muted tabular">of {formatMb(quotaMb)}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${pct.toFixed(0)}% of storage used`}>
        <div className={cx("h-full rounded-full", tone)} style={{ width: `${Math.max(pct, usedKb ? 2 : 0)}%` }} />
      </div>
    </div>
  );
}

const PRESETS_MB = [512, 1024, 2048, 5120, 10240, 25600, 51200, 102400];

/**
 * Quota chooser in GB. Never offers more than the server-wide mailbox maximum or what is
 * left in the domain's storage pool; the server enforces the same rules.
 */
export function QuotaPicker({ valueMb, onChange, maxMb, availableMb, domainName, limitMb }: {
  valueMb: number; onChange: (mb: number) => void; maxMb: number; availableMb: number; domainName?: string; limitMb?: number;
}) {
  const ceiling = Math.max(0, Math.min(maxMb, availableMb));
  const presets = PRESETS_MB.filter((p) => p <= ceiling);
  const over = valueMb > ceiling;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange(p)}
            className={cx("rounded-lg border px-2.5 py-1 text-[13px] font-medium tabular transition-colors", valueMb === p ? "border-accent bg-accent-soft text-accent" : "border-border hover:bg-hover")}
          >
            {formatMb(p)}
          </button>
        ))}
        <span className="flex items-center gap-1.5">
          <input
            type="number"
            min={0.1}
            step={0.5}
            max={ceiling / 1024}
            value={Math.round((valueMb / 1024) * 100) / 100}
            onChange={(e) => onChange(Math.max(1, Math.round(Number(e.target.value) * 1024)))}
            aria-label="Quota in GB"
            className="h-8 w-20 rounded-lg border border-border bg-surface px-2 text-sm tabular focus:border-accent focus:outline-none"
          />
          <span className="text-sm text-muted">GB</span>
        </span>
      </div>
      <p className={cx("mt-1.5 text-xs", over ? "text-danger" : "text-muted")}>
        {over
          ? `Too large: at most ${formatMb(ceiling)} is possible here.`
          : `Maximum ${formatMb(ceiling)}`}
        {domainName && limitMb !== undefined && ` · ${domainName} has ${formatMb(Math.max(0, availableMb))} of ${formatMb(limitMb)} left to assign`}
        {maxMb < availableMb && ` · server limit per mailbox ${formatMb(maxMb)}`}
      </p>
    </div>
  );
}

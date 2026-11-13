"use client";

import { useEffect, useRef, useState } from "react";
import { cx } from "./ui";

/** 0 means unlimited for every storage limit (mailbox quota, domain limit, server maximum). */
export const UNLIMITED = 0;

/** An amount of storage (assigned, used). For a limit use formatLimit, where 0 means unlimited. */
export function formatMb(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${Number.isInteger(gb) ? gb : Number(gb.toFixed(2))} GB`;
  }
  return `${mb} MB`;
}

export function formatLimit(mb: number): string {
  return mb === UNLIMITED ? "Unlimited" : formatMb(mb);
}

/** The tightest of several limits (0 = unlimited). */
export function smallestLimit(...limits: number[]): number {
  const finite = limits.filter((x) => x !== UNLIMITED);
  return finite.length ? Math.min(...finite) : UNLIMITED;
}

/** True when `value` (0 = unlimited) is allowed under `limit` (0 = unlimited). */
export function fitsLimit(value: number, limit: number): boolean {
  return limit === UNLIMITED || (value !== UNLIMITED && value <= limit);
}

const gbText = (mb: number) => (mb > 0 ? String(Math.round((mb / 1024) * 1000) / 1000) : "");

/** Parse a GB amount typed by a person ("5", "5.5", "5,5", "0.5"). Returns MB, or null when not a positive number. */
export function parseGb(text: string): number | null {
  const n = Number(text.trim().replace(",", "."));
  if (!text.trim() || !Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.round(n * 1024));
}

/**
 * Storage limit in GB with an optional "Unlimited" switch. Any positive amount can be typed
 * (5, 5.5, 0.25): the browser never rejects a value for not matching a step.
 */
export function GbInput({ valueMb, onChange, allowUnlimited = true, label, id }: {
  valueMb: number; onChange: (mb: number) => void; allowUnlimited?: boolean; label: string; id?: string;
}) {
  const unlimited = valueMb === UNLIMITED;
  const [text, setText] = useState(gbText(valueMb));
  const [lastFinite, setLastFinite] = useState(valueMb || 1024);

  // Follow changes made from outside (presets, a reset after loading).
  useEffect(() => {
    if (valueMb !== UNLIMITED && parseGb(text) !== valueMb) setText(gbText(valueMb));
    if (valueMb !== UNLIMITED) setLastFinite(valueMb);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueMb]);

  const invalid = !unlimited && parseGb(text) === null;
  const ref = useRef<HTMLInputElement>(null);
  // Block form submission while the text is not a size (the last valid value would be sent otherwise).
  useEffect(() => {
    ref.current?.setCustomValidity(invalid ? "Enter a size in GB, for example 5 or 2.5." : "");
  }, [invalid]);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="flex items-center gap-1.5">
        <input
          ref={ref}
          id={id}
          type="text"
          inputMode="decimal"
          value={unlimited ? "" : text}
          disabled={unlimited}
          placeholder={unlimited ? "∞" : "GB"}
          onChange={(e) => {
            setText(e.target.value);
            const mb = parseGb(e.target.value);
            if (mb !== null) onChange(mb);
          }}
          aria-label={label}
          aria-invalid={invalid || undefined}
          className={cx(
            "h-9 w-24 rounded-lg border bg-surface px-2.5 text-sm tabular focus:outline-none disabled:bg-sunken disabled:text-muted",
            invalid ? "border-danger focus:border-danger" : "border-border focus:border-accent",
          )}
        />
        <span className="text-sm text-muted">GB</span>
      </span>
      {allowUnlimited && (
        // A button, not a <label>: this input usually sits inside a Field, which is already a label.
        <button
          type="button"
          role="checkbox"
          aria-checked={unlimited}
          onClick={(e) => {
            e.preventDefault();
            onChange(unlimited ? lastFinite : UNLIMITED);
          }}
          className="flex items-center gap-2 rounded text-sm focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span
            aria-hidden
            className={cx(
              "flex h-4 w-4 items-center justify-center rounded border text-[11px] leading-none font-bold",
              unlimited ? "border-accent bg-accent text-white" : "border-border-strong bg-surface",
            )}
          >
            {unlimited ? "✓" : ""}
          </span>
          Unlimited
        </button>
      )}
      {invalid && <span className="w-full text-xs text-danger">Enter a size in GB, for example 5 or 2.5.</span>}
    </div>
  );
}

/** Used vs. allotted storage, coloured by how full it is. */
export function UsageBar({ usedKb, quotaMb, compact }: { usedKb: number | null | undefined; quotaMb: number; compact?: boolean }) {
  if (usedKb == null) return <span className="text-sm text-text-2 tabular">{formatLimit(quotaMb)}</span>;
  const unlimited = quotaMb === UNLIMITED;
  const pct = unlimited ? 0 : Math.min(100, (usedKb / Math.max(1, quotaMb * 1024)) * 100);
  const tone = pct >= 95 ? "bg-danger" : pct >= 80 ? "bg-warn" : "bg-accent";
  const used = usedKb >= 1024 * 1024 ? `${(usedKb / 1024 / 1024).toFixed(1)} GB` : usedKb >= 1024 ? `${Math.round(usedKb / 1024)} MB` : `${usedKb} KB`;
  return (
    <div className={cx(compact ? "w-36" : "w-full")} title={unlimited ? `${used} used, no limit` : `${used} of ${formatMb(quotaMb)} used (${pct.toFixed(0)}%)`}>
      <div className="mb-1 flex justify-between gap-2 text-xs">
        <span className="tabular">{used}</span>
        <span className="text-muted tabular">{unlimited ? "Unlimited" : `of ${formatMb(quotaMb)}`}</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-sunken" role="img" aria-label={unlimited ? "No storage limit" : `${pct.toFixed(0)}% of storage used`}>
        {!unlimited && <div className={cx("h-full rounded-full", tone)} style={{ width: `${Math.max(pct, usedKb ? 2 : 0)}%` }} />}
      </div>
    </div>
  );
}

const PRESETS_MB = [512, 1024, 2048, 5120, 10240, 25600, 51200, 102400];

/**
 * Mailbox quota chooser. Never offers more than the server-wide mailbox maximum or what is
 * left in the domain's storage pool; the server enforces the same rules.
 * maxMb 0 = no server maximum; availableMb null = the domain has unlimited storage.
 */
export function QuotaPicker({ valueMb, onChange, maxMb, availableMb, domainName, limitMb }: {
  valueMb: number; onChange: (mb: number) => void; maxMb: number; availableMb: number | null; domainName?: string; limitMb?: number;
}) {
  const ceiling = smallestLimit(maxMb, availableMb === null ? UNLIMITED : Math.max(1, availableMb));
  const unlimitedAllowed = ceiling === UNLIMITED;
  const presets = PRESETS_MB.filter((p) => fitsLimit(p, ceiling));
  const over = !fitsLimit(valueMb, ceiling) && !(availableMb !== null && availableMb <= 0);
  const full = availableMb !== null && availableMb <= 0;
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
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
      </div>
      <GbInput valueMb={valueMb} onChange={onChange} allowUnlimited={unlimitedAllowed} label="Quota in GB" />
      <p className={cx("mt-1.5 text-xs", over || full ? "text-danger" : "text-muted")}>
        {full
          ? `${domainName ?? "This domain"} has no storage left to assign.`
          : over
            ? `Too large: at most ${formatMb(ceiling)} is possible here.`
            : unlimitedAllowed
              ? "Any size, or unlimited"
              : `Maximum ${formatMb(ceiling)}`}
        {domainName && limitMb !== undefined && availableMb !== null && ` · ${domainName} has ${formatMb(Math.max(0, availableMb))} of ${formatMb(limitMb)} left to assign`}
        {domainName && limitMb === UNLIMITED && ` · ${domainName} has unlimited storage`}
        {maxMb !== UNLIMITED && (availableMb === null || maxMb < availableMb) && ` · server limit per mailbox ${formatMb(maxMb)}`}      </p>
    </div>
  );
}

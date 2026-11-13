"use client";

import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronLeft, ChevronRight, CircleCheck, CircleX, Copy, Inbox, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/* ======================================================================= toast */
type Toast = { id: number; kind: "ok" | "error"; text: string };
let pushToast: ((t: Omit<Toast, "id">) => void) | null = null;

export const toast = {
  ok: (text: string) => pushToast?.({ kind: "ok", text }),
  error: (text: string) => pushToast?.({ kind: "error", text }),
};

/* ======================================================================= confirm */
type ConfirmOptions = { title: string; message?: React.ReactNode; confirmLabel?: string; danger?: boolean };
let pushConfirm: ((o: ConfirmOptions, resolve: (v: boolean) => void) => void) | null = null;

/** Styled replacement for window.confirm. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!pushConfirm) resolve(window.confirm(options.title));
    else pushConfirm(options, resolve);
  });
}

export function Toaster() {
  const [items, setItems] = useState<Toast[]>([]);
  const [confirm, setConfirm] = useState<{ o: ConfirmOptions; resolve: (v: boolean) => void } | null>(null);
  useEffect(() => {
    pushToast = (t) => {
      const id = Date.now() + Math.random();
      setItems((cur) => [...cur.slice(-3), { ...t, id }]);
      setTimeout(() => setItems((cur) => cur.filter((x) => x.id !== id)), t.kind === "error" ? 7000 : 3500);
    };
    pushConfirm = (o, resolve) => setConfirm({ o, resolve });
    return () => {
      pushToast = null;
      pushConfirm = null;
    };
  }, []);
  const close = (v: boolean) => {
    confirm?.resolve(v);
    setConfirm(null);
  };
  return (
    <>
      <div className="pointer-events-none fixed right-4 bottom-4 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="animate-pop pointer-events-auto flex items-start gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-3 text-sm shadow-modal">
            {t.kind === "ok" ? <CircleCheck className="mt-px h-4 w-4 shrink-0 text-ok" /> : <CircleX className="mt-px h-4 w-4 shrink-0 text-danger" />}
            <span className="min-w-0 flex-1 break-words">{t.text}</span>
          </div>
        ))}
      </div>
      {confirm && (
        <Modal title={confirm.o.title} onClose={() => close(false)} size="sm">
          {confirm.o.message && <div className="text-sm text-text-2">{confirm.o.message}</div>}
          <div className="mt-5 flex justify-end gap-2">
            <Button onClick={() => close(false)}>Cancel</Button>
            <Button variant={confirm.o.danger ? "danger-solid" : "primary"} onClick={() => close(true)} autoFocus>
              {confirm.o.confirmLabel || "Confirm"}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ======================================================================= buttons */
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "danger-solid" | "ghost";
  size?: "xs" | "sm" | "md";
  loading?: boolean;
};

export function Button({ variant = "secondary", size = "md", loading, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-[background,color,box-shadow] disabled:pointer-events-none disabled:opacity-50",
        size === "xs" && "h-7 px-2 text-xs",
        size === "sm" && "h-8 px-2.5 text-[13px]",
        size === "md" && "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-accent text-accent-fg shadow-card hover:bg-accent-hover",
        variant === "secondary" && "border border-border bg-surface text-text shadow-card hover:bg-hover",
        variant === "danger" && "border border-border bg-surface text-danger shadow-card hover:border-danger/40 hover:bg-danger-soft",
        variant === "danger-solid" && "bg-danger text-white shadow-card hover:opacity-90",
        variant === "ghost" && "text-text-2 hover:bg-hover hover:text-text",
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

export function IconButton({ label, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      {...rest}
      className={cx(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-text disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ======================================================================= form controls */
/** Full width unless the caller sets a width itself. */
const width = (className?: string) => (className && /(^|\s)(w-|min-w-)/.test(className) ? "" : "w-full");
const inputClass =
  "h-9 rounded-lg border border-border bg-surface px-3 text-sm text-text shadow-card placeholder:text-faint transition-shadow focus:border-accent focus:outline-none focus:ring-3 focus:ring-[var(--ring)] disabled:bg-sunken disabled:opacity-70";

export function Input({ className, ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={cx(inputClass, width(className), className)} />;
}

export function Textarea({ className, ...rest }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={cx(inputClass, "h-auto min-h-24 w-full py-2 leading-relaxed", className)} />;
}

export function Select({ className, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={cx(inputClass, width(className), "appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat pr-8", className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2369717d' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")", ...rest.style }}>
      {children}
    </select>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: React.ReactNode; error?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-medium text-text">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50", checked ? "bg-accent" : "bg-border-strong")}
    >
      <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-all", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

export function Checkbox({ checked, onChange, label, className }: { checked: boolean; onChange: (v: boolean) => void; label: string; className?: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
      className={cx("h-4 w-4 cursor-pointer rounded border-border-strong accent-[var(--accent)]", className)}
    />
  );
}

/** Pill switcher for 2–6 options. */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-lg border border-border bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            "h-7 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors",
            o.value === value ? "bg-surface text-text shadow-card" : "text-muted hover:text-text",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ======================================================================= display */
type Tone = "ok" | "danger" | "warn" | "muted" | "accent";

export function Badge({ tone = "muted", dot, children }: { tone?: Tone; dot?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap",
        tone === "ok" && "bg-ok-soft text-ok",
        tone === "danger" && "bg-danger-soft text-danger",
        tone === "warn" && "bg-warn-soft text-warn",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "muted" && "bg-sunken text-text-2",
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  delivered: "ok", sent: "ok", success: "ok", running: "ok", active: "ok",
  deferred: "warn", partial: "warn", queued: "muted", greylist: "warn",
  bounced: "danger", rejected: "danger", failed: "danger", expired: "danger",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={STATUS_TONES[status] || "muted"} dot>
      {status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ")}
    </Badge>
  );
}

export function Card({ className, children, title, description, actions, padded = false }: {
  className?: string; children: React.ReactNode; title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; padded?: boolean;
}) {
  return (
    <section className={cx("rounded-xl border border-border bg-surface shadow-card", padded && "p-5", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold">{title}</h2>}
            {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("h-5 w-5 animate-spin text-muted", className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton h-4", className)} aria-hidden />;
}

export function PageSkeleton() {
  return (
    <div className="space-y-5" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-7 w-56" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}

export function Empty({ title, children, icon: Icon = Inbox, action }: { title: string; children?: React.ReactNode; icon?: typeof Inbox; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-raised text-muted">
        <Icon className="h-5 w-5" />
      </span>
      <p className="font-semibold">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, action }: { title: string; description?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

export function Notice({ tone = "warn", title, children }: { tone?: "warn" | "danger" | "accent" | "ok"; title?: string; children: React.ReactNode }) {
  return (
    <div
      className={cx(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-sm",
        tone === "warn" && "border-warn/30 bg-warn-soft text-text",
        tone === "danger" && "border-danger/30 bg-danger-soft text-text",
        tone === "accent" && "border-accent/25 bg-accent-soft text-text",
        tone === "ok" && "border-ok/30 bg-ok-soft text-text",
      )}
    >
      <AlertTriangle className={cx("mt-0.5 h-4 w-4 shrink-0", tone === "warn" && "text-warn", tone === "danger" && "text-danger", tone === "accent" && "text-accent", tone === "ok" && "text-ok")} />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        <div className={cx(title && "mt-0.5", "text-text-2")}>{children}</div>
      </div>
    </div>
  );
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  const letters = (name.match(/\b[\p{L}\d]/gu) || ["?"]).slice(0, 2).join("").toUpperCase();
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hues = ["var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-5)", "#6250d6"];
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, fontSize: size * 0.38, background: hues[Math.abs(hash) % hues.length] }}
    >
      {letters}
    </span>
  );
}

/* ======================================================================= overlays */
export function Modal({ title, description, onClose, children, wide, size }: {
  title: string; description?: string; onClose: () => void; children: React.ReactNode; wide?: boolean; size?: "sm" | "md" | "lg";
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const width = wide || size === "lg" ? "sm:max-w-3xl" : size === "sm" ? "sm:max-w-sm" : "sm:max-w-lg";
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx("animate-pop flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-border bg-surface shadow-modal sm:rounded-2xl", width)}>
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
          </div>
          <IconButton label="Close" onClick={onClose} className="-mt-1 -mr-2">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="overflow-y-auto px-5 pb-5">{children}</div>
      </div>
    </div>
  );
}

/** Right-hand side sheet for details. */
export function Drawer({ title, subtitle, onClose, children, actions }: { title: string; subtitle?: React.ReactNode; onClose: () => void; children: React.ReactNode; actions?: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/35" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside role="dialog" aria-modal="true" aria-label={title} className="animate-slide flex h-full w-full max-w-xl flex-col border-l border-border bg-surface shadow-modal">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{title}</h2>
            {subtitle && <div className="mt-0.5 text-sm text-muted">{subtitle}</div>}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {actions}
            <IconButton label="Close" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

/** Small dropdown menu anchored to a trigger. */
export function Menu({ trigger, children, align = "right" }: { trigger: (open: () => void) => React.ReactNode; children: (close: () => void) => React.ReactNode; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div role="menu" className={cx("animate-pop absolute z-40 mt-1.5 min-w-48 rounded-xl border border-border bg-surface p-1 shadow-pop", align === "right" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, children, danger, active }: { onClick: () => void; children: React.ReactNode; danger?: boolean; active?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} className={cx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-hover", danger ? "text-danger" : "text-text")}>
      <span className="min-w-0 flex-1">{children}</span>
      {active && <Check className="h-4 w-4 text-accent" />}
    </button>
  );
}

export function CopyText({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />}
    </IconButton>
  );
}

/* ======================================================================= tables */
export type SortState = { key: string; order: "asc" | "desc" };

export function SortHeader({ label, sortKey, sort, onSort, align }: { label: string; sortKey: string; sort: SortState; onSort: (s: SortState) => void; align?: "right" }) {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.order === "asc" ? ArrowUp : ArrowDown;
  return (
    <button
      onClick={() => onSort({ key: sortKey, order: active && sort.order === "desc" ? "asc" : "desc" })}
      className={cx("inline-flex items-center gap-1 font-medium hover:text-text", active && "text-text", align === "right" && "flex-row-reverse")}
      aria-sort={active ? (sort.order === "asc" ? "ascending" : "descending") : undefined}
    >
      {label}
      <Icon className={cx("h-3.5 w-3.5", !active && "opacity-40")} />
    </button>
  );
}

/** Table wrapper that scrolls horizontally inside its own box on narrow screens. */
export function Table({ head, children, minWidth = 640, align }: { head: React.ReactNode[]; children: React.ReactNode; minWidth?: number; align?: ("left" | "right")[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-border bg-raised text-xs text-muted">
            {head.map((h, i) => (
              <th key={i} className={cx("px-4 py-2.5 font-medium whitespace-nowrap first:pl-5 last:pr-5", align?.[i] === "right" && "text-right")}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-border [&>tr:last-child]:border-0 [&>tr]:transition-colors [&>tr:hover]:bg-raised [&_td]:px-4 [&_td]:py-3 [&_td:first-child]:pl-5 [&_td:last-child]:pr-5">
          {children}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, size, total, onPage }: { page: number; size: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (total <= size) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3 text-[13px] text-muted">
      <span className="tabular">
        {((page - 1) * size + 1).toLocaleString()}–{Math.min(page * size, total).toLocaleString()} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        <IconButton label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </IconButton>
        <span className="tabular px-1">
          Page {page} of {pages}
        </span>
        <IconButton label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          <ChevronRight className="h-4 w-4" />
        </IconButton>
      </div>
    </div>
  );
}

/* ======================================================================= tabs */
export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string; count?: number }[] }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
          className={cx(
            "-mb-px flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
            t.value === value ? "border-accent text-text" : "border-transparent text-muted hover:text-text",
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-md bg-sunken px-1.5 text-xs text-muted tabular">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

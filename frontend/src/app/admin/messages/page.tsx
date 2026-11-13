"use client";

import { ArrowDownLeft, ArrowRightLeft, ArrowUpRight, Download, Filter, Paperclip, RefreshCw, Repeat, ScrollText, Search, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, formatBytes, formatDate, useLoad } from "@/lib/api";
import RangePicker, { useRange } from "@/components/RangePicker";
import { Badge, Button, Card, Checkbox, CopyText, Drawer, Empty, Input, Notice, PageHeader, Pagination, Select, Skeleton, StatusBadge, Table, cx } from "@/components/ui";

type Row = {
  id: number; queue_id: string | null; created_at: string; direction: string; status: string; source: string; sender: string; user: string;
  subject: string; size: number; recipients: string[]; recipient_count: number; spam_score: number | null; spam_action: string;
  has_attachment: boolean; client_ip: string;
};
type Detail = Row & {
  finished_at: string | null; client_host: string; sasl_user: string; message_id: string; reason: string; spam_symbols: string[];
  deliveries: { recipient: string; orig_recipient: string; status: string; dsn: string; relay: string; delay: number; response: string; local: boolean; updated_at: string }[];
};

const DIRECTION = {
  outbound: { label: "Outbound", icon: ArrowUpRight },
  inbound: { label: "Inbound", icon: ArrowDownLeft },
  internal: { label: "Internal", icon: ArrowRightLeft },
  forward: { label: "Forwarded", icon: Repeat },
} as Record<string, { label: string; icon: typeof ArrowUpRight }>;

const SOURCE: Record<string, string> = { smtp: "Internet (SMTP)", submission: "Mail app (SMTP auth)", webmail: "Webmail", local: "Server" };
const SIZE = 50;

export default function MessageLog() {
  const { range, setRange, query } = useRange();
  const features = useLoad<{ track_subjects: boolean }>("/admin/features");
  const domains = useLoad<{ id: number; name: string }[]>("/admin/domains");
  const [filters, setFilters] = useState({ direction: "", status: "", domain: "", q: "", sender: "", recipient: "", user: "", spam: false, attachment: false });
  const [draft, setDraft] = useState({ q: "", sender: "", recipient: "" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; items: Row[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<Detail | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const user = new URLSearchParams(window.location.search).get("user");
    if (user) setFilters((f) => ({ ...f, user }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const p = new URLSearchParams({ page: String(page), size: String(SIZE) });
    Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, String(v)); });
    api<{ total: number; items: Row[] }>(`/admin/messages?${query}&${p}`)
      .then((r) => { if (!cancelled) { setData(r); setError(""); } })
      .catch((e) => !cancelled && setError((e as Error).message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [query, filters, page, tick]);

  const set = (patch: Partial<typeof filters>) => { setFilters((f) => ({ ...f, ...patch })); setPage(1); };
  const applyText = (e: React.FormEvent) => { e.preventDefault(); set(draft); };
  const active = Object.entries(filters).filter(([, v]) => v);

  async function openRow(id: number) {
    try {
      setOpen(await api<Detail>(`/admin/messages/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Message log"
        description="Every message the server handled: who sent it, where it went, and what happened."
        action={
          <>
            <RangePicker value={range} onChange={(r) => { setRange(r); setPage(1); }} />
            <Button onClick={() => setTick((t) => t + 1)} aria-label="Refresh"><RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} /></Button>
            <a href={`/api/admin/reports/messages.csv?${query}${filters.domain ? `&domain=${encodeURIComponent(filters.domain)}` : ""}`}>
              <Button><Download className="h-4 w-4" /> Export</Button>
            </a>
          </>
        }
      />

      {features.data && !features.data.track_subjects && (
        <div className="mb-4">
          <Notice tone="accent">
            Subjects are not recorded. Turn on <b>Record subjects</b> on the <Link href="/admin/spam" className="font-medium text-accent underline">Spam filter</Link> page if your policy allows it.
          </Notice>
        </div>
      )}

      <Card>
        <form onSubmit={applyText} className="grid gap-2 border-b border-border px-5 py-3 md:grid-cols-[1.4fr_1fr_1fr_auto]">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint" />
            <Input value={draft.q} onChange={(e) => setDraft({ ...draft, q: e.target.value })} placeholder="Subject, queue ID, message ID or IP" aria-label="Search" className="pl-9" />
          </div>
          <Input value={draft.sender} onChange={(e) => setDraft({ ...draft, sender: e.target.value })} placeholder="From (sender)" aria-label="Sender" />
          <Input value={draft.recipient} onChange={(e) => setDraft({ ...draft, recipient: e.target.value })} placeholder="To (recipient)" aria-label="Recipient" />
          <Button type="submit" variant="primary"><Filter className="h-4 w-4" /> Apply</Button>
        </form>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-2.5">
          <Select value={filters.direction} onChange={(e) => set({ direction: e.target.value })} aria-label="Direction" className="h-8 w-auto text-[13px]">
            <option value="">All directions</option>
            {Object.entries(DIRECTION).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
          <Select value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status" className="h-8 w-auto text-[13px]">
            <option value="">All statuses</option>
            {["delivered", "deferred", "bounced", "rejected", "queued"].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
          </Select>
          <Select value={filters.domain} onChange={(e) => set({ domain: e.target.value })} aria-label="Domain" className="h-8 w-auto text-[13px]">
            <option value="">All domains</option>
            {domains.data?.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
          </Select>
          <label className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[13px]">
            <Checkbox checked={filters.spam} onChange={(v) => set({ spam: v })} label="Spam only" /> Spam only
          </label>
          <label className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-[13px]">
            <Checkbox checked={filters.attachment} onChange={(v) => set({ attachment: v })} label="With attachments" /> With attachments
          </label>
          {active.length > 0 && (
            <button
              className="ml-auto inline-flex items-center gap-1 text-[13px] text-muted hover:text-text"
              onClick={() => { setDraft({ q: "", sender: "", recipient: "" }); set({ direction: "", status: "", domain: "", q: "", sender: "", recipient: "", user: "", spam: false, attachment: false }); }}
            >
              <X className="h-3.5 w-3.5" /> Clear filters
            </button>
          )}
        </div>
        {filters.user && (
          <div className="flex items-center gap-2 border-b border-border px-5 py-2 text-[13px]">
            Sent by <Badge tone="accent">{filters.user}</Badge>
            <button onClick={() => set({ user: "" })} aria-label="Remove user filter" className="text-muted hover:text-text"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        {error ? (
          <div className="p-5"><Notice tone="danger">{error}</Notice></div>
        ) : loading && !data ? (
          <div className="space-y-3 p-5">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-9" />)}</div>
        ) : !data?.items.length ? (
          <Empty icon={ScrollText} title="No messages found">Widen the date range or clear some filters.</Empty>
        ) : (
          <div className={cx(loading && "opacity-60 transition-opacity")}>
            <Table minWidth={1000} head={["Time", "", "From", "To", "Subject", "Status", "Spam", "Size"]} align={["left", "left", "left", "left", "left", "left", "right", "right"]}>
              {data.items.map((m) => {
                const D = DIRECTION[m.direction] || DIRECTION.inbound;
                return (
                  <tr key={m.id} onClick={() => openRow(m.id)} className="cursor-pointer">
                    <td className="whitespace-nowrap text-text-2 tabular">{formatDate(m.created_at, true)}</td>
                    <td><span title={D.label} className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-sunken text-muted"><D.icon className="h-3.5 w-3.5" /></span></td>
                    <td className="max-w-52"><span className="block truncate">{m.sender || <span className="text-faint">(empty sender)</span>}</span></td>
                    <td className="max-w-56">
                      <span className="block truncate">{m.recipients[0] || "—"}</span>
                      {m.recipient_count > 1 && <span className="text-xs text-muted">+{m.recipient_count - 1} more</span>}
                    </td>
                    <td className="max-w-72">
                      <span className="flex items-center gap-1.5">
                        {m.has_attachment && <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="Has attachment" />}
                        <span className="truncate text-text-2">{m.subject || <span className="text-faint">—</span>}</span>
                      </span>
                    </td>
                    <td><StatusBadge status={m.status} /></td>
                    <td className={cx("text-right tabular", m.spam_score != null && m.spam_score >= 6 ? "font-medium text-danger" : "text-text-2")}>{m.spam_score == null ? "—" : m.spam_score.toFixed(1)}</td>
                    <td className="text-right whitespace-nowrap text-text-2 tabular">{m.size ? formatBytes(m.size) : "—"}</td>
                  </tr>
                );
              })}
            </Table>
            <Pagination page={page} size={SIZE} total={data.total} onPage={setPage} />
          </div>
        )}
      </Card>

      {open && <MessageDrawer msg={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Row({ label, children, copy }: { label: string; children: React.ReactNode; copy?: string }) {
  return (
    <div className="grid grid-cols-[120px_1fr] gap-3 py-2 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="flex min-w-0 items-start gap-1 break-all">{children}{copy && <span className="-my-1.5"><CopyText value={copy} /></span>}</dd>
    </div>
  );
}

function MessageDrawer({ msg, onClose }: { msg: Detail; onClose: () => void }) {
  const D = DIRECTION[msg.direction] || DIRECTION.inbound;
  return (
    <Drawer title={msg.subject || "(no subject recorded)"} subtitle={<span className="flex items-center gap-2"><StatusBadge status={msg.status} /> {D.label} · {formatDate(msg.created_at, true)}</span>} onClose={onClose}>
      {msg.reason && <div className="mb-4"><Notice tone="danger" title="Refused">{msg.reason}</Notice></div>}
      <dl className="divide-y divide-border">
        <Row label="From" copy={msg.sender}>{msg.sender || "(empty)"}</Row>
        {msg.user && <Row label="Sent by user"><Link className="text-accent hover:underline" href={`/admin/analytics/${encodeURIComponent(msg.user)}`}>{msg.user}</Link></Row>}
        <Row label="Submitted via">{SOURCE[msg.source] || msg.source}</Row>
        <Row label="Client">{msg.client_host ? `${msg.client_host} [${msg.client_ip}]` : msg.client_ip || "—"}</Row>
        <Row label="Size">{msg.size ? formatBytes(msg.size) : "—"}{msg.has_attachment && <Badge>attachment</Badge>}</Row>
        {msg.queue_id && <Row label="Queue ID" copy={msg.queue_id}><code className="text-[13px]">{msg.queue_id}</code></Row>}
        {msg.message_id && <Row label="Message-ID" copy={msg.message_id}><code className="text-[12px]">{msg.message_id}</code></Row>}
        <Row label="Spam score">{msg.spam_score == null ? "Not scanned" : `${msg.spam_score.toFixed(2)} (${msg.spam_action})`}</Row>
      </dl>

      <h3 className="mt-6 mb-2 text-sm font-semibold">Delivery ({msg.deliveries.length})</h3>
      <ul className="space-y-2">
        {msg.deliveries.map((d) => (
          <li key={d.recipient} className="rounded-lg border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 font-medium break-all">{d.recipient}</span>
              <StatusBadge status={d.status} />
            </div>
            {d.orig_recipient && d.orig_recipient !== d.recipient && <p className="mt-0.5 text-xs text-muted">via alias {d.orig_recipient}</p>}
            <p className="mt-1.5 text-xs text-muted">
              {d.local ? "Local mailbox" : d.relay || "—"}
              {d.dsn && ` · DSN ${d.dsn}`}
              {d.delay ? ` · ${d.delay}s` : ""}
            </p>
            {d.response && <p className="mt-1.5 rounded-md bg-raised px-2 py-1.5 font-mono text-[11.5px] break-words text-text-2">{d.response}</p>}
          </li>
        ))}
      </ul>

      {msg.spam_symbols.length > 0 && (
        <>
          <h3 className="mt-6 mb-2 text-sm font-semibold">Spam filter checks</h3>
          <div className="flex flex-wrap gap-1.5">
            {msg.spam_symbols.map((s) => <code key={s} className="rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-text-2">{s}</code>)}
          </div>
        </>
      )}
    </Drawer>
  );
}

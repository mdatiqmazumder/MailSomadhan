"use client";

import { ArrowLeft, Ban, Clock, Pause, Play, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, formatDate } from "@/lib/api";
import { type Campaign, STATUS_LABEL, STATUS_TONE, averageGap, done, duration, pacing } from "@/lib/campaign";
import { SegmentedBar, SERIES } from "@/components/charts";
import { Badge, Button, Card, Notice, PageSkeleton, Pagination, StatusBadge, Table, Tabs, confirmDialog, toast } from "@/components/ui";

type Detail = Campaign & {
  html: string;
  recipients: { total: number; page: number; size: number; items: { id: number; email: string; fields: Record<string, string>; status: string; sent_at: string | null; error: string }[] };
};

/** Shared by the webmail (own campaigns) and the admin console (base "/admin"). */
export function CampaignDetail({ base, backHref, admin }: { base: string; backHref: string; admin?: boolean }) {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<Detail | null>(null);
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<Detail>(`${base}/campaigns/${id}?page=${page}&status=${status}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, [base, id, page, status]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!data || !["running", "scheduled"].includes(data.status)) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [data, load]);

  async function act(action: string) {
    if (action === "cancel" && !(await confirmDialog({ title: "Cancel this campaign?", message: "Emails not yet sent will not be sent. This cannot be undone.", confirmLabel: "Cancel campaign", danger: true }))) return;
    try {
      await api(`${base}/campaigns/${id}/${action}`, { method: "POST" });
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!data) return <PageSkeleton />;
  const c = data.counts;
  const finished = done(c);
  const remaining = c.pending;
  const active = ["running", "scheduled"].includes(data.status);

  return (
    <>
      <Link href={backHref} className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text"><ArrowLeft className="h-4 w-4" /> Campaigns</Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-2 text-[22px] font-semibold tracking-tight">
            {data.name || data.subject}
            <Badge tone={STATUS_TONE[data.status] || "muted"} dot>{STATUS_LABEL[data.status] || data.status}</Badge>
          </h1>
          <p className="mt-1 text-sm text-muted">
            {admin && data.owner ? `${data.owner} · ` : ""}Subject “{data.subject}” · {pacing(data)} · created {formatDate(data.created_at, true)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={load} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></Button>
          {admin && data.status === "pending_approval" && <Button variant="primary" onClick={() => act("approve")}><Play className="h-4 w-4" /> Approve</Button>}
          {(active || (data.status === "pending_approval" && !admin)) && <Button onClick={() => act("pause")}><Pause className="h-4 w-4" /> Pause</Button>}
          {data.status === "paused" && <Button variant="primary" onClick={() => act("resume")}><Play className="h-4 w-4" /> Resume</Button>}
          {!["completed", "cancelled"].includes(data.status) && <Button variant="danger" onClick={() => act("cancel")}><Ban className="h-4 w-4" /> Cancel</Button>}
        </div>
      </div>

      {data.waiting_reason && !["completed", "cancelled"].includes(data.status) && (
        <div className="mb-5"><Notice tone={data.status === "pending_approval" ? "warn" : "accent"}>{data.waiting_reason}</Notice></div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <Card padded>
          <div className="mb-2 flex items-baseline justify-between">
            <p className="text-sm text-muted">Progress</p>
            <p className="text-sm"><b className="text-lg tabular">{finished}</b> <span className="text-muted">of {data.total}</span></p>
          </div>
          <SegmentedBar
            label="Recipient status"
            parts={[
              { label: "Delivered", value: c.delivered, color: SERIES.sent.color },
              { label: "Sent, awaiting result", value: c.sent, color: SERIES.received.color },
              { label: "Bounced or failed", value: c.bounced + c.failed, color: SERIES.bounced.color },
              { label: "Skipped or unsubscribed", value: c.skipped + c.unsubscribed, color: SERIES.rejected.color },
              { label: "Waiting", value: c.pending, color: "var(--border-strong)" },
            ]}
          />
        </Card>
        <Card padded>
          <dl className="space-y-2.5 text-sm">
            <div className="flex justify-between gap-3"><dt className="text-muted">Started</dt><dd>{formatDate(data.start_at, true)}</dd></div>
            {active && remaining > 0 && (
              <>
                <div className="flex justify-between gap-3"><dt className="flex items-center gap-1 text-muted"><Clock className="h-3.5 w-3.5" /> Next email</dt><dd>{formatDate(data.next_send_at, true)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-muted">Time left</dt><dd>≈ {duration(Math.max(0, remaining - 1) * averageGap(data))}</dd></div>
              </>
            )}
            {data.finished_at && <div className="flex justify-between gap-3"><dt className="text-muted">Finished</dt><dd>{formatDate(data.finished_at, true)}</dd></div>}
            <div className="flex justify-between gap-3"><dt className="text-muted">Unsubscribe link</dt><dd>{data.unsubscribe ? "Included" : "Not included"}</dd></div>
            {data.attachments.length > 0 && <div className="flex justify-between gap-3"><dt className="text-muted">Attachments</dt><dd className="truncate text-right">{data.attachments.map((a) => a.name).join(", ")}</dd></div>}
          </dl>
        </Card>
      </div>

      <Card className="mt-5">
        <div className="px-5 pt-2">
          <Tabs
            value={status}
            onChange={(v) => { setStatus(v); setPage(1); }}
            tabs={[
              { value: "", label: "All", count: data.total },
              { value: "pending", label: "Waiting", count: c.pending },
              { value: "sent", label: "Sent", count: c.sent },
              { value: "delivered", label: "Delivered", count: c.delivered },
              { value: "bounced", label: "Bounced", count: c.bounced },
              { value: "failed", label: "Failed", count: c.failed },
              { value: "unsubscribed", label: "Unsubscribed", count: c.unsubscribed },
              { value: "skipped", label: "Skipped", count: c.skipped },
            ]}
          />
        </div>
        <Table head={["Recipient", "Status", "Sent", "Details"]} minWidth={680}>
          {data.recipients.items.map((r) => (
            <tr key={r.id}>
              <td>
                <span className="block font-medium">{r.fields.name || r.email}</span>
                {r.fields.name && <span className="text-xs text-muted">{r.email}</span>}
              </td>
              <td><StatusBadge status={r.status === "pending" ? "queued" : r.status} /></td>
              <td className="whitespace-nowrap text-text-2">{r.sent_at ? formatDate(r.sent_at, true) : "—"}</td>
              <td className="max-w-80 text-xs break-words text-muted">{r.error || (r.fields.company ? r.fields.company : "")}</td>
            </tr>
          ))}
        </Table>
        {!data.recipients.items.length && <p className="px-5 py-8 text-center text-sm text-muted">Nobody in this list.</p>}
        <Pagination page={page} size={data.recipients.size} total={data.recipients.total} onPage={setPage} />
      </Card>
    </>
  );
}

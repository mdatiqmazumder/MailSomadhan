"use client";

import { CheckCircle2, Clock, Inbox, PenLine, RefreshCw, Send, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, formatBytes, formatDate } from "@/lib/api";
import UserShell from "@/components/UserShell";
import { BarList, Heatmap, SERIES, SegmentedBar, StatTile, TimeSeriesChart, compact } from "@/components/charts";
import RangePicker, { useRange } from "@/components/RangePicker";
import { Button, Card, Empty, Notice, PageSkeleton, StatusBadge, Table, cx } from "@/components/ui";

type Stats = {
  metrics: Record<string, number> & { last_sent: string | null };
  series: { t: string; sent: number; received: number; bounced: number }[];
  heatmap: number[][];
  top_recipients: { recipient: string; count: number; external: boolean }[];
  top_domains: { domain: string; count: number }[];
  statuses: Record<string, number>;
  range: { unit: "hour" | "day" };
  recent: { id: number; created_at: string; subject: string; status: string; recipients: string[]; recipient_count: number; reason: string }[];
  campaign: { daily_limit: number; used_24h: number } | null;
};

export default function MyDashboard() {
  return <UserShell>{(me) => <DashboardBody name={me.display_name || me.email.split("@")[0]} />}</UserShell>;
}

function DashboardBody({ name }: { name: string }) {
  const { range, setRange, query } = useRange();
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setData(await api<Stats>(`/mail/stats?${query}`));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  if (!data && loading) return <PageSkeleton />;
  const m = data?.metrics;
  const st = data?.statuses || {};
  const delivered = st.delivered || 0;
  const bounced = (st.bounced || 0) + (st.partial || 0);
  const finished = delivered + bounced;
  const rate = finished ? Math.round((delivered / finished) * 1000) / 10 : null;
  const series = data?.series || [];
  const camp = data?.campaign;
  const campPct = camp && camp.daily_limit ? Math.min(100, Math.round((camp.used_24h / camp.daily_limit) * 100)) : 0;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight">Hello, {name}</h1>
          <p className="mt-0.5 text-sm text-muted">How the mail you sent is doing: what was delivered, what bounced and what is still on its way.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <RangePicker value={range} onChange={setRange} />
          <Button onClick={load} aria-label="Refresh"><RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} /></Button>
          <Link href="/mail"><Button variant="primary"><Inbox className="h-4 w-4" /> Open inbox</Button></Link>
        </div>
      </div>

      {error && <div className="mb-4"><Notice tone="danger">{error}</Notice></div>}
      {m && m.sent >= 10 && m.bounce_rate >= 5 && (
        <div className="mb-5">
          <Notice tone="warn" title={`${m.bounce_rate}% of your mail bounced`}>
            Many bounces usually mean outdated or mistyped addresses. Remove them before sending again: a high bounce rate can get your mail treated as spam.
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Sent" icon={Send} value={compact(m?.sent || 0)} hint={`${compact(m?.recipients || 0)} recipients`} spark={series.map((s) => s.sent)} sparkColor={SERIES.sent.color} />
        <StatTile label="Delivered" icon={CheckCircle2} value={compact(delivered)} hint={rate == null ? "Nothing finished yet" : `${rate}% success`} tone={rate == null ? undefined : rate >= 97 ? "ok" : rate >= 90 ? "warn" : "danger"} />
        <StatTile label="Bounced" icon={TriangleAlert} value={compact(bounced)} hint={`${m?.bounce_rate ?? 0}% of sent`} tone={bounced > 0 ? "warn" : undefined} spark={series.map((s) => s.bounced)} sparkColor={SERIES.bounced.color} />
        <StatTile label="Delayed" icon={Clock} value={compact(m?.deferred || 0)} hint={(st.queued || 0) > 0 ? `${st.queued} still queued` : "Retried automatically"} />
        <StatTile label="Received" icon={Inbox} value={compact(m?.received || 0)} hint={`${compact(m?.spam_received || 0)} went to Spam`} spark={series.map((s) => s.received)} sparkColor={SERIES.received.color} />
        {camp ? (
          <StatTile label="Campaign quota" icon={PenLine} value={`${camp.used_24h} / ${camp.daily_limit}`} hint={`${Math.max(0, camp.daily_limit - camp.used_24h)} left in the last 24 hours`} tone={campPct >= 90 ? "warn" : undefined} />
        ) : (
          <StatTile label="Volume sent" value={formatBytes(m?.bytes_sent || 0)} hint={m?.last_sent ? `last ${formatDate(m.last_sent)}` : "Nothing sent"} />
        )}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Activity" description="Mail you sent, received and that bounced" className="xl:col-span-2">
          <div className="p-5">
            <TimeSeriesChart title="Your mail activity" data={series} keys={["sent", "received", "bounced"]} unit={data?.range.unit || "day"} />
          </div>
        </Card>
        <Card title="Outcome of sent mail">
          <div className="p-5">
            <SegmentedBar
              label="Outcome of sent mail"
              parts={[
                { label: "Delivered", value: delivered, color: SERIES.sent.color },
                { label: "Delayed", value: st.deferred || 0, color: SERIES.spam.color },
                { label: "Blocked", value: st.rejected || 0, color: SERIES.rejected.color },
                { label: "Bounced", value: bounced, color: SERIES.bounced.color },
              ]}
            />
            <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4 text-[13px]">
              <div><dt className="text-muted">Outside recipients</dt><dd className="mt-0.5 text-base font-semibold">{compact(m?.external_recipients || 0)}</dd></div>
              <div><dt className="text-muted">With attachments</dt><dd className="mt-0.5 text-base font-semibold">{compact(m?.with_attachments || 0)}</dd></div>
              <div><dt className="text-muted">Blocked</dt><dd className="mt-0.5 text-base font-semibold">{compact(m?.blocked || 0)}</dd></div>
              <div><dt className="text-muted">Last sent</dt><dd className="mt-0.5 text-base font-semibold">{m?.last_sent ? formatDate(m.last_sent) : "—"}</dd></div>
            </dl>
          </div>
        </Card>
      </div>

      <Card title="Recent sent mail" description="Your latest outgoing messages and what happened to them" className="mt-5">
        {data?.recent.length ? (
          <Table head={["Sent", "To", "Subject", "Status"]} minWidth={720}>
            {data.recent.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap text-muted">{formatDate(r.created_at, true)}</td>
                <td className="max-w-56">
                  <span className="block truncate" title={r.recipients.join(", ")}>{r.recipients.join(", ") || "—"}</span>
                  {r.recipient_count > r.recipients.length && <span className="text-xs text-muted">+{r.recipient_count - r.recipients.length} more</span>}
                </td>
                <td className="max-w-72">
                  <span className="block truncate">{r.subject || "(no subject)"}</span>
                  {r.reason && <span className="block truncate text-xs text-danger" title={r.reason}>{r.reason}</span>}
                </td>
                <td><StatusBadge status={r.status === "partial" ? "bounced" : r.status} /></td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty title="Nothing sent in this period" icon={Send}>Mail you send from the webmail or an email app shows up here.</Empty>
        )}
      </Card>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <Card title="Who you write to most">
          <div className="p-5">
            <BarList items={(data?.top_recipients || []).map((r) => ({ label: r.recipient, value: r.count, sub: r.external ? undefined : "internal" }))} empty="Nothing sent in this period" />
          </div>
        </Card>
        <Card title="Top outside domains">
          <div className="p-5">
            <BarList items={(data?.top_domains || []).map((d) => ({ label: d.domain, value: d.count }))} color={SERIES.received.color} empty="No outside mail in this period" />
          </div>
        </Card>
      </div>

      <Card title="When you send mail" description="By day of week and hour of day" className="mt-5">
        <div className="p-5">
          <Heatmap grid={data?.heatmap || Array.from({ length: 7 }, () => Array(24).fill(0))} label="Your sending activity by weekday and hour" />
        </div>
      </Card>
    </>
  );
}

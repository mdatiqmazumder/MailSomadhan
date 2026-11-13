"use client";

import { ArrowUpRight, CheckCircle2, HardDrive, Inbox, ListOrdered, RefreshCw, Send, ShieldCheck, TriangleAlert, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, formatBytes, useLoad } from "@/lib/api";
import { useAdmin } from "@/lib/admin";
import { BarList, SERIES, SegmentedBar, StatTile, TimeSeriesChart, compact } from "@/components/charts";
import RangePicker, { useRange } from "@/components/RangePicker";
import { Badge, Button, Card, Notice, PageHeader, PageSkeleton, Select, cx } from "@/components/ui";

type Overview = {
  range: { unit: "hour" | "day" };
  totals: Record<string, number> & { delivery_rate: number | null };
  series: { t: string; sent: number; received: number; rejected: number; bounced: number; spam: number }[];
  top_senders: { email: string; sent: number; bounced: number; external: number }[];
  top_destinations: { domain: string; count: number }[];
  top_inbound_sources: { domain: string; count: number }[];
};
type Stats = {
  domains: number; mailboxes: number; queue: number; primary_host: string;
  services: { name: string; active: boolean; disabled?: boolean }[];
  disk: { total: number; used: number; free: number };
};

export default function Dashboard() {
  const router = useRouter();
  const { range, setRange, query } = useRange();
  const [domain, setDomain] = useState("");
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const { isSuper } = useAdmin();
  const stats = useLoad<Stats>(isSuper ? "/admin/stats" : null);
  const domains = useLoad<{ id: number; name: string }[]>("/admin/domains");

  async function load() {
    setLoading(true);
    try {
      setData(await api<Overview>(`/admin/analytics/overview?${query}${domain ? `&domain=${encodeURIComponent(domain)}` : ""}`));
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
  }, [query, domain]);

  if (!data && loading) return <PageSkeleton />;
  const t = data?.totals;
  const series = data?.series || [];
  const sentTotal = (t?.outbound || 0) + (t?.internal || 0);
  const threats = (t?.spam_junked || 0) + (t?.rejected || 0);
  const down = stats.data?.services.filter((s) => !s.active && !s.disabled) || [];
  const diskPct = stats.data?.disk.total ? Math.round((stats.data.disk.used / stats.data.disk.total) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={stats.data ? `Mail traffic and health for ${stats.data.primary_host}` : "Mail traffic and server health"}
        action={
          <>
            <Select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain" className="w-auto min-w-40">
              <option value="">All domains</option>
              {domains.data?.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </Select>
            <RangePicker value={range} onChange={setRange} />
            <Button onClick={() => { load(); stats.reload(); }} aria-label="Refresh">
              <RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} />
            </Button>
          </>
        }
      />

      {error && <div className="mb-4"><Notice tone="danger">{error}</Notice></div>}
      {stats.data?.domains === 0 && (
        <div className="mb-5">
          <Notice tone="accent" title="Finish setting up">
            <Link className="font-medium text-accent underline" href="/admin/domains">Add your first domain</Link>, publish the DNS records it shows, then{" "}
            <Link className="font-medium text-accent underline" href="/admin/mailboxes">create mailboxes</Link> and issue a trusted certificate under{" "}
            <Link className="font-medium text-accent underline" href="/admin/hosts">Hosts &amp; TLS</Link>.
          </Notice>
        </div>
      )}
      {down.length > 0 && (
        <div className="mb-5">
          <Notice tone="danger" title={`${down.length} service${down.length > 1 ? "s are" : " is"} not running`}>
            {down.map((s) => s.name).join(", ")}. Mail may be delayed until {down.length > 1 ? "they are" : "it is"} restarted (<code>sudo mailsomadhan restart</code>).
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Sent" icon={Send} value={compact(sentTotal)} hint={`${compact(t?.outbound || 0)} external · ${compact(t?.internal || 0)} internal`} spark={series.map((s) => s.sent)} sparkColor={SERIES.sent.color} />
        <StatTile label="Received" icon={Inbox} value={compact(t?.inbound || 0)} hint="Delivered to mailboxes" spark={series.map((s) => s.received)} sparkColor={SERIES.received.color} />
        <StatTile
          label="Delivery rate"
          icon={CheckCircle2}
          value={t?.delivery_rate == null ? "—" : `${t.delivery_rate}%`}
          hint={t?.delivery_rate == null ? "No outgoing mail yet" : t.delivery_rate >= 97 ? "Healthy" : t.delivery_rate >= 90 ? "Watch bounces" : "Investigate bounces"}
          tone={t?.delivery_rate == null ? undefined : t.delivery_rate >= 97 ? "ok" : t.delivery_rate >= 90 ? "warn" : "danger"}
        />
        <StatTile label="Threats stopped" icon={ShieldCheck} value={compact(threats)} hint={`${compact(t?.rejected || 0)} blocked · ${compact(t?.spam_junked || 0)} to Junk`} spark={series.map((s) => s.spam + s.rejected)} sparkColor={SERIES.spam.color} />
        <StatTile label="Bounced" icon={TriangleAlert} value={compact(t?.bounced || 0)} hint={`${compact(t?.deferred || 0)} delayed`} tone={(t?.bounced || 0) > 0 ? "warn" : undefined} />
        <StatTile label="Active senders" icon={Users} value={compact(t?.active_senders || 0)} hint={`of ${compact(stats.data?.mailboxes || 0)} mailboxes`} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Mail flow" description="Messages sent by your users and received from outside" className="xl:col-span-2">
          <div className="p-5">
            <TimeSeriesChart title="Mail flow" data={series} keys={["sent", "received"]} unit={data?.range.unit || "day"} />
          </div>
        </Card>
        <Card title="Delivery outcome" description="All messages in the period">
          <div className="p-5">
            <SegmentedBar
              label="Delivery outcome"
              parts={[
                { label: "Delivered", value: t?.delivered || 0, color: SERIES.sent.color },
                { label: "Spam to Junk", value: t?.spam_junked || 0, color: SERIES.spam.color },
                { label: "Blocked", value: t?.rejected || 0, color: SERIES.rejected.color },
                { label: "Bounced", value: t?.bounced || 0, color: SERIES.bounced.color },
              ]}
            />
            <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-border pt-4 text-[13px]">
              <div>
                <dt className="text-muted">Data transferred</dt>
                <dd className="mt-0.5 text-base font-semibold">{formatBytes(t?.bytes || 0)}</dd>
              </div>
              <div>
                <dt className="text-muted">With attachments</dt>
                <dd className="mt-0.5 text-base font-semibold">{compact(t?.attachments || 0)}</dd>
              </div>
              <div>
                <dt className="text-muted">Forwarded out</dt>
                <dd className="mt-0.5 text-base font-semibold">{compact(t?.forward || 0)}</dd>
              </div>
              <div>
                <dt className="text-muted">Delayed</dt>
                <dd className="mt-0.5 text-base font-semibold">{compact(t?.deferred || 0)}</dd>
              </div>
            </dl>
          </div>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Protection" description="Spam moved to Junk, mail refused at the door, and bounces" className="xl:col-span-2">
          <div className="p-5">
            <TimeSeriesChart title="Protection" data={series} keys={["spam", "rejected", "bounced"]} unit={data?.range.unit || "day"} height={200} />
          </div>
        </Card>
        <Card title="Top senders" actions={<Link href="/admin/analytics" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline">All users <ArrowUpRight className="h-3.5 w-3.5" /></Link>}>
          <div className="p-5">
            <BarList
              items={(data?.top_senders || []).map((s) => ({ key: s.email, label: s.email, value: s.sent, sub: s.bounced ? `${s.bounced} bounced` : undefined }))}
              onSelect={(email) => router.push(`/admin/analytics/${encodeURIComponent(email)}`)}
            />
          </div>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        <Card title="Top destinations" description="Where your users send mail">
          <div className="p-5">
            <BarList items={(data?.top_destinations || []).map((d) => ({ label: d.domain, value: d.count }))} color={SERIES.sent.color} />
          </div>
        </Card>
        <Card title="Top incoming sources" description="Who sends mail to your users">
          <div className="p-5">
            <BarList items={(data?.top_inbound_sources || []).map((d) => ({ label: d.domain, value: d.count }))} color={SERIES.received.color} />
          </div>
        </Card>
        {isSuper && <Card title="Server health" actions={<Link href="/admin/queue" className="inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:underline"><ListOrdered className="h-3.5 w-3.5" /> Queue: {stats.data?.queue ?? "—"}</Link>}>
          <div className="p-5">
            <ul className="grid grid-cols-2 gap-x-4 gap-y-2 text-[13px]">
              {stats.data?.services.map((s) => (
                <li key={s.name} className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[12px] text-text-2">{s.name}</span>
                  {s.disabled ? <Badge>off</Badge> : <Badge tone={s.active ? "ok" : "danger"} dot>{s.active ? "up" : "down"}</Badge>}
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t border-border pt-4">
              <div className="mb-1.5 flex items-center justify-between text-[13px]">
                <span className="flex items-center gap-1.5 text-muted"><HardDrive className="h-3.5 w-3.5" /> Disk</span>
                <span className="font-medium tabular">{diskPct}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-sunken" role="img" aria-label={`${diskPct}% of disk used`}>
                <div className={cx("h-full rounded-full", diskPct > 90 ? "bg-danger" : diskPct > 75 ? "bg-warn" : "bg-accent")} style={{ width: `${diskPct}%` }} />
              </div>
              {stats.data && <p className="mt-1.5 text-xs text-muted">{formatBytes(stats.data.disk.free)} free of {formatBytes(stats.data.disk.total)}</p>}
            </div>
          </div>
        </Card>}
      </div>
    </>
  );
}

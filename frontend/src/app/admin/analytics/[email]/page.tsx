"use client";

import { ArrowLeft, Paperclip, ScrollText } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, formatBytes, formatDate } from "@/lib/api";
import { BarList, Heatmap, SERIES, SegmentedBar, StatTile, TimeSeriesChart, compact } from "@/components/charts";
import RangePicker, { useRange } from "@/components/RangePicker";
import { Avatar, Badge, Button, Card, Notice, PageSkeleton } from "@/components/ui";

type Detail = {
  mailbox: { email: string; display_name: string; active: boolean; quota_mb: number; last_login: string | null; created_at: string };
  metrics: Record<string, number> & { last_sent: string | null };
  series: { t: string; sent: number; received: number }[];
  heatmap: number[][];
  top_recipients: { recipient: string; count: number; external: boolean }[];
  top_domains: { domain: string; count: number }[];
  statuses: Record<string, number>;
  sizes: Record<string, number>;
  range: { unit: "hour" | "day" };
};

export default function UserDetail() {
  const params = useParams<{ email: string }>();
  const email = decodeURIComponent(params.email);
  const { range, setRange, query } = useRange();
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Detail>(`/admin/analytics/users/${encodeURIComponent(email)}?${query}`)
      .then((d) => { setData(d); setError(""); })
      .catch((e) => setError((e as Error).message));
  }, [email, query]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!data) return <PageSkeleton />;
  const m = data.metrics;
  const box = data.mailbox;
  const risk = m.sent >= 10 && (m.bounce_rate >= 5 || m.flagged > 0 || m.blocked > 3);

  return (
    <>
      <Link href="/admin/analytics" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text">
        <ArrowLeft className="h-4 w-4" /> User analytics
      </Link>
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Avatar name={box.display_name || box.email} size={48} />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-[22px] font-semibold tracking-tight">
            {box.display_name || box.email.split("@")[0]}
            {!box.active && <Badge>disabled</Badge>}
            {risk && <Badge tone="warn" dot>Needs review</Badge>}
          </h1>
          <p className="text-sm text-muted">
            {box.email} · last sign-in {box.last_login ? formatDate(box.last_login, true) : "never"} · member since {formatDate(box.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <RangePicker value={range} onChange={setRange} />
          <Link href={`/admin/messages?user=${encodeURIComponent(box.email)}`}>
            <Button><ScrollText className="h-4 w-4" /> Message log</Button>
          </Link>
        </div>
      </div>

      {risk && (
        <div className="mb-5">
          <Notice tone="warn" title="Unusual sending pattern">
            {m.bounce_rate >= 5 && <>A {m.bounce_rate}% bounce rate suggests outdated or guessed addresses. </>}
            {m.flagged > 0 && <>{m.flagged} outgoing message{m.flagged > 1 ? "s" : ""} scored as spam. </>}
            {m.blocked > 3 && <>{m.blocked} send attempts were refused. </>}
            If this was not expected, reset the password and check the account.
          </Notice>
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 xl:grid-cols-6">
        <StatTile label="Sent" value={compact(m.sent)} hint={`${compact(m.recipients)} recipients`} />
        <StatTile label="Received" value={compact(m.received)} hint={`${compact(m.spam_received)} flagged as spam`} />
        <StatTile label="External share" value={`${m.external_share}%`} hint={`${compact(m.external_recipients)} outside recipients`} />
        <StatTile label="Bounce rate" value={`${m.bounce_rate}%`} hint={`${m.bounced} bounced · ${m.deferred} delayed`} tone={m.bounce_rate >= 5 && m.sent >= 10 ? "danger" : undefined} />
        <StatTile label="With attachments" value={compact(m.with_attachments)} hint={m.sent ? `${Math.round((m.with_attachments / m.sent) * 100)}% of sent` : undefined} />
        <StatTile label="Volume sent" value={formatBytes(m.bytes_sent)} hint={m.last_sent ? `last ${formatDate(m.last_sent)}` : "nothing sent"} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <Card title="Activity" description="Messages sent and received" className="xl:col-span-2">
          <div className="p-5">
            <TimeSeriesChart title={`Activity of ${box.email}`} data={data.series} keys={["sent", "received"]} unit={data.range.unit} />
          </div>
        </Card>
        <Card title="Outcome of sent mail">
          <div className="p-5">
            <SegmentedBar
              label="Outcome of sent mail"
              parts={[
                { label: "Delivered", value: data.statuses.delivered || 0, color: SERIES.sent.color },
                { label: "Delayed", value: data.statuses.deferred || 0, color: SERIES.spam.color },
                { label: "Blocked", value: data.statuses.rejected || 0, color: SERIES.rejected.color },
                { label: "Bounced", value: (data.statuses.bounced || 0) + (data.statuses.partial || 0), color: SERIES.bounced.color },
              ]}
            />
            <h3 className="mt-6 mb-3 flex items-center gap-1.5 text-[13px] font-medium text-muted"><Paperclip className="h-3.5 w-3.5" /> Message size</h3>
            <BarList items={Object.entries(data.sizes).map(([label, value]) => ({ label, value }))} empty="Nothing sent" />
          </div>
        </Card>
      </div>

      <Card title="When this user sends mail" description="Messages sent by day of week and hour of day (your local time)" className="mt-5">
        <div className="p-5">
          <Heatmap grid={data.heatmap} label={`Sending activity of ${box.email} by weekday and hour`} />
        </div>
      </Card>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <Card title="Top recipients">
          <div className="p-5">
            <BarList items={data.top_recipients.map((r) => ({ label: r.recipient, value: r.count, sub: r.external ? undefined : "internal" }))} empty="Nothing sent in this period" />
          </div>
        </Card>
        <Card title="Top external domains">
          <div className="p-5">
            <BarList items={data.top_domains.map((d) => ({ label: d.domain, value: d.count }))} color={SERIES.received.color} empty="No external mail in this period" />
          </div>
        </Card>
      </div>
    </>
  );
}

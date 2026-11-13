"use client";

import { Download, Search, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, formatBytes, formatDate, useLoad } from "@/lib/api";
import { StatTile, compact } from "@/components/charts";
import RangePicker, { useRange } from "@/components/RangePicker";
import { Avatar, Badge, Button, Card, Empty, Input, PageHeader, Pagination, Select, Skeleton, SortHeader, type SortState, Table, cx } from "@/components/ui";

type Row = {
  email: string; display_name: string; active: boolean; domain: string; sent: number; received: number; recipients: number;
  external_recipients: number; external_share: number; bounced: number; bounce_rate: number; deferred: number; blocked: number;
  flagged: number; with_attachments: number; bytes_sent: number; last_sent: string | null; spam_received: number;
};
type Result = { total: number; totals: Record<string, number>; items: Row[] };

const SIZE = 25;

function Share({ value, warnAt }: { value: number; warnAt?: number }) {
  return (
    <span className={cx("tabular", warnAt !== undefined && value >= warnAt ? "font-medium text-danger" : "text-text-2")}>{value.toFixed(1)}%</span>
  );
}

export default function UserAnalytics() {
  const { range, setRange, query } = useRange();
  const domains = useLoad<{ id: number; name: string }[]>("/admin/domains");
  const [domain, setDomain] = useState("");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "sent", order: "desc" });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => { setSearch(q); setPage(1); }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ sort: sort.key, order: sort.order, page: String(page), size: String(SIZE), q: search });
    if (domain) params.set("domain", domain);
    api<Result>(`/admin/analytics/users?${query}&${params}`)
      .then((r) => !cancelled && setData(r))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [query, sort, page, search, domain]);

  const tot = data?.totals;
  const head = (label: string, key: string) => <SortHeader label={label} sortKey={key} sort={sort} onSort={(s) => { setSort(s); setPage(1); }} />;
  const exportHref = `/api/admin/reports/users.csv?${query}${domain ? `&domain=${encodeURIComponent(domain)}` : ""}`;

  return (
    <>
      <PageHeader
        title="User analytics"
        description="Who sends how much, to whom, and how much of it bounces or looks like spam."
        action={
          <>
            <RangePicker value={range} onChange={(r) => { setRange(r); setPage(1); }} />
            <a href={exportHref}>
              <Button><Download className="h-4 w-4" /> Export CSV</Button>
            </a>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Messages sent" value={tot ? compact(tot.sent) : "—"} hint={tot ? `${compact(tot.recipients)} recipients` : undefined} />
        <StatTile label="External recipients" value={tot ? compact(tot.external_recipients) : "—"} hint={tot && tot.recipients ? `${((tot.external_recipients / tot.recipients) * 100).toFixed(0)}% of all recipients` : undefined} />
        <StatTile label="Bounced" value={tot ? compact(tot.bounced) : "—"} hint={tot && tot.sent ? `${((tot.bounced / tot.sent) * 100).toFixed(1)}% bounce rate` : undefined} tone={tot && tot.sent && tot.bounced / tot.sent > 0.05 ? "warn" : undefined} />
        <StatTile label="Active senders" value={tot ? compact(tot.active_senders) : "—"} hint={data ? `of ${data.total} mailboxes` : undefined} />
      </div>

      <Card className="mt-5">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <div className="relative min-w-56 flex-1 sm:max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or address" aria-label="Search users" className="pl-9" />
          </div>
          <Select value={domain} onChange={(e) => { setDomain(e.target.value); setPage(1); }} aria-label="Domain" className="w-auto min-w-40">
            <option value="">All domains</option>
            {domains.data?.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
          </Select>
          <span className="ml-auto text-[13px] text-muted">{data ? `${data.total.toLocaleString()} mailboxes` : ""}</span>
        </div>

        {loading && !data ? (
          <div className="space-y-3 p-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9" />)}</div>
        ) : !data?.items.length ? (
          <Empty icon={Users} title="No mailboxes match">Try another search or domain.</Empty>
        ) : (
          <div className={cx(loading && "opacity-60 transition-opacity")}>
            <Table
              minWidth={1050}
              align={["left", "right", "right", "right", "right", "right", "right", "right", "left"]}
              head={[head("User", "email"), head("Sent", "sent"), head("Received", "received"), head("External", "external_recipients"), head("Bounce rate", "bounce_rate"), head("Blocked", "blocked"), head("Spam flagged", "flagged"), head("Volume", "bytes_sent"), head("Last sent", "last_sent")]}
            >
              {data.items.map((u) => (
                <tr key={u.email}>
                  <td>
                    <Link href={`/admin/analytics/${encodeURIComponent(u.email)}`} className="flex min-w-0 items-center gap-3">
                      <Avatar name={u.display_name || u.email} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium text-text hover:text-accent">{u.display_name || u.email.split("@")[0]}</span>
                          {!u.active && <Badge>disabled</Badge>}
                        </span>
                        <span className="block truncate text-xs text-muted">{u.email}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="text-right font-medium tabular">{u.sent.toLocaleString()}</td>
                  <td className="text-right tabular text-text-2">{u.received.toLocaleString()}</td>
                  <td className="text-right">
                    <span className="tabular">{u.external_recipients.toLocaleString()}</span>
                    <span className="ml-1.5 text-xs text-muted tabular">{u.external_share.toFixed(0)}%</span>
                  </td>
                  <td className="text-right"><Share value={u.bounce_rate} warnAt={u.sent >= 10 ? 5 : 101} /></td>
                  <td className={cx("text-right tabular", u.blocked ? "font-medium text-danger" : "text-text-2")}>{u.blocked}</td>
                  <td className={cx("text-right tabular", u.flagged ? "font-medium text-warn" : "text-text-2")}>{u.flagged}</td>
                  <td className="text-right tabular text-text-2">{formatBytes(u.bytes_sent)}</td>
                  <td className="whitespace-nowrap text-text-2">{u.last_sent ? formatDate(u.last_sent) : <span className="text-faint">Never</span>}</td>
                </tr>
              ))}
            </Table>
            <Pagination page={page} size={SIZE} total={data.total} onPage={setPage} />
          </div>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">
        <b>Blocked</b>: messages the server refused to send (for example spoofing another sender). <b>Spam flagged</b>: outgoing messages that scored as spam, often a sign of a compromised account.
      </p>
    </>
  );
}

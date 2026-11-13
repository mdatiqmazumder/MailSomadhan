"use client";

import { History, Search } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { api, formatDate } from "@/lib/api";
import { Badge, Card, Empty, Input, PageHeader, Pagination, Select, Skeleton, Table, cx } from "@/components/ui";

type Row = { id: number; at: string; actor: string; kind: string; ip: string; method: string; path: string; status: number; details: string };

/** Human-readable description of an API call. */
function describe(r: Row): string {
  const p = r.path.replace(/^\/api\//, "");
  const verb = { POST: "Created", PUT: "Updated", PATCH: "Changed", DELETE: "Deleted" }[r.method] || r.method;
  const rules: [RegExp, string][] = [
    [/^auth\/login$/, r.status === 200 ? "Signed in" : "Failed sign-in"],
    [/^account\/password$/, "Changed own password"],
    [/^account\/2fa\/enable$/, "Turned on two-factor sign-in"],
    [/^account\/2fa\/disable$/, "Turned off two-factor sign-in"],
    [/^account\/2fa\/setup$/, "Started two-factor setup"],
    [/^account\/sign-out-everywhere$/, "Signed out other sessions"],
    [/^admin\/mailboxes(\/\d+)?$/, `${verb} mailbox`],
    [/^admin\/aliases(\/\d+)?$/, `${verb} alias`],
    [/^admin\/domains(\/\d+)?$/, `${verb} domain`],
    [/^admin\/domains\/\d+\/dkim\/rotate$/, "Rotated DKIM key"],
    [/^admin\/admins(\/\d+)?$/, `${verb} administrator`],
    [/^admin\/settings$/, "Changed settings"],
    [/^admin\/features$/, "Changed spam filter"],
    [/^admin\/filters/, `${verb} mail filter`],
    [/^admin\/relays/, `${verb} SMTP relay`],
    [/^admin\/hosts/, `${verb} host`],
    [/^admin\/backup/, "Backup settings or run"],
    [/^admin\/system\/update$/, "Started update"],
    [/^admin\/campaigns\/\d+\/(\w+)$/, "Campaign action"],
    [/^admin\/suppressions/, `${verb} do-not-send entry`],
    [/^admin\/queue/, "Mail queue action"],
  ];
  for (const [re, text] of rules) if (re.test(p)) return text;
  return `${r.method} ${p}`;
}

export default function AuditPage() {
  const [q, setQ] = useState("");
  const [days, setDays] = useState("30");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; items: Row[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ total: number; items: Row[] }>(`/admin/audit?q=${encodeURIComponent(q)}&days=${days}&page=${page}`).then(setData).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [q, days, page]);

  return (
    <>
      <PageHeader title="Audit log" description="Every change made in the console and every console sign-in, with who, when and from where. Passwords and codes are never stored." />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <div className="relative min-w-56 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint" />
            <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search action, details or IP" className="pl-9" aria-label="Search" />
          </div>
          <Select value={days} onChange={(e) => { setDays(e.target.value); setPage(1); }} className="w-auto" aria-label="Period">
            <option value="1">Last 24 hours</option>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="365">Last year</option>
          </Select>
        </div>
        {!data ? (
          <div className="space-y-3 p-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>
        ) : !data.items.length ? (
          <Empty icon={History} title="Nothing recorded in this period" />
        ) : (
          <>
            <Table head={["Time", "Who", "Action", "Result", "IP"]} minWidth={760}>
              {data.items.map((r) => (
                <Fragment key={r.id}>
                  <tr onClick={() => setOpen(open === r.id ? null : r.id)} className="cursor-pointer">
                    <td className="whitespace-nowrap text-text-2 tabular">{formatDate(r.at, true)}</td>
                    <td><span className="font-medium">{r.actor || "—"}</span>{r.kind === "user" && <span className="ml-1.5 text-xs text-muted">mailbox</span>}</td>
                    <td>{describe(r)}</td>
                    <td><Badge tone={r.status < 300 ? "ok" : r.status === 401 || r.status === 403 || r.status === 429 ? "danger" : "warn"}>{r.status < 300 ? "OK" : r.status}</Badge></td>
                    <td className="font-mono text-xs text-text-2">{r.ip}</td>
                  </tr>
                  {open === r.id && (
                    <tr>
                      <td colSpan={5} className="bg-raised">
                        <p className="mb-1 font-mono text-xs text-muted">{r.method} {r.path}</p>
                        <pre className={cx("font-mono text-xs break-all whitespace-pre-wrap text-text-2")}>{r.details ? JSON.stringify(JSON.parse(r.details), null, 2) : "(no request body)"}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </Table>
            <Pagination page={page} size={50} total={data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

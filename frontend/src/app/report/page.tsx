"use client";

import { Printer } from "lucide-react";
import { useEffect, useState } from "react";
import { api, formatBytes, useMe } from "@/lib/api";
import { formatBucket } from "@/components/charts";
import { Button, Spinner } from "@/components/ui";

type Overview = {
  range: { start: string; end: string; unit: "hour" | "day" };
  totals: Record<string, number> & { delivery_rate: number | null };
  series: { t: string; sent: number; received: number; rejected: number; bounced: number; spam: number }[];
  top_destinations: { domain: string; count: number }[];
  top_inbound_sources: { domain: string; count: number }[];
};
type Users = { items: { email: string; display_name: string; sent: number; received: number; external_recipients: number; bounce_rate: number; flagged: number; bytes_sent: number }[] };

/** Print-optimised management report. Opened in a new tab; "Save as PDF" in the print dialog. */
export default function PrintableReport() {
  const { me } = useMe("admin");
  const [data, setData] = useState<{ o: Overview; u: Users; label: string; domain: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!me) return;
    const params = new URLSearchParams(window.location.search);
    const label = params.get("label") || "";
    const domain = params.get("domain") || "";
    params.delete("label");
    Promise.all([
      api<Overview>(`/admin/analytics/overview?${params}`),
      api<Users>(`/admin/analytics/users?${params}&size=500&sort=sent`),
    ])
      .then(([o, u]) => setData({ o, u, label, domain }))
      .catch((e) => setError((e as Error).message));
  }, [me]);

  if (error) return <p className="p-8 text-danger">{error}</p>;
  if (!me || me.kind !== "admin" || !data) return <div className="flex h-dvh items-center justify-center"><Spinner /></div>;
  const { o, u } = data;
  const t = o.totals;
  const kpis = [
    ["Messages sent", (t.outbound + t.internal).toLocaleString()],
    ["Messages received", t.inbound.toLocaleString()],
    ["Delivery rate", t.delivery_rate == null ? "—" : `${t.delivery_rate}%`],
    ["Blocked at the door", t.rejected.toLocaleString()],
    ["Spam moved to Junk", t.spam_junked.toLocaleString()],
    ["Bounced", t.bounced.toLocaleString()],
    ["Active senders", t.active_senders.toLocaleString()],
    ["Data transferred", formatBytes(t.bytes)],
  ];
  const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

  return (
    <div className="min-h-dvh bg-bg py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-[860px] justify-end px-4">
        <Button variant="primary" onClick={() => window.print()}><Printer className="h-4 w-4" /> Print / Save as PDF</Button>
      </div>
      <article className="mx-auto max-w-[860px] bg-white px-12 py-10 text-[13px] text-[#111418] shadow-card print:max-w-none print:px-0 print:py-0 print:shadow-none" style={{ colorScheme: "light" }}>
        <header className="flex items-start justify-between border-b-2 border-[#111418] pb-4">
          <div>
            <p className="text-xs font-semibold tracking-wider text-[#69717d] uppercase">{me.brand_name}</p>
            <h1 className="mt-1 text-2xl font-semibold">Mail activity report</h1>
            <p className="mt-1 text-[#3d4450]">{data.label || "Custom period"}{data.domain ? ` · ${data.domain}` : " · all domains"}</p>
          </div>
          <div className="text-right text-xs text-[#69717d]">
            <p>{fmt(o.range.start)} –</p>
            <p>{fmt(o.range.end)}</p>
            <p className="mt-2">Generated {fmt(new Date().toISOString())}</p>
          </div>
        </header>

        <section className="mt-6 grid grid-cols-4 gap-x-6 gap-y-4">
          {kpis.map(([k, v]) => (
            <div key={k} className="border-l-2 border-[#e3e6ea] pl-3">
              <p className="text-xs text-[#69717d]">{k}</p>
              <p className="mt-0.5 text-xl font-semibold">{v}</p>
            </div>
          ))}
        </section>

        <h2 className="mt-8 mb-2 text-base font-semibold">Traffic by {o.range.unit}</h2>
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-[#cfd4da] text-left text-[#69717d]">
              <th className="py-1.5 font-medium">Period</th>
              {["Sent", "Received", "Spam", "Blocked", "Bounced"].map((h) => <th key={h} className="py-1.5 text-right font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {o.series.map((s) => (
              <tr key={s.t} className="border-b border-[#eef0f3]">
                <td className="py-1">{formatBucket(s.t, o.range.unit, true)}</td>
                {[s.sent, s.received, s.spam, s.rejected, s.bounced].map((v, i) => <td key={i} className="py-1 text-right tabular">{v.toLocaleString()}</td>)}
              </tr>
            ))}
          </tbody>
        </table>

        <h2 className="mt-8 mb-2 text-base font-semibold" style={{ breakBefore: "auto" }}>User activity</h2>
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-[#cfd4da] text-left text-[#69717d]">
              <th className="py-1.5 font-medium">User</th>
              {["Sent", "Received", "External", "Bounce rate", "Spam", "Volume"].map((h) => <th key={h} className="py-1.5 text-right font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {u.items.filter((x) => x.sent || x.received).map((x) => (
              <tr key={x.email} className="border-b border-[#eef0f3]" style={{ breakInside: "avoid" }}>
                <td className="py-1">{x.display_name ? `${x.display_name} ` : ""}<span className="text-[#69717d]">{x.email}</span></td>
                <td className="py-1 text-right tabular">{x.sent.toLocaleString()}</td>
                <td className="py-1 text-right tabular">{x.received.toLocaleString()}</td>
                <td className="py-1 text-right tabular">{x.external_recipients.toLocaleString()}</td>
                <td className="py-1 text-right tabular">{x.bounce_rate.toFixed(1)}%</td>
                <td className="py-1 text-right tabular">{x.flagged}</td>
                <td className="py-1 text-right tabular">{formatBytes(x.bytes_sent)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-8 grid grid-cols-2 gap-8">
          {([["Top destinations", o.top_destinations], ["Top incoming sources", o.top_inbound_sources]] as const).map(([title, rows]) => (
            <section key={title}>
              <h2 className="mb-2 text-base font-semibold">{title}</h2>
              <table className="w-full text-[12px]">
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.domain} className="border-b border-[#eef0f3]"><td className="py-1">{r.domain}</td><td className="py-1 text-right tabular">{r.count.toLocaleString()}</td></tr>
                  ))}
                  {!rows.length && <tr><td className="py-1 text-[#69717d]">No data</td></tr>}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <footer className="mt-10 border-t border-[#e3e6ea] pt-3 text-[11px] text-[#69717d]">Confidential · generated by {me.brand_name}</footer>
      </article>
    </div>
  );
}

"use client";

import { Download, FileBarChart, FileSpreadsheet, Globe, Printer, ScrollText, Users } from "lucide-react";
import { useState } from "react";
import { useLoad } from "@/lib/api";
import RangePicker, { rangeLabel, useRange } from "@/components/RangePicker";
import { Button, Card, Field, PageHeader, Select } from "@/components/ui";

const REPORTS = [
  { kind: "summary", icon: FileBarChart, title: "Traffic summary", text: "Messages sent, received, blocked, bounced and spam per day (per hour for short ranges)." },
  { kind: "users", icon: Users, title: "User activity", text: "One row per mailbox: sent, received, external recipients, bounce rate, spam, volume and last activity." },
  { kind: "domains", icon: Globe, title: "Sender domains", text: "Traffic grouped by sender domain, inbound and outbound, with bounces, rejections and spam." },
  { kind: "messages", icon: ScrollText, title: "Full message log", text: "Every message with sender, recipients, status, spam score and size (up to 200,000 rows)." },
];

export default function Reports() {
  const { range, setRange, query } = useRange();
  const domains = useLoad<{ id: number; name: string }[]>("/admin/domains");
  const [domain, setDomain] = useState("");
  const params = `${query}${domain ? `&domain=${encodeURIComponent(domain)}` : ""}`;

  return (
    <>
      <PageHeader title="Reports" description="Download reports for audits, management and billing, or print a formatted summary as PDF." />

      <Card className="mb-5" padded>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Period">
            <div><RangePicker value={range} onChange={setRange} /></div>
          </Field>
          <Field label="Domain">
            <Select value={domain} onChange={(e) => setDomain(e.target.value)} className="min-w-52">
              <option value="">All domains</option>
              {domains.data?.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
            </Select>
          </Field>
          <span className="flex-1" />
          <a href={`/report?${params}&label=${encodeURIComponent(rangeLabel(range))}`} target="_blank" rel="noopener">
            <Button variant="primary"><Printer className="h-4 w-4" /> Printable report (PDF)</Button>
          </a>
        </div>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {REPORTS.map(({ kind, icon: Icon, title, text }) => (
          <Card key={kind} padded className="flex flex-col">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent"><Icon className="h-5 w-5" /></span>
              <div className="min-w-0">
                <h2 className="font-semibold">{title}</h2>
                <p className="mt-1 text-sm text-muted">{text}</p>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between gap-2 border-t border-border pt-4">
              <span className="flex items-center gap-1.5 text-xs text-muted"><FileSpreadsheet className="h-3.5 w-3.5" /> CSV · opens in Excel and Google Sheets</span>
              <a href={`/api/admin/reports/${kind}.csv?${params}`}>
                <Button size="sm"><Download className="h-4 w-4" /> Download</Button>
              </a>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}

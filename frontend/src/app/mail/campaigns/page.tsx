"use client";

import { Paperclip, Plus, Send } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { formatDate, useLoad } from "@/lib/api";
import { type Campaign, type Limits, STATUS_LABEL, STATUS_TONE, done, pacing } from "@/lib/campaign";
import { Badge, Button, Card, Empty, PageHeader, PageSkeleton, Table } from "@/components/ui";

export default function CampaignList() {
  const { data, loading, reload } = useLoad<{ items: Campaign[]; limits: Limits }>("/mail/campaigns");

  useEffect(() => {
    if (!data?.items.some((c) => c.status === "running" || c.status === "scheduled")) return;
    const t = setInterval(reload, 10000);
    return () => clearInterval(t);
  }, [data, reload]);

  if (loading && !data) return <PageSkeleton />;
  const lim = data?.limits;

  return (
    <>
      <PageHeader
        title="Campaigns"
        description="Send one message to many people, each as their own private email, paced over time."
        action={<Link href="/mail/campaigns/new"><Button variant="primary"><Plus className="h-4 w-4" /> New campaign</Button></Link>}
      />
      {lim && (
        <Card padded className="mb-5">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3 text-sm">
            <div className="min-w-56 flex-1">
              <div className="mb-1.5 flex justify-between">
                <span className="text-muted">Sent in the last 24 hours</span>
                <span className="font-medium tabular">{lim.used_24h} / {lim.daily_limit}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (lim.used_24h / Math.max(1, lim.daily_limit)) * 100)}%` }} />
              </div>
            </div>
            <p className="text-muted">Up to <b className="text-text">{lim.domain_hourly_limit}</b> per recipient domain per hour</p>
            <p className="text-muted">Up to <b className="text-text">{lim.max_recipients}</b> recipients per campaign</p>
          </div>
        </Card>
      )}
      <Card>
        {!data?.items.length ? (
          <Empty icon={Send} title="No campaigns yet" action={<Link href="/mail/campaigns/new"><Button><Plus className="h-4 w-4" /> Create the first one</Button></Link>}>
            Every recipient gets a personal copy, with their own name if you like. Nobody sees the other recipients.
          </Empty>
        ) : (
          <Table head={["Campaign", "Status", "Progress", "Pacing", "Created"]} minWidth={760}>
            {data.items.map((c) => {
              const finished = done(c.counts);
              return (
                <tr key={c.id}>
                  <td className="max-w-80">
                    <Link href={`/mail/campaigns/${c.id}`} className="block font-medium hover:text-accent">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{c.name || c.subject}</span>
                        {c.attachments.length > 0 && <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted" />}
                      </span>
                    </Link>
                    <span className="block truncate text-xs text-muted">{c.subject}</span>
                  </td>
                  <td><Badge tone={STATUS_TONE[c.status] || "muted"} dot>{STATUS_LABEL[c.status] || c.status}</Badge></td>
                  <td className="min-w-44">
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="tabular">{finished} / {c.total}</span>
                      {c.counts.bounced + c.counts.failed > 0 && <span className="text-danger">{c.counts.bounced + c.counts.failed} failed</span>}
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                      <div className="h-full rounded-full bg-accent" style={{ width: `${(finished / Math.max(1, c.total)) * 100}%` }} />
                    </div>
                  </td>
                  <td className="text-text-2">{pacing(c)}</td>
                  <td className="whitespace-nowrap text-text-2">{formatDate(c.created_at)}</td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}

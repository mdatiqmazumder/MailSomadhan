"use client";

import { Ban, Check, Pause, Play, Plus, Search, Send, Trash2, UserX } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, formatDate, useLoad } from "@/lib/api";
import { useAdmin } from "@/lib/admin";
import { type Campaign, STATUS_LABEL, STATUS_TONE, done, pacing } from "@/lib/campaign";
import {
  Badge, Button, Card, Empty, Field, IconButton, Input, Modal, PageHeader, Pagination, Select, Table, Tabs, Textarea, confirmDialog, toast,
} from "@/components/ui";

type Tab = "campaigns" | "unsubscribed" | "suppressions" | "limits";

export default function AdminCampaigns() {
  const [tab, setTab] = useState<Tab>("campaigns");
  const { isSuper } = useAdmin();
  return (
    <>
      <PageHeader title="Campaigns" description="Individual sending by your users: oversee running campaigns, approve large ones, and manage limits and the do-not-send list." />
      <div className="mb-5">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "campaigns", label: "Campaigns" },
            { value: "unsubscribed", label: "Unsubscribed" },
            { value: "suppressions", label: "Do-not-send list" },
            ...(isSuper ? [{ value: "limits" as Tab, label: "Limits" }] : []),
          ]}
        />
      </div>
      {tab === "campaigns" && <CampaignTable />}
      {tab === "unsubscribed" && <Suppressions fixedReason="unsubscribed" />}
      {tab === "suppressions" && <Suppressions />}
      {tab === "limits" && isSuper && <LimitsCard />}
    </>
  );
}

function CampaignTable() {
  const [status, setStatus] = useState("");
  const { data, reload } = useLoad<{ items: Campaign[] }>(`/admin/campaigns?status=${status}`);
  useEffect(() => {
    const t = setInterval(reload, 15000);
    return () => clearInterval(t);
  }, [reload]);

  async function act(c: Campaign, action: string) {
    if (action === "cancel" && !(await confirmDialog({ title: `Cancel “${c.name || c.subject}”?`, message: `Unsent emails from ${c.owner} will not be sent.`, confirmLabel: "Cancel campaign", danger: true }))) return;
    try {
      await api(`/admin/campaigns/${c.id}/${action}`, { method: "POST" });
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const waiting = data?.items.filter((c) => c.status === "pending_approval").length || 0;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto" aria-label="Status">
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABEL).filter(([k]) => k !== "draft").map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {waiting > 0 && <Badge tone="warn" dot>{waiting} awaiting approval</Badge>}
      </div>
      {!data?.items.length ? (
        <Empty icon={Send} title="No campaigns">Users create campaigns from webmail (Campaigns in the sidebar).</Empty>
      ) : (
        <Table head={["Campaign", "Sender", "Status", "Progress", "Pacing", "Created", ""]} minWidth={980}>
          {data.items.map((c) => {
            const finished = done(c.counts);
            return (
              <tr key={c.id}>
                <td className="max-w-64">
                  <Link href={`/admin/campaigns/${c.id}`} className="block truncate font-medium hover:text-accent">{c.name || c.subject}</Link>
                  <span className="block truncate text-xs text-muted">{c.subject}</span>
                </td>
                <td className="text-text-2"><Link className="hover:text-accent" href={`/admin/analytics/${encodeURIComponent(c.owner || "")}`}>{c.owner}</Link></td>
                <td><Badge tone={STATUS_TONE[c.status] || "muted"} dot>{STATUS_LABEL[c.status] || c.status}</Badge></td>
                <td className="min-w-36">
                  <span className="text-xs tabular">{finished} / {c.total}</span>
                  {c.counts.bounced + c.counts.failed > 0 && <span className="ml-2 text-xs text-danger">{c.counts.bounced + c.counts.failed} failed</span>}
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-sunken"><div className="h-full rounded-full bg-accent" style={{ width: `${(finished / Math.max(1, c.total)) * 100}%` }} /></div>
                </td>
                <td className="text-xs text-text-2">{pacing(c)}</td>
                <td className="whitespace-nowrap text-text-2">{formatDate(c.created_at)}</td>
                <td>
                  <div className="flex justify-end gap-1">
                    {c.status === "pending_approval" && <IconButton label="Approve" onClick={() => act(c, "approve")}><Check className="h-4 w-4 text-ok" /></IconButton>}
                    {["running", "scheduled", "pending_approval"].includes(c.status) && <IconButton label="Pause" onClick={() => act(c, "pause")}><Pause className="h-4 w-4" /></IconButton>}
                    {c.status === "paused" && <IconButton label="Resume" onClick={() => act(c, "resume")}><Play className="h-4 w-4" /></IconButton>}
                    {!["completed", "cancelled"].includes(c.status) && <IconButton label="Cancel" onClick={() => act(c, "cancel")}><Ban className="h-4 w-4" /></IconButton>}
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
    </Card>
  );
}

type Sup = { id: number; email: string; domain: string; reason: string; note: string; created_at: string };

function Suppressions({ fixedReason = "" }: { fixedReason?: string }) {
  const domains = useLoad<{ id: number; name: string }[]>("/admin/domains");
  const [q, setQ] = useState("");
  const [reason, setReason] = useState(fixedReason);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; items: Sup[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);

  const activeReason = fixedReason || reason;

  useEffect(() => {
    const t = setTimeout(() => {
      api<{ total: number; items: Sup[] }>(`/admin/suppressions?q=${encodeURIComponent(q)}&reason=${activeReason}&page=${page}`).then(setData).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [q, activeReason, page, tick]);

  async function remove(s: Sup) {
    if (!(await confirmDialog({ title: `Allow ${s.email} again?`, message: "Future campaigns from this domain can reach this address again.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api(`/admin/suppressions/${s.id}`, { method: "DELETE" });
      toast.ok(`${s.email} removed from list`);
      setTick((t) => t + 1);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <div className="relative min-w-56 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search address" className="pl-9" aria-label="Search" />
        </div>
        {!fixedReason && (
          <Select value={reason} onChange={(e) => { setReason(e.target.value); setPage(1); }} className="w-auto" aria-label="Reason">
            <option value="">All reasons</option>
            <option value="unsubscribed">Unsubscribed</option>
            <option value="bounced">Bounced</option>
            <option value="manual">Added by admin</option>
          </Select>
        )}
        <span className="flex-1" />
        {!fixedReason && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add addresses</Button>}
      </div>
      <p className="px-5 pt-3 text-sm text-muted">
        {fixedReason === "unsubscribed"
          ? "Recipients who clicked the unsubscribe link in a campaign email. Delete an entry to allow campaigns to reach them again."
          : "Campaigns never send to these addresses. People who unsubscribe and addresses that hard-bounce are added automatically."}
      </p>
      {!data?.items.length ? (
        <Empty icon={UserX} title={fixedReason === "unsubscribed" ? "No unsubscribed recipients" : "The list is empty"} />
      ) : (
        <>
          <div className="mt-3">
            <Table head={["Address", "Domain", "Reason", "Added", ""]} minWidth={640}>
              {data.items.map((s) => (
                <tr key={s.id}>
                  <td className="font-medium">{s.email}{s.note && <span className="block max-w-80 truncate text-xs font-normal text-muted">{s.note}</span>}</td>
                  <td className="text-text-2">{s.domain}</td>
                  <td><Badge tone={s.reason === "bounced" ? "danger" : s.reason === "unsubscribed" ? "warn" : "muted"}>{s.reason}</Badge></td>
                  <td className="whitespace-nowrap text-text-2">{formatDate(s.created_at)}</td>
                  <td className="text-right"><IconButton label={`Remove ${s.email}`} onClick={() => remove(s)}><Trash2 className="h-4 w-4" /></IconButton></td>
                </tr>
              ))}
            </Table>
          </div>
          <Pagination page={page} size={50} total={data.total} onPage={setPage} />
        </>
      )}
      {adding && domains.data && <AddSuppressions domains={domains.data} onClose={() => setAdding(false)} onDone={() => { setAdding(false); setTick((t) => t + 1); }} />}
    </Card>
  );
}

function AddSuppressions({ domains, onClose, onDone }: { domains: { id: number; name: string }[]; onClose: () => void; onDone: () => void }) {
  const [domainId, setDomainId] = useState(String(domains[0]?.id || ""));
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ added: number; skipped: string[] }>("/admin/suppressions", { json: { domain_id: Number(domainId), emails } });
      toast.ok(`${r.added} address${r.added === 1 ? "" : "es"} added`);
      if (r.skipped.length) toast.error(`Not valid: ${r.skipped.slice(0, 5).join(", ")}`);
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Add to the do-not-send list" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="For campaigns from">
          <Select value={domainId} onChange={(e) => setDomainId(e.target.value)}>
            {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </Select>
        </Field>
        <Field label="Addresses" hint="One per line or separated by commas.">
          <Textarea value={emails} onChange={(e) => setEmails(e.target.value)} rows={6} required />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Add</Button>
        </div>
      </form>
    </Modal>
  );
}

type Settings = { campaign_daily_limit: string; campaign_max_recipients: string; campaign_domain_hourly_limit: string; campaign_approval_over: string };

function LimitsCard() {
  const { data } = useLoad<Settings>("/admin/settings");
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setForm(data); }, [data]);
  if (!form) return null;
  const set = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    try {
      await api("/admin/settings", {
        method: "PUT",
        json: {
          campaign_daily_limit: Number(form.campaign_daily_limit), campaign_max_recipients: Number(form.campaign_max_recipients),
          campaign_domain_hourly_limit: Number(form.campaign_domain_hourly_limit), campaign_approval_over: Number(form.campaign_approval_over),
        },
      });
      toast.ok("Limits saved; they apply to running campaigns immediately");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Sending limits" description="Protect the server's reputation: one account sending too much can get the whole server blocked.">
      <form onSubmit={save} className="grid gap-5 p-5 sm:grid-cols-2">
        <Field label="Emails per user per 24 hours" hint="Across all of a user's campaigns. Normal emails are not counted.">
          <Input type="number" min={1} value={form.campaign_daily_limit} onChange={set("campaign_daily_limit")} required />
        </Field>
        <Field label="Emails per recipient domain per hour" hint="Per user, e.g. at most 20 to gmail.com each hour. 0 = no limit.">
          <Input type="number" min={0} value={form.campaign_domain_hourly_limit} onChange={set("campaign_domain_hourly_limit")} required />
        </Field>
        <Field label="Recipients per campaign">
          <Input type="number" min={1} value={form.campaign_max_recipients} onChange={set("campaign_max_recipients")} required />
        </Field>
        <Field label="Approval needed above" hint="Campaigns with more recipients wait for an administrator. 0 = never.">
          <Input type="number" min={0} value={form.campaign_approval_over} onChange={set("campaign_approval_over")} required />
        </Field>
        <div className="sm:col-span-2"><Button type="submit" variant="primary" loading={busy}>Save limits</Button></div>
      </form>
    </Card>
  );
}

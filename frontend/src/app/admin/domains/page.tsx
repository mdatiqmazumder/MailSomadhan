"use client";

import { CheckCircle2, CircleAlert, Cloud, HardDrive, KeyRound, Plus, RefreshCw, Trash2, Wand2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, useLoad } from "@/lib/api";
import { useAdmin } from "@/lib/admin";
import { formatMb } from "@/components/Storage";
import { Badge, Button, Card, Checkbox, CopyText, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Table, Toggle, toast, confirmDialog } from "@/components/ui";
import { CloudflareConnect, type CloudflareStatus } from "@/components/CloudflareConnect";

type Domain = {
  id: number;
  name: string;
  active: boolean;
  default_quota_mb: number;
  storage_limit_mb: number;
  allocated_mb: number;
  used_kb: number;
  relay_id: number | null;
  relay_name: string | null;
  mailboxes: number;
};
type Relay = { id: number; name: string };
type DnsRecord = { purpose: string; type: string; host: string; value: string; ok?: boolean; found?: string[] };
type PlanEntry = {
  purpose: string;
  status: "ok" | "create" | "update" | "replace" | "kept";
  summary: string;
  current: string[];
  selected: boolean;
  record: { type: string; name: string; content: string };
  changes: unknown[];
};
type Plan = { zone: string; records: PlanEntry[]; done?: string[] };

export default function DomainsPage() {
  const { isSuper, can } = useAdmin();
  const { data, loading, reload } = useLoad<Domain[]>("/admin/domains");
  const relays = useLoad<Relay[]>(isSuper ? "/admin/relays" : null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dnsFor, setDnsFor] = useState<Domain | null>(null);
  const [storageFor, setStorageFor] = useState<Domain | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await api<Domain>("/admin/domains", { json: { name } });
      toast.ok(`${created.name} added`);
      setAdding(false);
      setName("");
      await reload();
      setDnsFor(created);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(d: Domain, body: object) {
    try {
      await api(`/admin/domains/${d.id}`, { method: "PATCH", json: body });
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remove(d: Domain) {
    if (!(await confirmDialog({ title: `Delete ${d.name}? Its ${d.mailboxes} mailbox(es), aliases and all stored mail will be permanently removed.`, danger: true }))) return;
    try {
      await api(`/admin/domains/${d.id}`, { method: "DELETE" });
      toast.ok(`${d.name} deleted`);
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Domains"
        description="Each domain gets its own DKIM key and can use its own SMTP relay."
        action={
          isSuper && (
            <Button variant="primary" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" /> Add domain
            </Button>
          )
        }
      />
      <Card>
        {loading ? (
          <div className="p-6"><Spinner /></div>
        ) : !data?.length ? (
          <Empty title="No domains yet">Add a domain to start creating mailboxes for it.</Empty>
        ) : (
          <Table head={isSuper ? ["Domain", "Mailboxes", "Storage assigned", "Outbound relay", "Active", ""] : ["Domain", "Mailboxes", "Storage assigned", ""]} minWidth={isSuper ? 860 : 560}>
            {data.map((d) => (
              <tr key={d.id}>
                <td className="font-medium">{d.name}</td>
                <td className="tabular-nums">{d.mailboxes}</td>
                <td>
                  <button onClick={() => isSuper && setStorageFor(d)} className="block w-40 text-left" title={isSuper ? "Change storage limits" : undefined}>
                    <div className="mb-1 flex justify-between text-xs">
                      <span className="tabular">{formatMb(d.allocated_mb)}</span>
                      <span className="text-muted tabular">of {formatMb(d.storage_limit_mb)}</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
                      <div className={d.allocated_mb >= d.storage_limit_mb ? "h-full rounded-full bg-warn" : "h-full rounded-full bg-accent"} style={{ width: `${Math.min(100, (d.allocated_mb / Math.max(1, d.storage_limit_mb)) * 100)}%` }} />
                    </div>
                    <span className="mt-0.5 block text-[11px] text-muted">{(d.used_kb / 1024 / 1024).toFixed(d.used_kb > 1024 * 1024 * 10 ? 0 : 2)} GB actually used</span>
                  </button>
                </td>
                {isSuper && <td>
                  <Select
                    aria-label={`Relay for ${d.name}`}
                    className="h-8 max-w-44"
                    value={d.relay_id ?? ""}
                    onChange={(e) => patch(d, e.target.value ? { relay_id: Number(e.target.value) } : { clear_relay: true })}
                  >
                    <option value="">Default / direct</option>
                    {relays.data?.map((r) => (
                      <option key={r.id} value={r.id}>{r.name}</option>
                    ))}
                  </Select>
                </td>}
                {isSuper && <td>
                  <Toggle label={`${d.name} active`} checked={d.active} onChange={(v) => patch(d, { active: v })} />
                </td>}
                <td>
                  <div className="flex justify-end gap-1">
                    {isSuper && <IconButton label="Storage limits" onClick={() => setStorageFor(d)}><HardDrive className="h-4 w-4" /></IconButton>}
                    {can("domains.view") && <Button size="sm" onClick={() => setDnsFor(d)}>DNS records</Button>}
                    {isSuper && <IconButton label="Delete domain" onClick={() => remove(d)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {adding && (
        <Modal title="Add domain" onClose={() => setAdding(false)}>
          <form onSubmit={add} className="space-y-4">
            <Field label="Domain name" hint="A DKIM signing key is generated automatically.">
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="example.com" required />
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setAdding(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={busy}>Add domain</Button>
            </div>
          </form>
        </Modal>
      )}

      {dnsFor && <DnsModal domain={dnsFor} onClose={() => setDnsFor(null)} />}
      {storageFor && <StorageModal domain={storageFor} onClose={() => setStorageFor(null)} onSaved={() => { setStorageFor(null); reload(); }} />}
    </>
  );
}

function DnsModal({ domain, onClose }: { domain: Domain; onClose: () => void }) {
  const isSuperAdmin = useAdmin().isSuper;
  const { data, loading, reload, setData } = useLoad<{ records: DnsRecord[] }>(`/admin/domains/${domain.id}/dns`);
  const [checking, setChecking] = useState(false);

  async function recheck() {
    setChecking(true);
    await reload();
    setChecking(false);
  }

  async function rotate() {
    if (!(await confirmDialog({ title: "Generate a new DKIM key? Mail is signed with the new key immediately, so publish the new DNS record right away.", danger: true }))) return;
    try {
      const res = await api<{ records: DnsRecord[]; cloudflare: string }>(`/admin/domains/${domain.id}/dkim/rotate`, { method: "POST" });
      setData(res);
      if (res.cloudflare === "published") toast.ok("New DKIM key generated and published on Cloudflare");
      else if (res.cloudflare) toast.error(`New DKIM key generated, but Cloudflare was not updated: ${res.cloudflare.replace(/^failed: /, "")}`);
      else toast.ok("New DKIM key generated");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Modal title={`DNS records for ${domain.name}`} onClose={onClose} wide>
      {isSuperAdmin && <CloudflareSetup domain={domain} onApplied={recheck} />}
      <p className="mb-4 text-sm text-muted">
        Create these records at your DNS provider so other mail servers accept and trust mail from this domain. Changes can take a while to propagate.
      </p>
      {loading ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          {data?.records.map((r) => (
            <div key={r.purpose} className="rounded-lg border border-border p-3">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="font-semibold">{r.purpose}</span>
                <Badge>{r.type}</Badge>
                {r.ok === true && (
                  <Badge tone="ok"><CheckCircle2 className="h-3 w-3" /> Found</Badge>
                )}
                {r.ok === false && (
                  <Badge tone="warn"><CircleAlert className="h-3 w-3" /> Not found yet</Badge>
                )}
              </div>
              <Row label="Name" value={r.host} />
              <Row label="Value" value={r.value} />
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 flex flex-wrap justify-between gap-2">
        {isSuperAdmin ? (
          <Button variant="ghost" onClick={rotate}>
            <KeyRound className="h-4 w-4" /> Rotate DKIM key
          </Button>
        ) : <span />}
        <Button onClick={recheck} loading={checking}>
          {!checking && <RefreshCw className="h-4 w-4" />} Check again
        </Button>
      </div>
    </Modal>
  );
}

const PLAN_BADGE: Record<PlanEntry["status"], { tone: "ok" | "accent" | "warn" | "muted"; label: string }> = {
  ok: { tone: "ok", label: "In place" },
  kept: { tone: "muted", label: "Kept" },
  create: { tone: "accent", label: "Will be added" },
  update: { tone: "accent", label: "Will be updated" },
  replace: { tone: "warn", label: "Needs your OK" },
};

/** One-click DNS: connect Cloudflare once, then create this domain's mail records automatically. */
function CloudflareSetup({ domain, onApplied }: { domain: Domain; onApplied: () => void }) {
  const [cf, setCf] = useState<CloudflareStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [planError, setPlanError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loadingPlan, setLoadingPlan] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    api<CloudflareStatus>("/admin/cloudflare").then(setCf).catch(() => setCf(null));
  }, []);

  const loadPlan = useCallback(async () => {
    setLoadingPlan(true);
    setPlanError("");
    try {
      const p = await api<Plan>(`/admin/domains/${domain.id}/cloudflare`);
      setPlan(p);
      setPicked(new Set(p.records.filter((r) => r.selected).map((r) => r.purpose)));
    } catch (err) {
      setPlan(null);
      setPlanError((err as Error).message);
    } finally {
      setLoadingPlan(false);
    }
  }, [domain.id]);

  useEffect(() => {
    if (cf?.configured) loadPlan();
  }, [cf?.configured, loadPlan]);

  async function apply() {
    setApplying(true);
    try {
      const p = await api<Plan>(`/admin/domains/${domain.id}/cloudflare`, { json: { purposes: [...picked] } });
      setPlan(p);
      setPicked(new Set(p.records.filter((r) => r.selected).map((r) => r.purpose)));
      toast.ok(p.done?.length ? `Cloudflare updated (${p.done.length} change${p.done.length === 1 ? "" : "s"})` : "Nothing to change");
      setTimeout(onApplied, 1500);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setApplying(false);
    }
  }

  if (!cf) return null;

  if (!cf.configured) {
    return (
      <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-start gap-2 text-sm">
            <Cloud className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
            <div>
              <p className="font-medium">Is {domain.name} on Cloudflare?</p>
              <p className="text-text-2">Connect Cloudflare once and these records are created for you.</p>
            </div>
          </div>
          {!open && <Button size="sm" variant="primary" onClick={() => setOpen(true)}>Set up automatically</Button>}
        </div>
        {open && <div className="mt-3 border-t border-accent/20 pt-3"><CloudflareConnect status={cf} onChange={setCf} /></div>}
      </div>
    );
  }

  const pending = plan?.records.filter((r) => r.changes.length > 0) ?? [];
  return (
    <div className="mb-4 rounded-lg border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <Cloud className="h-4 w-4 text-accent" /> Automatic setup with Cloudflare
          {plan && <span className="font-normal text-muted">· zone {plan.zone}</span>}
        </p>
        <Button size="sm" variant="ghost" onClick={loadPlan} loading={loadingPlan}>{!loadingPlan && <RefreshCw className="h-3.5 w-3.5" />} Refresh</Button>
      </div>
      {planError ? (
        <div className="space-y-2 text-sm">
          <p className="text-danger">{planError}</p>
          <CloudflareConnect status={cf} onChange={setCf} />
        </div>
      ) : !plan ? (
        <Spinner />
      ) : (
        <>
          <ul className="divide-y divide-border">
            {plan.records.map((r) => {
              const badge = PLAN_BADGE[r.status];
              const selectable = r.changes.length > 0;
              return (
                <li key={r.purpose} className="flex items-start gap-3 py-2 text-sm">
                  {selectable ? (
                    <Checkbox
                      className="mt-0.5"
                      label={`Apply ${r.purpose}`}
                      checked={picked.has(r.purpose)}
                      onChange={(v) => setPicked((s) => { const n = new Set(s); if (v) n.add(r.purpose); else n.delete(r.purpose); return n; })}
                    />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.purpose}</span>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </div>
                    <p className="text-text-2">{r.summary}</p>
                    {r.status !== "ok" && r.status !== "kept" && r.current.length > 0 && r.purpose !== "DKIM" && (
                      <p className="mt-1 text-xs text-muted break-all">Now: {r.current.join(" · ")}</p>
                    )}
                    {(r.status === "update" || r.status === "replace") && r.purpose !== "DKIM" && (
                      <p className="mt-0.5 text-xs text-muted break-all">New: {r.record.content}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {pending.length > 0 ? (
            <div className="mt-2 flex justify-end">
              <Button variant="primary" onClick={apply} loading={applying} disabled={picked.size === 0}>
                {!applying && <Wand2 className="h-4 w-4" />} Apply {picked.size} change{picked.size === 1 ? "" : "s"}
              </Button>
            </div>
          ) : (
            <p className="mt-1 text-xs text-muted">Everything is in place on Cloudflare. Other mail servers may take a few minutes to see new records.</p>
          )}
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-2 py-0.5">
      <span className="w-12 shrink-0 pt-1.5 text-xs text-muted">{label}</span>
      <code className="min-w-0 flex-1 rounded bg-raised px-2 py-1.5 font-mono text-xs break-all">{value}</code>
      <CopyText value={value} />
    </div>
  );
}

function StorageModal({ domain, onClose, onSaved }: { domain: Domain; onClose: () => void; onSaved: () => void }) {
  const settings = useLoad<{ max_mailbox_quota_mb: string }>("/admin/settings");
  const maxMb = Number(settings.data?.max_mailbox_quota_mb || 10240);
  const [limitGb, setLimitGb] = useState(String(domain.storage_limit_mb / 1024));
  const [defaultGb, setDefaultGb] = useState(String(domain.default_quota_mb / 1024));
  const [busy, setBusy] = useState(false);
  const limitMb = Math.round(Number(limitGb) * 1024);
  const defaultMb = Math.round(Number(defaultGb) * 1024);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/admin/domains/${domain.id}`, { method: "PATCH", json: { storage_limit_mb: limitMb, default_quota_mb: defaultMb } });
      toast.ok(`Storage limits for ${domain.name} saved`);
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Storage for ${domain.name}`} description="Every mailbox has a fixed size; together they can never exceed the domain's storage limit." onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <div className="rounded-lg bg-raised px-3 py-2.5 text-sm">
          <b>{formatMb(domain.allocated_mb)}</b> assigned to {domain.mailboxes} mailbox{domain.mailboxes === 1 ? "" : "es"} · {(domain.used_kb / 1024 / 1024).toFixed(2)} GB actually used
        </div>
        <Field label="Domain storage limit (GB)" hint={`Total that can be assigned to this domain's mailboxes. At least ${formatMb(domain.allocated_mb)} (already assigned).`}>
          <Input type="number" min={Math.max(0.5, domain.allocated_mb / 1024)} step={1} value={limitGb} onChange={(e) => setLimitGb(e.target.value)} required />
        </Field>
        <Field label="Default size for new mailboxes (GB)" hint={`At most ${formatMb(Math.min(maxMb, limitMb || maxMb))}.`}>
          <Input type="number" min={0.1} step={0.5} max={Math.min(maxMb, limitMb || maxMb) / 1024} value={defaultGb} onChange={(e) => setDefaultGb(e.target.value)} required />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

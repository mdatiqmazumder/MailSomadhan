"use client";

import { CheckCircle2, CircleAlert, Cloud, RefreshCw, Wand2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Badge, Button, Checkbox, CopyText, Modal, Notice, Spinner, toast } from "@/components/ui";
import { CloudflareConnect, type CloudflareStatus } from "@/components/CloudflareConnect";

export type HostRef = { id: number; hostname: string; is_primary: boolean };

type Identity = {
  host: string;
  ips: { ipv4: string | null; ipv6: string | null; ipv4_nat: boolean };
  records: { type: "A" | "AAAA"; name: string; value: string | null; found: string[]; ok: boolean; note?: string }[];
  ptr: { ip: string; family: string; found: string[]; ok: boolean; note?: string }[];
};

type PlanEntry = {
  purpose: "A" | "AAAA";
  status: "ok" | "create" | "replace" | "manual";
  summary: string;
  current: string[];
  selected: boolean;
  changes: unknown[];
};
type Plan = { zone: string; records: PlanEntry[]; done?: string[] };

export function identityProblems(id: Identity): string[] {
  const out: string[] = [];
  for (const r of id.records) {
    if (r.ok) continue;
    out.push(r.note ?? (r.value ? `${id.host} has no ${r.type} record for this server (${r.value}).` : `${r.type} record problem for ${id.host}.`));
  }
  for (const p of id.ptr) if (!p.ok && p.note && !out.some((o) => o.includes(p.ip))) out.push(`${p.ip}: ${p.note}`);
  return out;
}

/** Banner above the hosts table when the primary hostname (the name all mail is sent under) has DNS problems. */
export function IdentityBanner({ primary, onOpen }: { primary: HostRef; onOpen: () => void }) {
  const [id, setId] = useState<Identity | null>(null);
  useEffect(() => {
    api<Identity>(`/admin/hosts/${primary.id}/dns`).then(setId).catch(() => setId(null));
  }, [primary.id]);
  if (!id) return null;
  const problems = identityProblems(id);
  if (!problems.length) return null;
  return (
    <div className="mb-4">
      <Notice tone="danger" title={`Mail sent from ${primary.hostname} may be rejected`}>
        <ul className="list-disc space-y-0.5 pl-4">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
        <Button size="sm" className="mt-2" onClick={onOpen}>Fix DNS</Button>
      </Notice>
    </div>
  );
}

/** What a hostname needs in DNS, reverse DNS for the primary host, and one-click Cloudflare setup. */
export function HostDnsModal({ host, onClose }: { host: HostRef; onClose: () => void }) {
  const [id, setId] = useState<Identity | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setId(await api<Identity>(`/admin/hosts/${host.id}/dns`));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setChecking(false);
    }
  }, [host.id]);

  useEffect(() => {
    check();
  }, [check]);

  return (
    <Modal title={`DNS for ${host.hostname}`} description="These records make the name reach this server. Mail clients, browsers and other mail servers use them." onClose={onClose} wide>
      <HostCloudflare host={host} onApplied={check} />
      {!id ? (
        <Spinner />
      ) : (
        <div className="space-y-3">
          {id.records.map((r) => {
            const nat = r.type === "A" && !r.value && id.ips.ipv4_nat;
            return (
            <div key={r.type} className="rounded-lg border border-border p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="font-semibold">{r.type}</span>
                {r.ok ? <Badge tone="ok"><CheckCircle2 className="h-3 w-3" /> {r.value || nat ? "Found" : "Not needed"}</Badge>
                  : <Badge tone="warn"><CircleAlert className="h-3 w-3" /> {r.value || nat ? "Missing" : "Remove"}</Badge>}
              </div>
              {r.value ? (
                <div className="grid gap-1 sm:grid-cols-[60px_1fr]">
                  <span className="text-xs text-muted">Name</span><span className="flex items-center gap-1 font-mono text-xs break-all">{r.name}<CopyText value={r.name} /></span>
                  <span className="text-xs text-muted">Value</span><span className="flex items-center gap-1 font-mono text-xs break-all">{r.value}<CopyText value={r.value} /></span>
                </div>
              ) : nat ? null : (
                <p className="text-muted">This server has no public {r.type === "A" ? "IPv4" : "IPv6"} address.</p>
              )}
              {r.found.length > 0 && !r.ok && <p className="mt-1 text-xs text-muted break-all">Now: {r.found.join(", ")}</p>}
              {r.note && <p className={nat ? "text-text-2" : "mt-1 text-xs text-warn"}>{r.note}</p>}
            </div>
            );
          })}

          {host.is_primary && (
            <div className="rounded-lg border border-border p-3 text-sm">
              <p className="mb-1 font-semibold">Reverse DNS (PTR)</p>
              <p className="mb-2 text-muted">
                Every message leaves this server under the name {host.hostname}. Receivers such as Gmail check that the sending address points back to that name.
                Reverse DNS is set at your hosting provider (often called &ldquo;rDNS&rdquo; or &ldquo;PTR&rdquo;), not in your domain&apos;s DNS, so it cannot be set from here.
              </p>
              {id.ptr.length === 0 && <p className="text-muted">No public address detected.</p>}
              {id.ptr.map((p) => (
                <div key={p.ip} className="flex flex-wrap items-start gap-2 py-1">
                  {p.ok ? <Badge tone="ok"><CheckCircle2 className="h-3 w-3" /> OK</Badge> : <Badge tone="danger"><CircleAlert className="h-3 w-3" /> Problem</Badge>}
                  <span className="font-mono text-xs">{p.ip}</span>
                  <span className="text-xs text-muted">→ {p.found.join(", ") || "no PTR"}</span>
                  {p.note && <p className="w-full text-xs text-warn">{p.note}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button onClick={check} loading={checking}>{!checking && <RefreshCw className="h-4 w-4" />} Check again</Button>
      </div>
    </Modal>
  );
}

const BADGE: Record<PlanEntry["status"], { tone: "ok" | "accent" | "warn"; label: string }> = {
  ok: { tone: "ok", label: "In place" },
  create: { tone: "accent", label: "Will be added" },
  replace: { tone: "warn", label: "Needs your OK" },
  manual: { tone: "warn", label: "Add by hand" },
};

function HostCloudflare({ host, onApplied }: { host: HostRef; onApplied: () => void }) {
  const [cf, setCf] = useState<CloudflareStatus | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    api<CloudflareStatus>("/admin/cloudflare").then(setCf).catch(() => setCf(null));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const p = await api<Plan>(`/admin/hosts/${host.id}/cloudflare`);
      setPlan(p);
      setPicked(new Set(p.records.filter((r) => r.selected).map((r) => r.purpose)));
    } catch (err) {
      setPlan(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [host.id]);

  useEffect(() => {
    if (cf?.configured) load();
  }, [cf?.configured, load]);

  async function apply() {
    setApplying(true);
    try {
      const p = await api<Plan>(`/admin/hosts/${host.id}/cloudflare`, { json: { purposes: [...picked] } });
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
      <div className="mb-4 rounded-lg border border-accent/25 bg-accent-soft p-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-2"><Cloud className="h-4 w-4 text-accent" /> Is {host.hostname} on Cloudflare? These records can be created for you.</p>
          {!open && <Button size="sm" variant="primary" onClick={() => setOpen(true)}>Set up automatically</Button>}
        </div>
        {open && <div className="mt-3 border-t border-accent/20 pt-3"><CloudflareConnect status={cf} onChange={setCf} /></div>}
      </div>
    );
  }

  const pending = plan?.records.filter((r) => r.changes.length > 0) ?? [];
  return (
    <div className="mb-4 rounded-lg border border-border p-3 text-sm">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-medium">
          <Cloud className="h-4 w-4 text-accent" /> Automatic setup with Cloudflare
          {plan && <span className="font-normal text-muted">· zone {plan.zone}</span>}
        </p>
        <Button size="sm" variant="ghost" onClick={load} loading={loading}>{!loading && <RefreshCw className="h-3.5 w-3.5" />} Refresh</Button>
      </div>
      {error ? (
        <p className="text-danger">{error}</p>
      ) : !plan ? (
        <Spinner />
      ) : (
        <>
          <ul className="divide-y divide-border">
            {plan.records.map((r) => (
              <li key={r.purpose} className="flex items-start gap-3 py-2">
                {r.changes.length > 0 ? (
                  <Checkbox className="mt-0.5" label={`Apply ${r.purpose}`} checked={picked.has(r.purpose)}
                    onChange={(v) => setPicked((s) => { const n = new Set(s); if (v) n.add(r.purpose); else n.delete(r.purpose); return n; })} />
                ) : r.status === "manual" ? <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                  : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="font-medium">{r.purpose}</span><Badge tone={BADGE[r.status].tone}>{BADGE[r.status].label}</Badge></div>
                  <p className="text-text-2">{r.summary}</p>
                  {r.status === "replace" && r.current.length > 0 && <p className="mt-1 text-xs text-muted break-all">Now: {r.current.join(", ")}</p>}
                </div>
              </li>
            ))}
          </ul>
          {pending.length > 0 && (
            <div className="mt-2 flex justify-end">
              <Button variant="primary" onClick={apply} loading={applying} disabled={picked.size === 0}>
                {!applying && <Wand2 className="h-4 w-4" />} Apply {picked.size} change{picked.size === 1 ? "" : "s"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

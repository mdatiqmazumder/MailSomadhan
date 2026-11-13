"use client";

import { CheckCircle2, CircleAlert, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, useLoad } from "@/lib/api";
import { Badge, Button, Card, CopyText, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Table, Toggle, toast, confirmDialog } from "@/components/ui";

type Domain = {
  id: number;
  name: string;
  active: boolean;
  default_quota_mb: number;
  relay_id: number | null;
  relay_name: string | null;
  mailboxes: number;
};
type Relay = { id: number; name: string };
type DnsRecord = { purpose: string; type: string; host: string; value: string; ok?: boolean; found?: string[] };

export default function DomainsPage() {
  const { data, loading, reload } = useLoad<Domain[]>("/admin/domains");
  const relays = useLoad<Relay[]>("/admin/relays");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [dnsFor, setDnsFor] = useState<Domain | null>(null);

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
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Add domain
          </Button>
        }
      />
      <Card>
        {loading ? (
          <div className="p-6"><Spinner /></div>
        ) : !data?.length ? (
          <Empty title="No domains yet">Add a domain to start creating mailboxes for it.</Empty>
        ) : (
          <Table head={["Domain", "Mailboxes", "Outbound relay", "Active", ""]}>
            {data.map((d) => (
              <tr key={d.id}>
                <td className="font-medium">{d.name}</td>
                <td className="tabular-nums">{d.mailboxes}</td>
                <td>
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
                </td>
                <td>
                  <Toggle label={`${d.name} active`} checked={d.active} onChange={(v) => patch(d, { active: v })} />
                </td>
                <td>
                  <div className="flex justify-end gap-1">
                    <Button size="sm" onClick={() => setDnsFor(d)}>DNS records</Button>
                    <IconButton label="Delete domain" onClick={() => remove(d)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
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
    </>
  );
}

function DnsModal({ domain, onClose }: { domain: Domain; onClose: () => void }) {
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
      setData(await api(`/admin/domains/${domain.id}/dkim/rotate`, { method: "POST" }));
      toast.ok("New DKIM key generated");
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Modal title={`DNS records for ${domain.name}`} onClose={onClose} wide>
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
        <Button variant="ghost" onClick={rotate}>
          <KeyRound className="h-4 w-4" /> Rotate DKIM key
        </Button>
        <Button onClick={recheck} loading={checking}>
          {!checking && <RefreshCw className="h-4 w-4" />} Check again
        </Button>
      </div>
    </Modal>
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

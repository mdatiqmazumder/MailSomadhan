"use client";

import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, formatDate, useLoad } from "@/lib/api";
import { Badge, Button, Card, Field, IconButton, Input, Modal, PageHeader, Spinner, Table, toast, confirmDialog } from "@/components/ui";

type Host = {
  id: number;
  hostname: string;
  is_primary: boolean;
  last_error: string;
  tls: { status: "none" | "self-signed" | "trusted" | "error"; expires: string | null; issuer: string };
};

export default function HostsPage() {
  const { data, loading, reload } = useLoad<Host[]>("/admin/hosts");
  const [adding, setAdding] = useState(false);
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [issuing, setIssuing] = useState<number | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/admin/hosts", { json: { hostname } });
      toast.ok("Host added. Point its DNS A record here, then issue a certificate.");
      setAdding(false);
      setHostname("");
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function issue(h: Host) {
    setIssuing(h.id);
    try {
      await api(`/admin/hosts/${h.id}/issue-cert`, { method: "POST" });
      toast.ok(`Trusted certificate installed for ${h.hostname}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setIssuing(null);
      reload();
    }
  }

  async function remove(h: Host) {
    if (!(await confirmDialog({ title: `Remove the host ${h.hostname}?`, danger: true }))) return;
    try {
      await api(`/admin/hosts/${h.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Hosts & TLS"
        description="Hostnames this server answers on for the web panel, SMTP and IMAP. Each one gets its own Let's Encrypt certificate."
        action={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Add host
          </Button>
        }
      />
      <Card>
        {loading ? (
          <div className="p-6"><Spinner /></div>
        ) : (
          <Table head={["Hostname", "Certificate", "Expires", ""]}>
            {data?.map((h) => (
              <tr key={h.id}>
                <td className="font-medium">
                  {h.hostname} {h.is_primary && <Badge tone="accent">primary</Badge>}
                  {h.last_error && <p className="mt-1 max-w-md text-xs font-normal break-words text-danger">{h.last_error.slice(-300)}</p>}
                </td>
                <td>
                  {h.tls.status === "trusted" && <Badge tone="ok"><ShieldCheck className="h-3 w-3" /> {h.tls.issuer || "Trusted"}</Badge>}
                  {h.tls.status === "self-signed" && <Badge tone="warn">Self-signed</Badge>}
                  {h.tls.status === "none" && <Badge>None</Badge>}
                  {h.tls.status === "error" && <Badge tone="danger">Unreadable</Badge>}
                </td>
                <td className="whitespace-nowrap text-muted">{h.tls.expires ? formatDate(h.tls.expires) : "—"}</td>
                <td>
                  <div className="flex justify-end gap-1">
                    <Button size="sm" loading={issuing === h.id} disabled={issuing !== null} onClick={() => issue(h)}>
                      {h.tls.status === "trusted" ? "Renew" : "Issue certificate"}
                    </Button>
                    {!h.is_primary && (
                      <IconButton label="Remove host" onClick={() => remove(h)}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <p className="mt-3 text-sm text-muted">
        Before issuing a certificate, the hostname must have a DNS A/AAAA record pointing to this server and port 80 must be reachable. Certificates renew automatically.
      </p>

      {adding && (
        <Modal title="Add host" onClose={() => setAdding(false)}>
          <form onSubmit={add} className="space-y-4">
            <Field label="Hostname" hint="For example mail.customer-domain.com">
              <Input autoFocus value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="mail.example.com" required />
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setAdding(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={busy}>Add host</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

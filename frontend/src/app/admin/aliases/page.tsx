"use client";

import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, useLoad } from "@/lib/api";
import { Badge, Button, Card, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Table, Toggle, toast, confirmDialog } from "@/components/ui";

type Domain = { id: number; name: string };
type Alias = { id: number; source: string; destination: string; active: boolean };

export default function AliasesPage() {
  const domains = useLoad<Domain[]>("/admin/domains");
  const { data, loading, reload } = useLoad<Alias[]>("/admin/aliases");
  const [adding, setAdding] = useState(false);
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState("");
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const domainName = domain || domains.data?.[0]?.name || "";
      await api("/admin/aliases", { json: { source: `${local.trim()}@${domainName}`, destination } });
      toast.ok("Alias created");
      setAdding(false);
      setLocal("");
      setDestination("");
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setActive(a: Alias, active: boolean) {
    try {
      await api(`/admin/aliases/${a.id}`, { method: "PATCH", json: { active } });
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remove(a: Alias) {
    if (!(await confirmDialog({ title: `Delete the alias ${a.source}?`, danger: true }))) return;
    try {
      await api(`/admin/aliases/${a.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Aliases"
        description="Forward an address to one or more mailboxes. Leave the name empty to catch all unknown addresses of a domain."
        action={
          <Button variant="primary" onClick={() => setAdding(true)} disabled={!domains.data?.length}>
            <Plus className="h-4 w-4" /> Add alias
          </Button>
        }
      />
      <Card>
        {loading ? (
          <div className="p-6"><Spinner /></div>
        ) : !data?.length ? (
          <Empty title="No aliases yet">Aliases are handy for shared addresses such as info@ or sales@.</Empty>
        ) : (
          <Table head={["Address", "Delivers to", "Active", ""]}>
            {data.map((a) => (
              <tr key={a.id}>
                <td className="font-medium whitespace-nowrap">
                  {a.source.startsWith("@") ? (
                    <>
                      <Badge tone="accent">catch-all</Badge> <span className="ml-1">{a.source}</span>
                    </>
                  ) : (
                    a.source
                  )}
                </td>
                <td>
                  <span className="flex items-start gap-1.5 text-muted">
                    <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="break-all">{a.destination.split(",").join(", ")}</span>
                  </span>
                </td>
                <td>
                  <Toggle label={`${a.source} active`} checked={a.active} onChange={(v) => setActive(a, v)} />
                </td>
                <td>
                  <div className="flex justify-end">
                    <IconButton label="Delete alias" onClick={() => remove(a)}>
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
        <Modal title="Add alias" onClose={() => setAdding(false)}>
          <form onSubmit={add} className="space-y-4">
            <Field label="Alias address" hint="Leave the name empty for a catch-all.">
              <div className="flex items-center gap-1.5">
                <Input autoFocus value={local} onChange={(e) => setLocal(e.target.value)} placeholder="info" />
                <span className="text-muted">@</span>
                <Select value={domain} onChange={(e) => setDomain(e.target.value)} aria-label="Domain">
                  {domains.data?.map((d) => (
                    <option key={d.id} value={d.name}>{d.name}</option>
                  ))}
                </Select>
              </div>
            </Field>
            <Field label="Deliver to" hint="One or more addresses, separated by commas.">
              <Input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="user@example.com, other@example.com" required />
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setAdding(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={busy}>Create alias</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

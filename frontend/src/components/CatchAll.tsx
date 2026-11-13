"use client";

import { ArrowRight, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, useLoad } from "@/lib/api";
import { Badge, Button, Card, Empty, Field, IconButton, Input, Modal, Notice, Spinner, Table, Toggle, toast, confirmDialog } from "@/components/ui";

export type CatchAll = { domain_id: number; domain: string; alias_id: number | null; destination: string; active: boolean };

/** Catch-all per domain: mail to any address of the domain that has no mailbox or alias. */
export function CatchAllCard({ onChanged }: { onChanged?: () => void }) {
  const { data, loading, reload } = useLoad<CatchAll[]>("/admin/catch-all");
  const [editing, setEditing] = useState<CatchAll | null>(null);

  const changed = () => {
    reload();
    onChanged?.();
  };

  async function setActive(c: CatchAll, active: boolean) {
    try {
      await api(`/admin/domains/${c.domain_id}/catch-all`, { method: "PUT", json: { destination: c.destination, active } });
      toast.ok(`Catch-all for ${c.domain} ${active ? "turned on" : "paused"}`);
      changed();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remove(c: CatchAll) {
    if (!(await confirmDialog({ title: `Remove the catch-all for ${c.domain}? Mail to unknown addresses will be rejected again.`, danger: true }))) return;
    try {
      await api(`/admin/domains/${c.domain_id}/catch-all`, { method: "DELETE" });
      toast.ok(`Catch-all for ${c.domain} removed`);
      changed();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <Card
      title="Catch-all"
      description="Receive mail sent to any address of a domain that has no mailbox or alias, for example a mistyped name. Mail to existing addresses is not affected."
      className="mb-5"
    >
      {loading ? (
        <div className="p-6"><Spinner /></div>
      ) : !data?.length ? (
        <Empty title="No domains yet" />
      ) : (
        <Table head={["Domain", "Delivers to", "Active", ""]} minWidth={560}>
          {data.map((c) => (
            <tr key={c.domain_id}>
              <td className="font-medium whitespace-nowrap">@{c.domain}</td>
              <td>
                {c.alias_id ? (
                  <span className="flex items-start gap-1.5 text-muted">
                    <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span className="break-all">{c.destination.split(",").join(", ")}</span>
                  </span>
                ) : (
                  <Badge>Off</Badge>
                )}
              </td>
              <td>{c.alias_id && <Toggle label={`Catch-all for ${c.domain} active`} checked={c.active} onChange={(v) => setActive(c, v)} />}</td>
              <td>
                <div className="flex justify-end gap-1">
                  {c.alias_id ? (
                    <>
                      <IconButton label={`Edit the catch-all for ${c.domain}`} onClick={() => setEditing(c)}>
                        <Pencil className="h-4 w-4" />
                      </IconButton>
                      <IconButton label={`Remove the catch-all for ${c.domain}`} onClick={() => remove(c)}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => setEditing(c)}>
                      <Plus className="h-4 w-4" /> Set up
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {editing && (
        <CatchAllModal
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            changed();
          }}
        />
      )}
    </Card>
  );
}

function CatchAllModal({ item, onClose, onSaved }: { item: CatchAll; onClose: () => void; onSaved: () => void }) {
  const [destination, setDestination] = useState(item.destination.split(",").join(", "));
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/admin/domains/${item.domain_id}/catch-all`, { method: "PUT", json: { destination, active: item.alias_id ? item.active : true } });
      toast.ok(`Catch-all for ${item.domain} saved`);
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={`Catch-all for ${item.domain}`} description={`Mail to any unknown address @${item.domain} is delivered here.`} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Deliver to" hint={`One or more addresses, separated by commas. Addresses on this server must be existing mailboxes, for example admin@${item.domain}.`}>
          <Input autoFocus value={destination} onChange={(e) => setDestination(e.target.value)} placeholder={`admin@${item.domain}`} required />
        </Field>
        <Notice tone="accent">
          A catch-all also receives most of the spam sent to made-up addresses. The spam filter still applies, but expect more junk in this mailbox.
        </Notice>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

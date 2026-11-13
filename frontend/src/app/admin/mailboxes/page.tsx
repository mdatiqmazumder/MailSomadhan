"use client";

import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, formatDate, useLoad } from "@/lib/api";
import { Avatar, Button, Card, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Table, Toggle, toast, confirmDialog } from "@/components/ui";

type Domain = { id: number; name: string; default_quota_mb: number };
type Mailbox = {
  id: number;
  email: string;
  domain_id: number;
  display_name: string;
  quota_mb: number;
  active: boolean;
  last_login: string | null;
};

function randomPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export default function MailboxesPage() {
  const domains = useLoad<Domain[]>("/admin/domains");
  const { data, loading, reload } = useLoad<Mailbox[]>("/admin/mailboxes");
  const [filter, setFilter] = useState("");
  const [domainFilter, setDomainFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Mailbox | null>(null);

  const visible = useMemo(
    () =>
      (data || []).filter(
        (m) => (!domainFilter || m.domain_id === Number(domainFilter)) && (!filter || m.email.includes(filter.toLowerCase()) || m.display_name.toLowerCase().includes(filter.toLowerCase())),
      ),
    [data, filter, domainFilter],
  );

  async function setActive(m: Mailbox, active: boolean) {
    try {
      await api(`/admin/mailboxes/${m.id}`, { method: "PATCH", json: { active } });
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function remove(m: Mailbox) {
    if (!(await confirmDialog({ title: `Delete ${m.email}? All mail stored in this mailbox will be permanently removed.`, danger: true }))) return;
    try {
      await api(`/admin/mailboxes/${m.id}`, { method: "DELETE" });
      toast.ok(`${m.email} deleted`);
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  const noDomains = domains.data && domains.data.length === 0;

  return (
    <>
      <PageHeader
        title="Mailboxes"
        description="Users sign in to webmail, IMAP and SMTP with their email address and password."
        action={
          <Button variant="primary" onClick={() => setAdding(true)} disabled={!domains.data?.length}>
            <Plus className="h-4 w-4" /> Add mailbox
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Search mailboxes" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search mailboxes" />
        <Select className="max-w-52" value={domainFilter} onChange={(e) => setDomainFilter(e.target.value)} aria-label="Filter by domain">
          <option value="">All domains</option>
          {domains.data?.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </Select>
      </div>
      <Card>
        {loading ? (
          <div className="p-6"><Spinner /></div>
        ) : noDomains ? (
          <Empty title="Add a domain first">
            Mailboxes belong to a domain. <Link href="/admin/domains" className="text-accent underline">Add a domain</Link> to continue.
          </Empty>
        ) : !visible.length ? (
          <Empty title={data?.length ? "No mailboxes match" : "No mailboxes yet"} />
        ) : (
          <Table head={["Mailbox", "Quota", "Last sign-in", "Active", ""]}>
            {visible.map((m) => (
              <tr key={m.id}>
                <td>
                  <Link href={`/admin/analytics/${encodeURIComponent(m.email)}`} className="flex min-w-0 items-center gap-3 hover:text-accent">
                    <Avatar name={m.display_name || m.email} size={30} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{m.display_name || m.email.split("@")[0]}</span>
                      <span className="block truncate text-xs text-muted">{m.email}</span>
                    </span>
                  </Link>
                </td>
                <td className="tabular-nums whitespace-nowrap">{m.quota_mb >= 1024 ? `${(m.quota_mb / 1024).toFixed(m.quota_mb % 1024 ? 1 : 0)} GB` : `${m.quota_mb} MB`}</td>
                <td className="whitespace-nowrap text-muted">{m.last_login ? formatDate(m.last_login) : "Never"}</td>
                <td>
                  <Toggle label={`${m.email} active`} checked={m.active} onChange={(v) => setActive(m, v)} />
                </td>
                <td>
                  <div className="flex justify-end gap-1">
                    <IconButton label="Edit mailbox" onClick={() => setEditing(m)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton label="Delete mailbox" onClick={() => remove(m)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {adding && domains.data && (
        <MailboxForm
          domains={domains.data}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {editing && (
        <MailboxForm
          domains={domains.data || []}
          mailbox={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function MailboxForm({ domains, mailbox, onClose, onSaved }: { domains: Domain[]; mailbox?: Mailbox; onClose: () => void; onSaved: () => void }) {
  const [domainId, setDomainId] = useState(String(mailbox?.domain_id ?? domains[0]?.id ?? ""));
  const [local, setLocal] = useState("");
  const [displayName, setDisplayName] = useState(mailbox?.display_name ?? "");
  const [password, setPassword] = useState("");
  const [quota, setQuota] = useState(String(mailbox?.quota_mb ?? domains[0]?.default_quota_mb ?? 1024));
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mailbox) {
        await api(`/admin/mailboxes/${mailbox.id}`, {
          method: "PATCH",
          json: { display_name: displayName, quota_mb: Number(quota), ...(password ? { password } : {}) },
        });
        toast.ok("Mailbox updated");
      } else {
        await api("/admin/mailboxes", {
          json: { domain_id: Number(domainId), local_part: local, password, display_name: displayName, quota_mb: Number(quota) },
        });
        toast.ok("Mailbox created");
      }
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={mailbox ? `Edit ${mailbox.email}` : "Add mailbox"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {!mailbox && (
          <Field label="Address">
            <div className="flex items-center gap-1.5">
              <Input autoFocus value={local} onChange={(e) => setLocal(e.target.value)} placeholder="name" required />
              <span className="text-muted">@</span>
              <Select value={domainId} onChange={(e) => setDomainId(e.target.value)} aria-label="Domain">
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </Select>
            </div>
          </Field>
        )}
        <Field label="Display name">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Full name shown to recipients" />
        </Field>
        <Field label={mailbox ? "New password" : "Password"} hint={mailbox ? "Leave empty to keep the current password." : "At least 8 characters."}>
          <div className="flex gap-2">
            <Input value={password} onChange={(e) => setPassword(e.target.value)} required={!mailbox} minLength={8} autoComplete="off" className="font-mono" />
            <Button onClick={() => setPassword(randomPassword())} title="Generate a password">
              <KeyRound className="h-4 w-4" /> Generate
            </Button>
          </div>
        </Field>
        <Field label="Quota (MB)">
          <Input type="number" min={1} value={quota} onChange={(e) => setQuota(e.target.value)} required />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>{mailbox ? "Save changes" : "Create mailbox"}</Button>
        </div>
      </form>
    </Modal>
  );
}

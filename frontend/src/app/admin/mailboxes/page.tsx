"use client";

import { KeyRound, Pencil, Plug, Plus, Send, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, formatDate, useLoad } from "@/lib/api";
import { useAdmin } from "@/lib/admin";
import { QuotaPicker, UNLIMITED, UsageBar, fitsLimit, formatLimit, smallestLimit } from "@/components/Storage";
import { ConnectionSettings, type Connection } from "@/components/ConnectionSettings";
import { Avatar, Button, Card, Checkbox, Empty, Field, IconButton, Input, Modal, PageHeader, Select, Spinner, Table, Toggle, toast, confirmDialog } from "@/components/ui";

type Domain = { id: number; name: string; default_quota_mb: number; storage_limit_mb: number; allocated_mb: number };
type Mailbox = {
  id: number;
  email: string;
  domain_id: number;
  display_name: string;
  quota_mb: number;
  used_kb: number | null;
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
  const { me, can } = useAdmin();
  const maxMb = me?.max_mailbox_mb ?? 10240; // 0 = no server maximum
  const { data, loading, reload } = useLoad<Mailbox[]>("/admin/mailboxes");
  const [filter, setFilter] = useState("");
  const [domainFilter, setDomainFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const [showing, setShowing] = useState<Mailbox | null>(null);

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
          can("mailboxes.create") && <Button variant="primary" onClick={() => setAdding(true)} disabled={!domains.data?.length}>
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
          <Table head={["Mailbox", "Storage", "Last sign-in", "Active", ""]}>
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
                <td>
                  <UsageBar usedKb={m.used_kb} quotaMb={m.quota_mb} compact />
                  {!fitsLimit(m.quota_mb, maxMb) && <span className="mt-0.5 block text-[11px] text-warn">Above the {formatLimit(maxMb)} maximum</span>}
                </td>
                <td className="whitespace-nowrap text-muted">{m.last_login ? formatDate(m.last_login) : "Never"}</td>
                <td>
                  <Toggle label={`${m.email} active`} checked={m.active} disabled={!can("mailboxes.edit")} onChange={(v) => setActive(m, v)} />
                </td>
                <td>
                  <div className="flex justify-end gap-1">
                    <IconButton label="Connection settings" onClick={() => setShowing(m)}>
                      <Plug className="h-4 w-4" />
                    </IconButton>
                    {(can("mailboxes.edit") || can("mailboxes.password")) && <IconButton label="Edit mailbox" onClick={() => setEditing(m)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>}
                    {can("mailboxes.delete") && <IconButton label="Delete mailbox" onClick={() => remove(m)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>}
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
          maxMb={maxMb}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {showing && <ConnectionModal mailbox={showing} onClose={() => setShowing(null)} />}
      {editing && (
        <MailboxForm
          domains={domains.data || []}
          maxMb={maxMb}
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

/** The domain's default size, kept within the server maximum (0 = unlimited for both). */
function defaultFor(d: Domain | undefined, maxMb: number): number {
  if (!d) return smallestLimit(1024, maxMb);
  return fitsLimit(d.default_quota_mb, maxMb) ? d.default_quota_mb : maxMb;
}

function MailboxForm({ domains, mailbox, maxMb, onClose, onSaved }: { domains: Domain[]; mailbox?: Mailbox; maxMb: number; onClose: () => void; onSaved: () => void }) {
  const [domainId, setDomainId] = useState(String(mailbox?.domain_id ?? domains[0]?.id ?? ""));
  const [local, setLocal] = useState("");
  const [displayName, setDisplayName] = useState(mailbox?.display_name ?? "");
  const [password, setPassword] = useState("");
  const [quota, setQuota] = useState<number>(mailbox?.quota_mb ?? defaultFor(domains[0], maxMb));
  const domain = domains.find((d) => d.id === Number(domainId));
  // Free pool of the domain; when editing, this mailbox's current quota is available to itself.
  // null = the domain has unlimited storage
  const available = !domain || domain.storage_limit_mb === UNLIMITED ? null : domain.storage_limit_mb - domain.allocated_mb + (mailbox ? mailbox.quota_mb : 0);
  const [busy, setBusy] = useState(false);
  const [welcome, setWelcome] = useState(true);
  const { can } = useAdmin();
  const canEdit = !mailbox || can("mailboxes.edit");
  const canPassword = !mailbox || can("mailboxes.password");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mailbox) {
        await api(`/admin/mailboxes/${mailbox.id}`, {
          method: "PATCH",
          json: { ...(canEdit ? { display_name: displayName, quota_mb: quota } : {}), ...(password ? { password } : {}) },
        });
        toast.ok("Mailbox updated");
      } else {
        const created = await api<{ email: string; welcome_sent: boolean }>("/admin/mailboxes", {
          json: { domain_id: Number(domainId), local_part: local, password, display_name: displayName, quota_mb: quota, send_welcome: welcome },
        });
        if (welcome && !created.welcome_sent) toast.error(`${created.email} created, but the welcome email could not be delivered`);
        else toast.ok(welcome ? `${created.email} created; welcome email delivered` : `${created.email} created`);
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
              <Select value={domainId} onChange={(e) => { setDomainId(e.target.value); const d = domains.find((x) => x.id === Number(e.target.value)); if (d) setQuota(defaultFor(d, maxMb)); }} aria-label="Domain">
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </Select>
            </div>
          </Field>
        )}
        {canEdit && <Field label="Display name">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Full name shown to recipients" />
        </Field>}
        {canPassword && <Field label={mailbox ? "New password" : "Password"} hint={mailbox ? "Leave empty to keep the current password." : "At least 6 characters."}>
          <div className="flex gap-2">
            <Input value={password} onChange={(e) => setPassword(e.target.value)} required={!mailbox} minLength={6} autoComplete="off" className="font-mono" />
            <Button onClick={() => setPassword(randomPassword())} title="Generate a password">
              <KeyRound className="h-4 w-4" /> Generate
            </Button>
          </div>
        </Field>}
        {canEdit && <Field label="Storage">
          <QuotaPicker valueMb={quota} onChange={setQuota} maxMb={maxMb} availableMb={available} domainName={domain?.name} limitMb={domain?.storage_limit_mb} />
        </Field>}
        {!mailbox && (
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <Checkbox className="mt-0.5" checked={welcome} onChange={setWelcome} label="Send a welcome email" />
            <span>
              Send a welcome email
              <span className="block text-[13px] text-muted">Delivered to the new inbox with the webmail address and the IMAP and SMTP settings. The password is not included.</span>
            </span>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>{mailbox ? "Save changes" : "Create mailbox"}</Button>
        </div>
      </form>
    </Modal>
  );
}

function ConnectionModal({ mailbox, onClose }: { mailbox: Mailbox; onClose: () => void }) {
  const { data, error } = useLoad<Connection>(`/admin/mailboxes/${mailbox.id}/connection`);
  const { can } = useAdmin();
  const [sending, setSending] = useState(false);

  async function resend() {
    setSending(true);
    try {
      await api(`/admin/mailboxes/${mailbox.id}/welcome`, { method: "POST" });
      toast.ok(`Welcome email delivered to ${mailbox.email}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal title="Connection settings" description={mailbox.email} onClose={onClose}>
      {data ? <ConnectionSettings info={data} /> : error ? <p className="text-sm text-danger">{error}</p> : <Spinner />}
      <div className="mt-5 flex justify-end gap-2">
        {(can("mailboxes.create") || can("mailboxes.edit")) && (
          <Button onClick={resend} loading={sending} disabled={!mailbox.active} title={mailbox.active ? undefined : "The mailbox is disabled"}>
            <Send className="h-4 w-4" /> Send welcome email
          </Button>
        )}
        <Button variant="primary" onClick={onClose}>Done</Button>
      </div>
    </Modal>
  );
}

"use client";

import { KeyRound, Pencil, Plus, ShieldCheck, Trash2, UserCog } from "lucide-react";
import { useState } from "react";
import { api, formatDate, useLoad } from "@/lib/api";
import { useAdmin } from "@/lib/admin";
import {
  Avatar, Badge, Button, Card, Checkbox, Empty, Field, IconButton, Input, Modal, PageHeader, PageSkeleton, Segmented, Table, Toggle, confirmDialog, cx, toast,
} from "@/components/ui";

type AdminRow = {
  id: number; username: string; email: string; role: "super_admin" | "admin"; active: boolean; permissions: string[];
  domains: { id: number; name: string }[] | null; totp_enabled: boolean; last_login: string | null; created_at: string;
};
type Data = { items: AdminRow[]; permissions: Record<string, string>; templates: Record<string, { label: string; permissions: string[] }> };

function randomPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_!";
  return Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => chars[b % chars.length]).join("");
}

export default function AdminsPage() {
  const { me } = useAdmin();
  const { data, loading, reload } = useLoad<Data>("/admin/admins");
  const domains = useLoad<{ id: number; name: string }[]>("/admin/domains");
  const [editing, setEditing] = useState<AdminRow | "new" | null>(null);

  if (loading || !data) return <PageSkeleton />;

  async function remove(a: AdminRow) {
    if (!(await confirmDialog({ title: `Delete ${a.username}?`, message: "The account is removed and signed out immediately. Its audit history is kept.", confirmLabel: "Delete", danger: true }))) return;
    try {
      await api(`/admin/admins/${a.id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function toggle(a: AdminRow, active: boolean) {
    try {
      await api(`/admin/admins/${a.id}`, { method: "PATCH", json: { active } });
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Administrators"
        description="Give people access to the console. Limited administrators only see and change what you allow, on the domains you choose."
        action={<Button variant="primary" onClick={() => setEditing("new")}><Plus className="h-4 w-4" /> Add administrator</Button>}
      />
      <Card>
        {!data.items.length ? (
          <Empty icon={UserCog} title="No accounts" />
        ) : (
          <Table head={["Account", "Role", "Access", "2FA", "Last sign-in", "Active", ""]} minWidth={980}>
            {data.items.map((a) => (
              <tr key={a.id}>
                <td>
                  <span className="flex items-center gap-3">
                    <Avatar name={a.username} size={30} />
                    <span className="min-w-0">
                      <span className="block font-medium">{a.username}{a.username === me?.username && <span className="ml-1.5 text-xs text-muted">(you)</span>}</span>
                      {a.email && <span className="block truncate text-xs text-muted">{a.email}</span>}
                    </span>
                  </span>
                </td>
                <td>{a.role === "super_admin" ? <Badge tone="accent">Super administrator</Badge> : <Badge>Administrator</Badge>}</td>
                <td className="max-w-80 text-xs text-text-2">
                  {a.role === "super_admin" ? "Everything" : (
                    <>
                      <span className="block font-medium text-text">{a.domains?.map((d) => d.name).join(", ")}</span>
                      <span className="block truncate">{a.permissions.map((p) => data.permissions[p]?.split(" ").slice(0, 3).join(" ") || p).join(" · ")}</span>
                    </>
                  )}
                </td>
                <td>{a.totp_enabled ? <Badge tone="ok"><ShieldCheck className="h-3 w-3" /> On</Badge> : <Badge tone="warn">Off</Badge>}</td>
                <td className="whitespace-nowrap text-text-2">{a.last_login ? formatDate(a.last_login) : "Never"}</td>
                <td><Toggle label={`${a.username} active`} checked={a.active} disabled={a.username === me?.username} onChange={(v) => toggle(a, v)} /></td>
                <td>
                  <div className="flex justify-end gap-1">
                    <IconButton label="Edit" onClick={() => setEditing(a)}><Pencil className="h-4 w-4" /></IconButton>
                    {a.username !== me?.username && <IconButton label="Delete" onClick={() => remove(a)}><Trash2 className="h-4 w-4" /></IconButton>}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && (
        <AdminForm
          row={editing === "new" ? null : editing}
          self={editing !== "new" && editing.username === me?.username}
          data={data}
          domains={domains.data || []}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }}
        />
      )}
    </>
  );
}

function AdminForm({ row, self, data, domains, onClose, onSaved }: {
  row: AdminRow | null; self: boolean; data: Data; domains: { id: number; name: string }[]; onClose: () => void; onSaved: () => void;
}) {
  const [username, setUsername] = useState(row?.username || "");
  const [email, setEmail] = useState(row?.email || "");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "super_admin">(row?.role || "admin");
  const [perms, setPerms] = useState<string[]>(row?.role === "admin" ? row.permissions : data.templates.user_manager.permissions);
  const [domainIds, setDomainIds] = useState<number[]>(row?.domains?.map((d) => d.id) || []);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = { email, role, permissions: role === "admin" ? perms : [], domain_ids: role === "admin" ? domainIds : [] };
      if (row) {
        if (password) body.password = password;
        if (self) { delete body.role; }
        await api(`/admin/admins/${row.id}`, { method: "PATCH", json: body });
      } else {
        await api("/admin/admins", { json: { ...body, username, password } });
      }
      toast.ok(row ? "Account updated; the user signs in again with the new rights" : "Administrator created");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  async function reset2fa() {
    if (!row || !(await confirmDialog({ title: `Reset two-factor sign-in for ${row.username}?`, message: "Use this when someone lost their phone. They set it up again at their next sign-in.", confirmLabel: "Reset", danger: true }))) return;
    await api(`/admin/admins/${row.id}`, { method: "PATCH", json: { reset_2fa: true } });
    toast.ok("Two-factor sign-in reset");
    onSaved();
  }

  const toggleIn = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  return (
    <Modal title={row ? `Edit ${row.username}` : "Add administrator"} onClose={onClose} size="lg">
      <form onSubmit={submit} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username" hint={row ? undefined : "Used to sign in (not an email address)."}>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} disabled={!!row} required pattern="[a-zA-Z][a-zA-Z0-9._\-]{2,63}" />
          </Field>
          <Field label="Contact email" hint="Optional.">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={row ? "New password" : "Password"} hint={row ? "Leave empty to keep it. Changing it signs the user out." : "At least 6 characters."}>
            <div className="flex gap-2">
              <Input value={password} onChange={(e) => setPassword(e.target.value)} required={!row} minLength={6} autoComplete="off" className="font-mono" />
              <Button onClick={() => setPassword(randomPassword())}><KeyRound className="h-4 w-4" /></Button>
            </div>
          </Field>
          <Field label="Role">
            <div>
              <Segmented label="Role" value={role} onChange={(v) => !self && setRole(v)} options={[{ value: "admin", label: "Limited" }, { value: "super_admin", label: "Super administrator" }]} />
              {self && <p className="mt-1 text-xs text-muted">You cannot change your own role.</p>}
            </div>
          </Field>
        </div>

        {role === "super_admin" ? (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-text-2">Super administrators can do everything: every domain, every setting, other administrators, backups and updates.</p>
        ) : (
          <>
            <div>
              <p className="mb-2 text-[13px] font-medium">Domains</p>
              <div className="flex flex-wrap gap-2">
                {domains.map((d) => (
                  <button key={d.id} type="button" onClick={() => setDomainIds(toggleIn(domainIds, d.id))}
                    className={cx("rounded-lg border px-3 py-1.5 text-sm", domainIds.includes(d.id) ? "border-accent bg-accent-soft font-medium text-accent" : "border-border hover:bg-hover")}>
                    {d.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <p className="text-[13px] font-medium">Permissions</p>
                <span className="text-xs text-muted">Start from:</span>
                {Object.entries(data.templates).map(([k, t]) => (
                  <button key={k} type="button" onClick={() => setPerms(t.permissions)} className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-hover">{t.label}</button>
                ))}
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {Object.entries(data.permissions).map(([p, label]) => (
                  <label key={p} className={cx("flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-sm", perms.includes(p) ? "border-accent/50 bg-accent-soft/50" : "border-border")}>
                    <Checkbox checked={perms.includes(p)} onChange={() => setPerms(toggleIn(perms, p))} label={label} className="mt-0.5" />
                    <span>{label}{p === "mailboxes.delete" && <span className="block text-xs text-danger">Deletes mail permanently</span>}</span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          {row?.totp_enabled ? <Button variant="ghost" onClick={reset2fa}>Reset two-factor sign-in</Button> : <span />}
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={busy}>{row ? "Save" : "Create"}</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

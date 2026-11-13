"use client";

import { Pencil, Plus, Plug, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, useLoad } from "@/lib/api";
import { Badge, Button, Card, Empty, Field, IconButton, Input, Modal, PageHeader, Spinner, Table, Toggle, toast, confirmDialog } from "@/components/ui";

type Relay = {
  id: number;
  name: string;
  host: string;
  port: number;
  username: string;
  has_password: boolean;
  is_default: boolean;
  active: boolean;
};

export default function RelaysPage() {
  const { data, loading, reload } = useLoad<Relay[]>("/admin/relays");
  const [form, setForm] = useState<Relay | "new" | null>(null);
  const [testing, setTesting] = useState<number | null>(null);

  async function patch(r: Relay, body: object) {
    try {
      await api(`/admin/relays/${r.id}`, { method: "PATCH", json: body });
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function test(r: Relay) {
    setTesting(r.id);
    try {
      const res = await api<{ ok: boolean; detail: string }>(`/admin/relays/${r.id}/test`, { method: "POST" });
      if (res.ok) toast.ok(`${r.name}: ${res.detail}`);
      else toast.error(`${r.name}: ${res.detail}`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setTesting(null);
    }
  }

  async function remove(r: Relay) {
    if (!(await confirmDialog({ title: `Delete the relay ${r.name}? Domains using it fall back to the default route.`, danger: true }))) return;
    try {
      await api(`/admin/relays/${r.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="SMTP relays"
        description="Send outgoing mail through an external SMTP service. Assign a relay per domain, or mark one as default for everything."
        action={
          <Button variant="primary" onClick={() => setForm("new")}>
            <Plus className="h-4 w-4" /> Add relay
          </Button>
        }
      />
      <Card>
        {loading ? (
          <div className="p-6"><Spinner /></div>
        ) : !data?.length ? (
          <Empty title="No relays configured">Without a relay, mail is delivered directly from this server.</Empty>
        ) : (
          <Table head={["Name", "Server", "Default", "Active", ""]}>
            {data.map((r) => (
              <tr key={r.id}>
                <td className="font-medium">{r.name}</td>
                <td>
                  <span className="font-mono text-[13px]">{r.host}:{r.port}</span>
                  <span className="ml-2">{r.username ? <Badge>auth: {r.username}</Badge> : <Badge>no auth</Badge>}</span>
                </td>
                <td>
                  <Toggle label={`${r.name} default`} checked={r.is_default} onChange={(v) => patch(r, { is_default: v })} />
                </td>
                <td>
                  <Toggle label={`${r.name} active`} checked={r.active} onChange={(v) => patch(r, { active: v })} />
                </td>
                <td>
                  <div className="flex justify-end gap-1">
                    <Button size="sm" loading={testing === r.id} onClick={() => test(r)}>
                      {testing !== r.id && <Plug className="h-3.5 w-3.5" />} Test
                    </Button>
                    <IconButton label="Edit relay" onClick={() => setForm(r)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton label="Delete relay" onClick={() => remove(r)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <p className="mt-3 text-sm text-muted">
        Use a STARTTLS port such as 587 or 2525. If you relay through a provider, add its SPF include to your domain&apos;s SPF record.
      </p>

      {form && (
        <RelayForm
          relay={form === "new" ? undefined : form}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function RelayForm({ relay, onClose, onSaved }: { relay?: Relay; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(relay?.name ?? "");
  const [host, setHost] = useState(relay?.host ?? "");
  const [port, setPort] = useState(String(relay?.port ?? 587));
  const [username, setUsername] = useState(relay?.username ?? "");
  const [password, setPassword] = useState("");
  const [isDefault, setIsDefault] = useState(relay?.is_default ?? false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const body: Record<string, unknown> = { name, host, port: Number(port), username, is_default: isDefault };
      if (!relay || password) body.password = password;
      if (relay) await api(`/admin/relays/${relay.id}`, { method: "PATCH", json: body });
      else await api("/admin/relays", { json: body });
      toast.ok("Relay saved");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={relay ? `Edit ${relay.name}` : "Add SMTP relay"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Amazon SES" required />
        </Field>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <Field label="SMTP host">
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.provider.com" required />
          </Field>
          <Field label="Port">
            <Input type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} required />
          </Field>
        </div>
        <Field label="Username" hint="Leave empty if the relay does not need authentication.">
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Password" hint={relay?.has_password ? "Leave empty to keep the saved password." : undefined}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <div className="flex items-center gap-2.5">
          <Toggle label="Default relay" checked={isDefault} onChange={setIsDefault} />
          <span className="text-sm">Use as default for all domains</span>
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Save relay</Button>
        </div>
      </form>
    </Modal>
  );
}

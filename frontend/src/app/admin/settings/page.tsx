"use client";

import { HardDrive, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api, formatBytes, useLoad } from "@/lib/api";
import { GbInput, UNLIMITED, fitsLimit, formatLimit, formatMb } from "@/components/Storage";
import { Button, Card, Field, Input, Notice, PageHeader, PageSkeleton, Toggle, toast } from "@/components/ui";

type Settings = {
  brand_name: string;
  max_attachment_mb: string;
  default_quota_mb: string;
  max_mailbox_quota_mb: string;
  default_domain_storage_mb: string;
  acme_email: string;
  require_admin_2fa: string;
  admin_allowed_networks: string;
  primary_host: string;
  web_port: number;
  warning?: string;
};
type Storage = { max_mailbox_mb: number; allocated_mb: number; used_kb: number; over_max: string[]; overcommitted: boolean; disk: { total: number; free: number } };


export default function SettingsPage() {
  const { data, loading } = useLoad<Settings>("/admin/settings");
  const storage = useLoad<Storage>("/admin/storage");
  const [form, setForm] = useState<Settings | null>(null);
  const [mb, setMb] = useState<{ max: number; def: number; domain: number } | null>(null);
  const [busy, setBusy] = useState<"" | "general" | "storage">("");

  useEffect(() => {
    if (!data) return;
    setForm(data);
    setMb({ max: Number(data.max_mailbox_quota_mb), def: Number(data.default_quota_mb), domain: Number(data.default_domain_storage_mb) });
  }, [data]);

  async function put(json: Record<string, unknown>, which: "general" | "storage") {
    const prevPort = form?.web_port;
    setBusy(which);
    try {
      const saved = await api<Settings>("/admin/settings", { method: "PUT", json });
      setForm(saved);
      if (saved.web_port && prevPort && saved.web_port !== prevPort) {
        toast.ok(`Panel port changed to ${saved.web_port}; redirecting…`);
        const portPart = saved.web_port === 443 ? "" : `:${saved.web_port}`;
        setTimeout(() => {
          window.location.href = `${window.location.protocol}//${window.location.hostname}${portPart}${window.location.pathname}`;
        }, 600);
        return;
      }
      if (saved.warning) toast.error(saved.warning);
      else toast.ok("Settings saved");
      storage.reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (loading || !form || !mb) return <PageSkeleton />;
  const defaultTooBig = !fitsLimit(mb.def, mb.max);
  const set = (key: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });
  const st = storage.data;

  return (
    <>
      <PageHeader title="Settings" description={`Primary mail host: ${form.primary_host}`} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="General">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              put(
                {
                  brand_name: form.brand_name,
                  max_attachment_mb: Number(form.max_attachment_mb),
                  acme_email: form.acme_email,
                  web_port: Number(form.web_port),
                },
                "general",
              );
            }}
            className="space-y-4 p-5"
          >
            <Field label="Product name" hint="Shown on the sign-in page and in the webmail header.">
              <Input value={form.brand_name} onChange={set("brand_name")} required maxLength={60} />
            </Field>
            <Field label="Panel port (HTTPS)" hint="Port for the admin panel and webmail (for example 8443 or 443). Changing it reloads nginx and redirects your browser.">
              <Input type="number" min={1} max={65535} value={form.web_port ?? 8443} onChange={(e) => setForm({ ...form, web_port: Number(e.target.value) })} required />
            </Field>
            <Field label="Maximum attachment size (MB)" hint="Applies to webmail and to mail accepted over SMTP.">
              <Input type="number" min={1} max={200} value={form.max_attachment_mb} onChange={set("max_attachment_mb")} required />
            </Field>
            <Field label="Certificate contact email" hint="Optional. Let's Encrypt sends expiry warnings here.">
              <Input type="email" value={form.acme_email} onChange={set("acme_email")} placeholder="admin@example.com" />
            </Field>
            <Button type="submit" variant="primary" loading={busy === "general"}>Save settings</Button>
          </form>
        </Card>

        <Card title="Mailbox storage" description="Any limit can be a size in GB or unlimited." actions={<HardDrive className="h-4 w-4 text-muted" />}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              put({ max_mailbox_quota_mb: mb.max, default_quota_mb: mb.def, default_domain_storage_mb: mb.domain }, "storage");
            }}
            className="space-y-4 p-5"
          >
            <Field label="Largest mailbox allowed" hint="No mailbox can be given more than this, on any domain. Unlimited: no server maximum.">
              <GbInput label="Largest mailbox allowed in GB" valueMb={mb.max} onChange={(v) => setMb({ ...mb, max: v })} />
            </Field>
            <Field
              label="Default mailbox size"
              hint="Pre-filled when creating a mailbox on a new domain."
              error={defaultTooBig ? `At most ${formatLimit(mb.max)}, the largest mailbox allowed.` : undefined}
            >
              <GbInput label="Default mailbox size in GB" valueMb={mb.def} onChange={(v) => setMb({ ...mb, def: v })} allowUnlimited={mb.max === UNLIMITED} />
            </Field>
            <Field label="Storage for a new domain" hint="The total its mailboxes may share. Change it per domain on the Domains page.">
              <GbInput label="Storage for a new domain in GB" valueMb={mb.domain} onChange={(v) => setMb({ ...mb, domain: v })} />
            </Field>
            <Button type="submit" variant="primary" loading={busy === "storage"} disabled={defaultTooBig}>Save storage limits</Button>
            {st && (
              <div className="space-y-3 border-t border-border pt-4 text-sm">
                <p className="text-muted">
                  Assigned to all mailboxes: <b className="text-text">{formatMb(st.allocated_mb)}</b> · actually used: <b className="text-text">{formatBytes(st.used_kb * 1024)}</b> · disk: {formatBytes(st.disk.free)} free of {formatBytes(st.disk.total)}
                </p>
                {st.overcommitted && (
                  <Notice tone="warn">More storage is assigned than the disk can hold. That is fine while mailboxes are mostly empty, but watch disk usage or add disk space.</Notice>
                )}
                {st.over_max.length > 0 && (
                  <Notice tone="warn" title={`${st.over_max.length} mailbox${st.over_max.length === 1 ? " is" : "es are"} above the maximum`}>
                    They keep their current size until edited: {st.over_max.slice(0, 6).join(", ")}{st.over_max.length > 6 ? " …" : ""}
                  </Notice>
                )}
              </div>
            )}
          </form>
        </Card>
        <Card title="Console security" actions={<ShieldCheck className="h-4 w-4 text-muted" />}>
          <div className="flex items-start justify-between gap-4 p-5">
            <div>
              <p className="font-medium">Require two-factor sign-in</p>
              <p className="mt-0.5 text-sm text-muted">Every console account must use an authenticator app. Accounts without it are sent to set it up at their next sign-in. Turn it on for your own account first.</p>
            </div>
            <Toggle
              label="Require two-factor sign-in"
              checked={form.require_admin_2fa === "1"}
              onChange={(v) => put({ require_admin_2fa: v ? 1 : 0 }, "general")}
            />
          </div>
          <form
            onSubmit={(e) => { e.preventDefault(); put({ admin_allowed_networks: form.admin_allowed_networks }, "general"); }}
            className="space-y-3 border-t border-border p-5"
          >
            <Field
              label="Allow console sign-in only from"
              hint="IP addresses or networks, separated by commas (for example 203.0.113.10, 198.51.100.0/24). Empty = any network. Webmail is not affected. Locked out? Run: sudo mailsomadhan open-console"
            >
              <Input value={form.admin_allowed_networks} onChange={set("admin_allowed_networks")} placeholder="Any network" className="font-mono text-[13px]" />
            </Field>
            <Button type="submit">Save allowed networks</Button>
          </form>
        </Card>
      </div>
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import { api, useLoad } from "@/lib/api";
import { PasswordCard } from "@/components/PasswordCard";
import { Button, Card, Field, Input, PageHeader, Spinner, toast } from "@/components/ui";

type Settings = {
  brand_name: string;
  max_attachment_mb: string;
  default_quota_mb: string;
  acme_email: string;
  primary_host: string;
  warning?: string;
};

export default function SettingsPage() {
  const { data, loading } = useLoad<Settings>("/admin/settings");
  const [form, setForm] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    try {
      const saved = await api<Settings>("/admin/settings", {
        method: "PUT",
        json: {
          brand_name: form.brand_name,
          max_attachment_mb: Number(form.max_attachment_mb),
          default_quota_mb: Number(form.default_quota_mb),
          acme_email: form.acme_email,
        },
      });
      setForm(saved);
      if (saved.warning) toast.error(saved.warning);
      else toast.ok("Settings saved");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (loading || !form) return <Spinner />;
  const set = (key: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  return (
    <>
      <PageHeader title="Settings" description={`Primary mail host: ${form.primary_host}`} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">General</h2>
          <form onSubmit={save} className="space-y-4">
            <Field label="Product name" hint="Shown on the sign-in page and in the webmail header.">
              <Input value={form.brand_name} onChange={set("brand_name")} required maxLength={60} />
            </Field>
            <Field label="Maximum attachment size (MB)" hint="Applies to webmail and to mail accepted over SMTP.">
              <Input type="number" min={1} max={200} value={form.max_attachment_mb} onChange={set("max_attachment_mb")} required />
            </Field>
            <Field label="Default mailbox quota (MB)" hint="Used for new domains; existing mailboxes keep their quota.">
              <Input type="number" min={1} value={form.default_quota_mb} onChange={set("default_quota_mb")} required />
            </Field>
            <Field label="Certificate contact email" hint="Optional. Let's Encrypt sends expiry warnings here.">
              <Input type="email" value={form.acme_email} onChange={set("acme_email")} placeholder="admin@example.com" />
            </Field>
            <Button type="submit" variant="primary" loading={busy}>Save settings</Button>
          </form>
        </Card>
        <PasswordCard />
      </div>
    </>
  );
}

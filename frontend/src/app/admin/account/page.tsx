"use client";

import { KeyRound, LogOut, ShieldCheck, Smartphone } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useAdmin } from "@/lib/admin";
import { PasswordCard } from "@/components/PasswordCard";
import { Badge, Button, Card, CopyText, Field, Input, Notice, PageHeader, PageSkeleton, confirmDialog, toast } from "@/components/ui";

const PERM_LABEL: Record<string, string> = {
  "domains.view": "View domain and DNS", "mailboxes.view": "View mailboxes", "mailboxes.create": "Create mailboxes",
  "mailboxes.edit": "Edit mailboxes", "mailboxes.password": "Reset passwords", "mailboxes.delete": "Delete mailboxes",
  "aliases.manage": "Manage aliases", "analytics.view": "Analytics and reports", "campaigns.manage": "Manage campaigns",
};

export default function AccountPage() {
  const { me, isSuper } = useAdmin();
  const [forced, setForced] = useState(false);
  useEffect(() => setForced(new URLSearchParams(window.location.search).has("setup2fa")), []);
  if (!me) return <PageSkeleton />;

  async function signOutEverywhere() {
    if (!(await confirmDialog({ title: "Sign out everywhere else?", message: "Every other browser signed in to this account is signed out. This one stays signed in.", confirmLabel: "Sign out others" }))) return;
    await api("/account/sign-out-everywhere", { method: "POST" });
    toast.ok("All other sessions were signed out");
  }

  return (
    <>
      <PageHeader title="My account" description={`Signed in as ${me.username}`} />
      {me.require_2fa && !me.totp_enabled && (
        <div className="mb-5">
          <Notice tone="warn" title="Two-factor sign-in is required">
            Your organisation requires it for every console account. Set it up below to continue{forced ? "" : " using the console"}.
          </Notice>
        </div>
      )}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <TwoFactorCard enabled={me.totp_enabled} required={me.require_2fa} />
          <Card title="Access" description={isSuper ? "Full access to every domain and setting." : "What this account may do, and where."}>
            <div className="space-y-3 p-5 text-sm">
              <p><span className="text-muted">Role:</span> <Badge tone={isSuper ? "accent" : "muted"}>{isSuper ? "Super administrator" : "Administrator"}</Badge></p>
              {!isSuper && (
                <>
                  <p><span className="text-muted">Domains:</span> {me.domains?.map((d) => d.name).join(", ") || "none"}</p>
                  <div className="flex flex-wrap gap-1.5">{me.permissions.map((p) => <Badge key={p}>{PERM_LABEL[p] || p}</Badge>)}</div>
                </>
              )}
            </div>
          </Card>
        </div>
        <div className="space-y-5">
          <PasswordCard minLength={12} />
          <Card title="Sessions" padded>
            <p className="mb-3 text-sm text-muted">Sessions end automatically after 12 hours. Changing your password also signs out every other session.</p>
            <Button onClick={signOutEverywhere}><LogOut className="h-4 w-4" /> Sign out everywhere else</Button>
          </Card>
        </div>
      </div>
    </>
  );
}

function TwoFactorCard({ enabled, required }: { enabled: boolean; required: boolean }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true);
    try {
      const s = await api<{ secret: string; uri: string }>("/account/2fa/setup", { method: "POST" });
      setSetup({ ...s, qr: await QRCode.toDataURL(s.uri, { margin: 1, width: 200 }) });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/account/2fa/enable", { json: { code } });
      toast.ok("Two-factor sign-in is on");
      window.location.href = "/admin/account";
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/account/2fa/disable", { json: { code, password } });
      toast.ok("Two-factor sign-in is off");
      window.location.reload();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Card
      title="Two-factor sign-in"
      description="A 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) in addition to your password."
      actions={enabled ? <Badge tone="ok" dot>On</Badge> : <Badge tone={required ? "danger" : "warn"} dot>Off</Badge>}
    >
      <div className="p-5">
        {enabled ? (
          required ? (
            <p className="flex items-center gap-2 text-sm text-muted"><ShieldCheck className="h-4 w-4 text-ok" /> Protected. Your organisation requires two-factor sign-in, so it cannot be turned off.</p>
          ) : (
            <form onSubmit={disable} className="space-y-3">
              <p className="flex items-center gap-2 text-sm text-muted"><ShieldCheck className="h-4 w-4 text-ok" /> Your account is protected. To turn it off, confirm with your password and a current code.</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></Field>
                <Field label="Code"><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} required /></Field>
              </div>
              <Button type="submit" variant="danger" loading={busy}>Turn off</Button>
            </form>
          )
        ) : !setup ? (
          <Button variant="primary" onClick={start} loading={busy}><Smartphone className="h-4 w-4" /> Set up two-factor sign-in</Button>
        ) : (
          <form onSubmit={enable} className="space-y-4">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-text-2">
              <li>Open your authenticator app and scan this code.</li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <div className="flex flex-wrap items-center gap-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} className="rounded-lg border border-border bg-white p-1" />
              <div className="min-w-0 text-sm">
                <p className="text-muted">Cannot scan? Enter this key:</p>
                <p className="flex items-center gap-1 font-mono text-[13px] break-all">{setup.secret.match(/.{1,4}/g)?.join(" ")} <CopyText value={setup.secret} /></p>
              </div>
            </div>
            <Field label="Code from the app">
              <Input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} placeholder="123456" required className="w-40 font-mono tracking-widest" />
            </Field>
            <Button type="submit" variant="primary" loading={busy}><KeyRound className="h-4 w-4" /> Turn on</Button>
          </form>
        )}
      </div>
    </Card>
  );
}

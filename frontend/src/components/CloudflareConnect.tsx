"use client";

import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import { Badge, Button, Input, toast, confirmDialog } from "@/components/ui";

export type CloudflareStatus = { configured: boolean; hint: string; zones: string[] };

/** Cloudflare's token page with the needed permissions already filled in (Zone Read, DNS Edit). */
export function cloudflareTokenUrl() {
  const perms = JSON.stringify([{ key: "zone", type: "read" }, { key: "dns", type: "edit" }]);
  const host = typeof window === "undefined" ? "" : window.location.hostname;
  const params = new URLSearchParams({ permissionGroupKeys: perms, accountId: "*", zoneId: "all", name: `MailSomadhan ${host}`.trim() });
  return `https://dash.cloudflare.com/profile/api-tokens?${params.toString()}`;
}

/** Connect / disconnect Cloudflare. One token serves DNS setup and certificates. */
export function CloudflareConnect({ status, onChange }: { status: CloudflareStatus; onChange: (s: CloudflareStatus) => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const s = await api<CloudflareStatus>("/admin/cloudflare", { method: "PUT", json: { token: token.trim() } });
      setToken("");
      toast.ok("Cloudflare connected");
      onChange(s);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!(await confirmDialog({ title: "Disconnect Cloudflare? Automatic DNS setup and Cloudflare certificate renewals stop until you connect again.", danger: true }))) return;
    try {
      onChange(await api<CloudflareStatus>("/admin/cloudflare", { method: "DELETE" }));
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (status.configured) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
        <div className="min-w-0">
          <Badge tone="ok">Cloudflare connected</Badge> <span className="ml-1 font-mono text-xs text-muted">{status.hint}</span>
          {status.zones.length > 0 && <p className="mt-1 truncate text-xs text-muted">Domains: {status.zones.join(", ")}</p>}
        </div>
        <Button size="sm" onClick={disconnect}>Disconnect</Button>
      </div>
    );
  }

  return (
    <form onSubmit={connect} className="space-y-3 text-sm">
      <ol className="list-decimal space-y-1.5 pl-5 text-text-2">
        <li>
          <a href={cloudflareTokenUrl()} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
            Open Cloudflare <ExternalLink className="h-3.5 w-3.5" />
          </a>{" "}
          and sign in. The token form opens with the right permissions (Zone Read, DNS Edit) already chosen.
        </li>
        <li>Optionally limit <i>Zone Resources</i> to your mail domains, then press <b>Continue to summary</b> and <b>Create Token</b>.</li>
        <li>Copy the token and paste it here. It is checked with Cloudflare and stored root-only on this server.</li>
      </ol>
      <div className="flex gap-2">
        <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Cloudflare API token" autoComplete="off" className="font-mono" aria-label="Cloudflare API token" />
        <Button type="submit" variant="primary" loading={busy} disabled={token.trim().length < 30}>Connect</Button>
      </div>
    </form>
  );
}

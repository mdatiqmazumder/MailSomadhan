"use client";

import { Cloud, FileText, Globe, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, formatDate, useLoad } from "@/lib/api";
import { Badge, Button, Card, CopyText, Field, IconButton, Input, Modal, PageHeader, Spinner, Table, toast, confirmDialog } from "@/components/ui";
import { CloudflareConnect } from "@/components/CloudflareConnect";
import { HostDnsModal, IdentityBanner } from "@/components/HostDns";

type Host = {
  id: number;
  hostname: string;
  is_primary: boolean;
  last_error: string;
  tls: { status: "none" | "self-signed" | "trusted" | "error"; expires: string | null; issuer: string };
};

type Method = "http" | "dns" | "cloudflare";

type Job = {
  host: string;
  method: Method;
  state: "running" | "waiting_dns" | "done" | "failed" | "cancelled";
  message: string;
  record?: string;
  value?: string;
  dns_visible?: boolean;
  log?: string;
};

type TlsInfo = {
  job: Job | null;
  http_port: number;
  acme_root: string;
  cloudflare: { configured: boolean; hint: string };
};

const METHODS: { id: Method; icon: typeof FileText; title: string; text: string }[] = [
  { id: "http", icon: FileText, title: "File on the web server (HTTP)", text: "Let's Encrypt downloads a check file over port 80. Renews automatically." },
  { id: "dns", icon: Globe, title: "DNS record (manual)", text: "You add one TXT record at your DNS provider. Works with any provider; renew by hand every ~2 months." },
  { id: "cloudflare", icon: Cloud, title: "Cloudflare API", text: "The TXT record is created for you through the Cloudflare API. Renews automatically." },
];

export default function HostsPage() {
  const { data, loading, reload } = useLoad<Host[]>("/admin/hosts");
  const [tls, setTls] = useState<TlsInfo | null>(null);
  const [adding, setAdding] = useState(false);
  const [hostname, setHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<Host | null>(null);
  const [dnsFor, setDnsFor] = useState<Host | null>(null);
  const primary = data?.find((h) => h.is_primary);

  async function loadTls() {
    try {
      setTls(await api<TlsInfo>("/admin/tls/job"));
    } catch {
      /* shown elsewhere */
    }
  }

  useEffect(() => {
    loadTls();
  }, []);

  // Poll while a request is in progress.
  const active = tls?.job && (tls.job.state === "running" || tls.job.state === "waiting_dns");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(loadTls, 3000);
    return () => clearInterval(t);
  }, [active]);

  // Refresh the certificate column when a request finishes.
  const state = tls?.job?.state;
  useEffect(() => {
    if (state === "done") reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/admin/hosts", { json: { hostname } });
      toast.ok("Host added. Point its DNS A record here, then issue a certificate.");
      setAdding(false);
      setHostname("");
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function makePrimary(h: Host) {
    if (!(await confirmDialog({
      title: `Make ${h.hostname} the primary host?`,
      message: "Postfix, Dovecot, and the default panel identity will switch to this hostname. Make sure its DNS A/AAAA and PTR records point to this server.",
      confirmLabel: "Make primary",
    }))) return;
    setBusy(true);
    try {
      await api(`/admin/hosts/${h.id}/primary`, { method: "POST" });
      toast.ok(`${h.hostname} is now the primary host`);
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(h: Host) {
    if (!(await confirmDialog({ title: `Remove the host ${h.hostname}?`, danger: true }))) return;
    try {
      await api(`/admin/hosts/${h.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Hosts & TLS"
        description="Hostnames this server answers on for the web panel, SMTP and IMAP. Each one gets its own Let's Encrypt certificate."
        action={
          <Button variant="primary" onClick={() => setAdding(true)}>
            <Plus className="h-4 w-4" /> Add host
          </Button>
        }
      />

      {primary && <IdentityBanner key={dnsFor ? "open" : "closed"} primary={primary} onOpen={() => setDnsFor(primary)} />}
      {tls?.job && <JobCard info={tls} onChange={setTls} />}

      <Card>
        {loading ? (
          <div className="p-6"><Spinner /></div>
        ) : (
          <Table head={["Hostname", "Certificate", "Expires", ""]}>
            {data?.map((h) => (
              <tr key={h.id}>
                <td className="font-medium">
                  {h.hostname} {h.is_primary && <Badge tone="accent">primary</Badge>}
                  {h.last_error && <p className="mt-1 max-w-md text-xs font-normal break-words text-danger">{h.last_error.slice(-300)}</p>}
                </td>
                <td>
                  {h.tls.status === "trusted" && <Badge tone="ok"><ShieldCheck className="h-3 w-3" /> {h.tls.issuer || "Trusted"}</Badge>}
                  {h.tls.status === "self-signed" && <Badge tone="warn">Self-signed</Badge>}
                  {h.tls.status === "none" && <Badge>None</Badge>}
                  {h.tls.status === "error" && <Badge tone="danger">Unreadable</Badge>}
                </td>
                <td className="whitespace-nowrap text-muted">{h.tls.expires ? formatDate(h.tls.expires) : "—"}</td>
                <td>
                  <div className="flex justify-end gap-1">
                    <Button size="sm" onClick={() => setDnsFor(h)}>DNS</Button>
                    <Button size="sm" disabled={!!active} onClick={() => setTarget(h)}>
                      {h.tls.status === "trusted" ? "Renew" : "Issue certificate"}
                    </Button>
                    {!h.is_primary && (
                      <>
                        <Button size="sm" disabled={busy || !!active} onClick={() => makePrimary(h)}>
                          Make primary
                        </Button>
                        <IconButton label="Remove host" onClick={() => remove(h)}>
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <p className="mt-3 text-sm text-muted">
        The hostname needs a DNS A/AAAA record pointing to this server so mail clients and browsers reach it. Certificates issued over HTTP or the Cloudflare API renew automatically.
      </p>

      {adding && (
        <Modal title="Add host" onClose={() => setAdding(false)}>
          <form onSubmit={add} className="space-y-4">
            <Field label="Hostname" hint="For example mail.customer-domain.com">
              <Input autoFocus value={hostname} onChange={(e) => setHostname(e.target.value)} placeholder="mail.example.com" required />
            </Field>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setAdding(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={busy}>Add host</Button>
            </div>
          </form>
        </Modal>
      )}

      {dnsFor && <HostDnsModal host={dnsFor} onClose={() => setDnsFor(null)} />}

      {target && tls && (
        <IssueModal host={target} info={tls} onClose={() => setTarget(null)} onStarted={(t) => { setTls(t); setTarget(null); }} onInfo={setTls} />
      )}
    </>
  );
}

function IssueModal({ host, info, onClose, onStarted, onInfo }: {
  host: Host; info: TlsInfo; onClose: () => void; onStarted: (t: TlsInfo) => void; onInfo: (t: TlsInfo) => void;
}) {
  const [method, setMethod] = useState<Method>(info.http_port === 80 ? "http" : info.cloudflare.configured ? "cloudflare" : "dns");
  const [busy, setBusy] = useState(false);

  async function removeToken() {
    if (!(await confirmDialog({ title: "Remove the Cloudflare token?", danger: true }))) return;
    onInfo(await api<TlsInfo>("/admin/tls/cloudflare", { method: "DELETE" }));
  }

  async function start() {
    setBusy(true);
    try {
      onStarted(await api<TlsInfo>(`/admin/hosts/${host.id}/certificate`, { json: { method } }));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const acmePath = `${info.acme_root}/.well-known/acme-challenge/`;
  const ready = method !== "cloudflare" || info.cloudflare.configured;

  return (
    <Modal title={`Certificate for ${host.hostname}`} description="Choose how Let's Encrypt checks that you control this hostname." onClose={onClose} size="lg">
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3">
          {METHODS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMethod(m.id)}
              className={`rounded-lg border p-3 text-left transition-colors ${method === m.id ? "border-accent bg-accent-soft ring-1 ring-accent" : "border-border hover:bg-hover"}`}
            >
              <m.icon className="mb-2 h-4 w-4 text-muted" />
              <div className="text-sm font-medium">{m.title}</div>
              <div className="mt-1 text-xs text-muted">{m.text}</div>
            </button>
          ))}
        </div>

        {method === "http" && (
          <div className="space-y-3 text-sm">
            {info.http_port === 80 ? (
              <p className="text-muted">Port 80 is served by MailSomadhan, so nothing else is needed. The hostname&apos;s DNS A record must point to this server.</p>
            ) : (
              <>
                <p>
                  Port 80 on this server belongs to another web server (MailSomadhan uses port {info.http_port}). Let&apos;s Encrypt always checks port 80,
                  so that web server must serve <code className="font-mono text-xs">http://{host.hostname}/.well-known/acme-challenge/</code> from this folder:
                </p>
                <Snippet value={acmePath} />
                <p className="text-muted">Add one of these to the configuration of your existing web server (in the site or default site that answers for {host.hostname}), then reload it:</p>
                <p className="text-xs font-medium">Apache / httpd</p>
                <Snippet value={`Alias /.well-known/acme-challenge/ ${acmePath}\n<Directory ${acmePath}>\n    Require all granted\n</Directory>`} />
                <p className="text-xs font-medium">nginx</p>
                <Snippet value={`location ^~ /.well-known/acme-challenge/ {\n    root ${info.acme_root};\n}`} />
                <p className="text-xs font-medium">Caddy</p>
                <Snippet value={`handle /.well-known/acme-challenge/* {\n    root * ${info.acme_root}\n    file_server\n}`} />
                <p className="text-muted">If you prefer not to touch the other web server, use the DNS record or Cloudflare method instead.</p>
              </>
            )}
          </div>
        )}

        {method === "dns" && (
          <div className="space-y-2 text-sm text-muted">
            <p>After you press Start, the panel shows a TXT record (<code className="font-mono text-xs">_acme-challenge.{host.hostname}</code>). Add it at your DNS provider, wait until it shows as visible, then press Verify.</p>
            <p>Certificates last 90 days. With this method, repeat the request from this page before the expiry date shown in the table.</p>
          </div>
        )}

        {method === "cloudflare" && (
          <div className="space-y-3 text-sm">
            {info.cloudflare.configured ? (
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <span><Badge tone="ok">Token saved</Badge> <span className="ml-1 font-mono text-xs text-muted">{info.cloudflare.hint}</span></span>
                <Button size="sm" onClick={removeToken}>Remove</Button>
              </div>
            ) : (
              <>
                <p className="text-muted">Connect Cloudflare once; the same connection also sets up DNS records for your mail domains.</p>
                <CloudflareConnect status={{ configured: false, hint: "", zones: [] }} onChange={async () => onInfo(await api<TlsInfo>("/admin/tls/job"))} />
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={start} loading={busy} disabled={!ready}>Start</Button>
        </div>
      </div>
    </Modal>
  );
}

function Snippet({ value }: { value: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-sunken p-2">
      <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-pre">{value}</pre>
      <CopyText value={value} />
    </div>
  );
}

function JobCard({ info, onChange }: { info: TlsInfo; onChange: (t: TlsInfo) => void }) {
  const job = info.job!;
  const [busy, setBusy] = useState(false);

  async function call(path: string) {
    setBusy(true);
    try {
      onChange(await api<TlsInfo>(path, { method: "POST" }));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const tone = job.state === "done" ? "ok" : job.state === "failed" ? "danger" : job.state === "cancelled" ? "muted" : "accent";
  const label = { running: "In progress", waiting_dns: "Waiting for DNS record", done: "Done", failed: "Failed", cancelled: "Cancelled" }[job.state];
  const methodName = METHODS.find((m) => m.id === job.method)?.title ?? job.method;

  return (
    <Card padded className="mb-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">Certificate request for {job.host}</div>
          <div className="text-xs text-muted">{methodName}</div>
        </div>
        <div className="flex items-center gap-2">
          {(job.state === "running" || job.state === "waiting_dns") && <Spinner />}
          <Badge tone={tone}>{label}</Badge>
        </div>
      </div>
      {job.message && <p className={`mt-3 text-sm break-words ${job.state === "failed" ? "text-danger" : "text-muted"}`}>{job.message}</p>}

      {job.state === "waiting_dns" && job.record && job.value && (
        <div className="mt-4 space-y-3">
          <p className="text-sm">Add this record at your DNS provider:</p>
          <div className="grid gap-2 text-sm sm:grid-cols-[110px_1fr]">
            <span className="text-muted">Type</span><span className="font-mono">TXT</span>
            <span className="text-muted">Name</span><span className="flex items-center gap-1 font-mono break-all">{job.record}<CopyText value={job.record} /></span>
            <span className="text-muted">Value</span><span className="flex items-center gap-1 font-mono break-all">{job.value}<CopyText value={job.value} /></span>
          </div>
          <p className="text-sm">
            {job.dns_visible
              ? <Badge tone="ok">Record is visible</Badge>
              : <span className="text-muted">Not visible yet (checked every few seconds; DNS changes can take a few minutes).</span>}
          </p>
          <div className="flex gap-2">
            <Button variant="primary" loading={busy} onClick={() => call("/admin/tls/continue")}>Verify</Button>
            <Button disabled={busy} onClick={() => call("/admin/tls/cancel")}>Cancel</Button>
          </div>
        </div>
      )}

      {job.state === "running" && (
        <div className="mt-3"><Button size="sm" disabled={busy} onClick={() => call("/admin/tls/cancel")}>Cancel</Button></div>
      )}

      {job.state === "failed" && job.log && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-muted">Show details</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-sunken p-2 font-mono text-xs whitespace-pre-wrap">{job.log}</pre>
        </details>
      )}
    </Card>
  );
}

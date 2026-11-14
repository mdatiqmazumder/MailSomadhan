"use client";

import { CheckCircle2, CircleAlert, CloudUpload, ExternalLink, KeyRound, LogIn, Loader2, Play, Plug, RefreshCw, Unplug } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatBytes, formatDate, useLoad } from "@/lib/api";
import { Badge, Button, Card, CopyText, Empty, Field, Input, Notice, PageHeader, PageSkeleton, Segmented, Select, Table, Textarea, Toggle, confirmDialog, cx, toast } from "@/components/ui";

type Settings = { enabled: boolean; interval_hours: number; hour: number; keep: number; include_mail: boolean; folder: string; mode: string; connected: boolean; passphrase_set: boolean };
type Status = { status: "running" | "success" | "failed"; message: string; time: string; last_success?: string; last_file?: string; last_size?: number; last_duration?: number } | null;
type Google = { client_id: string; secret_set: boolean; account: string };
type Info = { settings: Settings; google: Google; status: Status; running: boolean; next_run: string | null; intervals: number[] };
type File = { name: string; size: number; time: string };

const DOCS = "https://github.com/mdatiqmazumder/MailSomadhan/blob/main/docs/BACKUP.md";

function intervalLabel(h: number) {
  if (h === 24) return "Daily";
  if (h === 168) return "Weekly";
  return h === 1 ? "Every hour" : `Every ${h} hours`;
}

export default function Backups() {
  const info = useLoad<Info>("/admin/backup");
  const [files, setFiles] = useState<File[] | null>(null);
  const [filesError, setFilesError] = useState("");
  const [watching, setWatching] = useState(false);
  const [log, setLog] = useState("");

  const loadFiles = useCallback(async () => {
    try {
      setFiles(await api<File[]>("/admin/backup/files"));
      setFilesError("");
    } catch (e) {
      setFilesError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (info.data?.settings.connected) loadFiles();
    if (info.data?.running) setWatching(true);
  }, [info.data?.settings.connected, info.data?.running, loadFiles]);

  useEffect(() => {
    if (!watching) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await api<{ log: string; running: boolean; status: Status }>("/admin/backup/log");
        if (stop) return;
        setLog(r.log);
        if (!r.running && r.status?.status !== "running") {
          setWatching(false);
          info.reload();
          loadFiles();
          if (r.status?.status === "success") toast.ok("Backup uploaded to Google Drive");
          else if (r.status) toast.error(r.status.message);
          return;
        }
      } catch {
        /* keep polling */
      }
      if (!stop) setTimeout(tick, 2500);
    };
    tick();
    return () => { stop = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching]);

  if (info.loading || !info.data) return <PageSkeleton />;
  const { settings: s, status } = info.data;
  const ready = s.connected && s.passphrase_set;

  async function runNow() {
    try {
      await api("/admin/backup/run", { method: "POST" });
      setLog("");
      setWatching(true);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Backups"
        description="Encrypted backups of the database, configuration and (optionally) all mailboxes to Google Drive, on your schedule."
        action={
          <>
            <a href={DOCS} target="_blank" rel="noopener noreferrer"><Button variant="ghost"><ExternalLink className="h-4 w-4" /> Setup guide</Button></a>
            <Button variant="primary" onClick={runNow} disabled={!ready || watching}><Play className="h-4 w-4" /> Back up now</Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-3">
        <StatusTile label="Last successful backup" value={status?.last_success ? formatDate(status.last_success, true) : "Never"} hint={status?.last_size ? `${formatBytes(status.last_size)} in ${status.last_duration}s` : undefined} />
        <StatusTile
          label="Last run"
          value={watching ? "Running…" : status ? status.status === "success" ? "Succeeded" : status.status === "failed" ? "Failed" : "Running" : "—"}
          hint={status && !watching ? `${status.message} · ${formatDate(status.time, true)}` : undefined}
          tone={status?.status === "failed" && !watching ? "danger" : status?.status === "success" ? "ok" : undefined}
        />
        <StatusTile
          label="Next scheduled backup"
          value={s.enabled && info.data.next_run ? formatDate(new Date(info.data.next_run).toISOString(), true) : s.enabled ? "Scheduled" : "Not scheduled"}
          hint={s.enabled ? `${intervalLabel(s.interval_hours)}, keeping ${s.keep}` : "Turn on scheduled backups below"}
        />
      </div>

      {!ready && (
        <div className="mt-5">
          <Notice tone="accent" title="Two steps before the first backup">
            {!s.connected && <>1. Connect Google Drive. </>}
            {!s.passphrase_set && <>{s.connected ? "1" : "2"}. Set an encryption passphrase. </>}
            The <a className="font-medium text-accent underline" href={DOCS} target="_blank" rel="noopener noreferrer">setup guide</a> shows how to get the Google Drive key.
          </Notice>
        </div>
      )}

      {(watching || log) && (
        <Card title={watching ? "Backup in progress" : "Last backup log"} className="mt-5" actions={watching && <Loader2 className="h-4 w-4 animate-spin text-accent" />}>
          <pre className="max-h-72 overflow-auto p-5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-text-2">{log || "Starting…"}</pre>
        </Card>
      )}

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <DriveCard settings={s} google={info.data.google} onChange={info.reload} />
        <div className="space-y-5">
          <ScheduleCard settings={s} intervals={info.data.intervals} ready={ready} onSaved={info.reload} />
          <PassphraseCard isSet={s.passphrase_set} onSaved={info.reload} />
        </div>
      </div>

      <Card
        title="Backups on Google Drive"
        description={s.connected ? `Folder “${s.folder}”` : undefined}
        className="mt-5"
        actions={s.connected && <Button size="sm" onClick={loadFiles}><RefreshCw className="h-3.5 w-3.5" /> Refresh</Button>}
      >
        {!s.connected ? (
          <Empty icon={CloudUpload} title="Not connected">Connect Google Drive to see your backups here.</Empty>
        ) : filesError ? (
          <div className="p-5"><Notice tone="danger">{filesError}</Notice></div>
        ) : !files ? (
          <div className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-muted" /></div>
        ) : !files.length ? (
          <Empty icon={CloudUpload} title="No backups yet">Click “Back up now” to create the first one.</Empty>
        ) : (
          <Table head={["File", "Created", "Size"]} align={["left", "left", "right"]} minWidth={560}>
            {files.map((f) => (
              <tr key={f.name}>
                <td className="font-mono text-[12.5px] break-all">{f.name}</td>
                <td className="whitespace-nowrap text-text-2">{formatDate(f.time, true)}</td>
                <td className="text-right tabular text-text-2">{formatBytes(f.size)}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <p className="mt-3 text-xs text-muted">
        To restore, download a file from Drive and follow the restore steps in the <a className="text-accent underline" href={DOCS} target="_blank" rel="noopener noreferrer">backup guide</a>. Backups can only be opened with the passphrase.
      </p>
    </>
  );
}

function StatusTile({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "ok" | "danger" }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-card">
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted">
        {tone === "ok" && <CheckCircle2 className="h-4 w-4 text-ok" />}
        {tone === "danger" && <CircleAlert className="h-4 w-4 text-danger" />}
        {label}
      </p>
      <p className="mt-2 text-lg font-semibold">{value}</p>
      {hint && <p className={cx("mt-1 text-xs", tone === "danger" ? "text-danger" : "text-muted")}>{hint}</p>}
    </div>
  );
}

function DriveCard({ settings, google, onChange }: { settings: Settings; google: Google; onChange: () => void }) {
  const [mode, setMode] = useState<"oauth" | "service_account">((settings.mode as "oauth") || "oauth");
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [sa, setSa] = useState("");
  const [sharedDrive, setSharedDrive] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(!settings.connected);
  const [editClient, setEditClient] = useState(!google.client_id || !google.secret_set);
  const [manual, setManual] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const redirectUri = `${origin}/admin/backups/google`;

  // Sign in with Google: the panel builds the consent link and Google sends the admin back to
  // /admin/backups/google, which finishes the connection. No token to copy by hand.
  async function signIn() {
    setBusy(true);
    try {
      const res = await api<{ url: string }>("/admin/backup/google/start", {
        json: { redirect_uri: redirectUri, client_id: editClient ? clientId.trim() : "", client_secret: editClient ? clientSecret.trim() : "" },
      });
      window.location.href = res.url;
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/admin/backup/credentials", {
        json: { mode, token: token.trim(), client_id: clientId, client_secret: clientSecret, service_account: sa.trim(), shared_drive_id: sharedDrive.trim() },
      });
      toast.ok("Google Drive connected");
      setToken(""); setSa(""); setClientSecret("");
      setEditing(false);
      onChange();
    } catch (err) {
      toast.error((err as Error).message);
      onChange();
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    try {
      await api("/admin/backup/test", { method: "POST" });
      toast.ok("Google Drive is reachable");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!(await confirmDialog({ title: "Disconnect Google Drive?", message: "Scheduled backups stop. Backups already on Drive are not deleted.", confirmLabel: "Disconnect", danger: true }))) return;
    await api("/admin/backup/disconnect", { method: "POST" });
    setEditing(true);
    onChange();
  }

  return (
    <Card
      title="Google Drive"
      description="Where backups are stored"
      actions={settings.connected ? <Badge tone="ok" dot>Connected · {settings.mode === "service_account" ? "service account" : google.account || "Google account"}</Badge> : <Badge>Not connected</Badge>}
    >
      <div className="p-5">
        {settings.connected && !editing ? (
          <div className="flex flex-wrap gap-2">
            <Button onClick={test} loading={busy}><Plug className="h-4 w-4" /> Test connection</Button>
            <Button onClick={() => setEditing(true)}>{settings.mode === "oauth" ? "Reconnect" : "Replace key"}</Button>
            <Button variant="danger" onClick={disconnect}><Unplug className="h-4 w-4" /> Disconnect</Button>
          </div>
        ) : (
          <form onSubmit={connect} className="space-y-4">
            <Segmented label="Connection method" value={mode} onChange={setMode} options={[{ value: "oauth", label: "Google account" }, { value: "service_account", label: "Service account" }]} />
            {mode === "oauth" && !manual ? (
              <div className="space-y-4">
                {editClient ? (
                  <>
                    <ol className="list-decimal space-y-1.5 pl-5 text-sm text-text-2">
                      <li>In <a className="text-accent underline" href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer">Google Cloud Console</a> enable the <b>Google Drive API</b>.</li>
                      <li>Under <i>Google Auth Platform → Clients</i> create a client of type <b>Web application</b>.</li>
                      <li>Add this address under <b>Authorized redirect URIs</b>:</li>
                    </ol>
                    <div className="flex items-center gap-1 rounded-lg border border-border bg-sunken py-1 pr-1 pl-3">
                      <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={redirectUri}>{redirectUri}</code>
                      <CopyText value={redirectUri} label="Copy redirect address" />
                    </div>
                    <p className="text-xs text-muted">Under <i>Audience</i>, publish the app (<b>In production</b>), or choose <b>Internal</b> on Google Workspace. While it is in <i>Testing</i>, Google ends the connection after 7 days.</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Client ID"><Input value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={google.client_id || "123…apps.googleusercontent.com"} autoComplete="off" /></Field>
                      <Field label="Client secret"><Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={google.secret_set ? "Saved (leave empty to keep)" : "GOCSPX-…"} autoComplete="new-password" /></Field>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-muted">
                    Sign in with the Google account that should store the backups and allow access. You come back here automatically.{" "}
                    <span className="text-xs">OAuth client <code className="text-[12px]">{google.client_id.split("-")[0]}…</code> · <button type="button" className="text-accent hover:underline" onClick={() => setEditClient(true)}>change</button></span>
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" variant="primary" loading={busy} onClick={signIn} disabled={editClient && (!(clientId.trim() || google.client_id) || !(clientSecret.trim() || google.secret_set))}>
                    <LogIn className="h-4 w-4" /> Connect Google Drive
                  </Button>
                  {settings.connected && <Button type="button" onClick={() => setEditing(false)}>Cancel</Button>}
                  <span className="flex-1" />
                  <button type="button" className="text-xs text-muted hover:text-text hover:underline" onClick={() => setManual(true)}>Paste an rclone token instead</button>
                </div>
              </div>
            ) : mode === "oauth" ? (
              <>
                <p className="text-sm text-muted">
                  On your own computer run <code className="rounded bg-sunken px-1.5 py-0.5 text-[12px]">rclone authorize &quot;drive&quot;</code>, sign in with Google, and paste the JSON it prints.
                </p>
                <Field label="Sign-in token">
                  <Textarea value={token} onChange={(e) => setToken(e.target.value)} placeholder='{"access_token":"ya29…","refresh_token":"1//0…","expiry":"…"}' className="font-mono text-xs" rows={4} required />
                </Field>
                <details className="text-sm">
                  <summary className="text-muted">Own OAuth client (optional, recommended for large organisations)</summary>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <Field label="Client ID"><Input value={clientId} onChange={(e) => setClientId(e.target.value)} autoComplete="off" /></Field>
                    <Field label="Client secret"><Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="new-password" /></Field>
                  </div>
                </details>
              </>
            ) : (
              <>
                <p className="text-sm text-muted">For Google Workspace: a service account key (JSON) plus a Shared drive the service account is a member of.</p>
                <Field label="Service account key (JSON)">
                  <Textarea value={sa} onChange={(e) => setSa(e.target.value)} placeholder='{"type": "service_account", …}' className="font-mono text-xs" rows={4} required />
                </Field>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,application/json"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) setSa(await f.text());
                  }}
                />
                <Button size="sm" onClick={() => fileRef.current?.click()}>Load from file</Button>
                <Field label="Shared drive ID" hint="The last part of the Shared drive's address in drive.google.com.">
                  <Input value={sharedDrive} onChange={(e) => setSharedDrive(e.target.value)} placeholder="0AbCdEfGhIjKlMnOpQ" required />
                </Field>
              </>
            )}
            {(mode !== "oauth" || manual) && (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="submit" variant="primary" loading={busy}><Plug className="h-4 w-4" /> Connect</Button>
                {settings.connected && <Button onClick={() => setEditing(false)}>Cancel</Button>}
                {manual && <><span className="flex-1" /><button type="button" className="text-xs text-muted hover:text-text hover:underline" onClick={() => setManual(false)}>Use Google sign-in instead</button></>}
              </div>
            )}
          </form>
        )}
      </div>
    </Card>
  );
}

function ScheduleCard({ settings, intervals, ready, onSaved }: { settings: Settings; intervals: number[]; ready: boolean; onSaved: () => void }) {
  const [form, setForm] = useState({ enabled: settings.enabled, interval_hours: settings.interval_hours, hour: settings.hour, keep: settings.keep, include_mail: settings.include_mail, folder: settings.folder });
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify({ enabled: settings.enabled, interval_hours: settings.interval_hours, hour: settings.hour, keep: settings.keep, include_mail: settings.include_mail, folder: settings.folder });

  async function save() {
    setBusy(true);
    try {
      await api("/admin/backup/settings", { method: "PUT", json: form });
      toast.ok("Backup schedule saved");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Schedule" actions={<Toggle label="Scheduled backups" checked={form.enabled} disabled={!ready && !form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />}>
      <div className="grid gap-4 p-5 sm:grid-cols-2">
        <Field label="Frequency">
          <Select value={form.interval_hours} onChange={(e) => setForm({ ...form, interval_hours: Number(e.target.value) })}>
            {intervals.map((h) => <option key={h} value={h}>{intervalLabel(h)}</option>)}
          </Select>
        </Field>
        <Field label="Time of day" hint={form.interval_hours >= 24 ? "Server time" : "Used for daily and weekly backups"}>
          <Select value={form.hour} disabled={form.interval_hours < 24} onChange={(e) => setForm({ ...form, hour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
          </Select>
        </Field>
        <Field label="Backups to keep" hint="Older backups are deleted from Drive.">
          <Input type="number" min={1} max={999} value={form.keep} onChange={(e) => setForm({ ...form, keep: Number(e.target.value) })} />
        </Field>
        <Field label="Drive folder">
          <Input value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} pattern="[A-Za-z0-9._\-]{1,100}" />
        </Field>
        <label className="flex items-start gap-3 sm:col-span-2">
          <Toggle label="Include mailboxes" checked={form.include_mail} onChange={(v) => setForm({ ...form, include_mail: v })} />
          <span className="text-sm">
            <span className="font-medium">Include all mailboxes</span>
            <span className="block text-muted">Off: only the database and configuration (small and fast). On: every message too.</span>
          </span>
        </label>
        <div className="sm:col-span-2">
          <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>Save schedule</Button>
        </div>
      </div>
    </Card>
  );
}

function PassphraseCard({ isSet, onSaved }: { isSet: boolean; onSaved: () => void }) {
  const [pass, setPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (pass !== confirmPass) {
      toast.error("The passphrases do not match");
      return;
    }
    setBusy(true);
    try {
      await api("/admin/backup/passphrase", { json: { passphrase: pass } });
      toast.ok("Encryption passphrase saved");
      setPass(""); setConfirmPass("");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Encryption" actions={isSet ? <Badge tone="ok" dot>Passphrase set</Badge> : <Badge tone="warn" dot>Required</Badge>}>
      <form onSubmit={save} className="space-y-4 p-5">
        <p className="text-sm text-muted">
          Backups are encrypted with AES-256. <b className="text-text">Store the passphrase outside this server</b>: without it no backup can be restored.
          {isSet && " Changing it only affects new backups."}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={isSet ? "New passphrase" : "Passphrase"} hint="At least 12 characters.">
            <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} minLength={12} autoComplete="new-password" required />
          </Field>
          <Field label="Repeat passphrase">
            <Input type="password" value={confirmPass} onChange={(e) => setConfirmPass(e.target.value)} minLength={12} autoComplete="new-password" required />
          </Field>
        </div>
        <Button type="submit" loading={busy}><KeyRound className="h-4 w-4" /> {isSet ? "Change passphrase" : "Save passphrase"}</Button>
      </form>
    </Card>
  );
}

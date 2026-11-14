"use client";

import { BellRing, CheckCircle2, ExternalLink, KeyRound, Lock, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { api, formatDate, useLoad } from "@/lib/api";
import { Badge, Button, Card, Field, Input, Notice, PageHeader, PageSkeleton, Textarea, Toggle, confirmDialog, toast } from "@/components/ui";

type Status = {
  configured: boolean;
  unreadable: boolean;
  show_preview: boolean;
  devices: number;
  mailboxes: number;
  project_id?: string;
  sender_id?: string;
  app_id?: string;
  service_account?: string;
  vapid_key?: string;
  updated_at?: string;
};

const CONSOLE = "https://console.firebase.google.com/";

export default function PushNotifications() {
  const status = useLoad<Status>("/admin/push");
  const [editing, setEditing] = useState(false);

  if (status.loading || !status.data) return <PageSkeleton />;
  const s = status.data;
  const showForm = !s.configured || editing;

  async function setPreview(on: boolean) {
    try {
      status.setData(await api<Status>("/admin/push/preview", { method: "PUT", json: { show_preview: on } }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function remove() {
    if (!(await confirmDialog({
      title: "Remove the Firebase credentials?",
      message: "Notifications stop for every user, and all registered browsers are forgotten.",
      confirmLabel: "Remove", danger: true,
    }))) return;
    try {
      status.setData(await api<Status>("/admin/push", { method: "DELETE" }));
      toast.ok("Firebase credentials removed");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Push notifications"
        description="Notify users of new mail in their browser, even when the webmail is closed, through Firebase Cloud Messaging."
        action={<a href={CONSOLE} target="_blank" rel="noopener noreferrer"><Button variant="ghost"><ExternalLink className="h-4 w-4" /> Firebase console</Button></a>}
      />

      {s.unreadable && (
        <div className="mb-5">
          <Notice tone="danger" title="The saved credentials cannot be decrypted">
            The server&apos;s secret key changed since they were saved. Enter the credentials again.
          </Notice>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          {s.configured && !editing && (
            <Card
              title="Firebase project"
              actions={<Badge tone="ok" dot>Active</Badge>}
            >
              <dl className="grid gap-x-6 gap-y-3 p-5 text-[13px] sm:grid-cols-2">
                <Item label="Project ID" value={s.project_id} />
                <Item label="Sender ID" value={s.sender_id} />
                <Item label="Service account" value={s.service_account} />
                <Item label="Web Push key" value={s.vapid_key} />
                <Item label="Saved" value={s.updated_at ? formatDate(s.updated_at, true) : "—"} />
                <Item label="Browsers registered" value={`${s.devices} (${s.mailboxes} mailbox${s.mailboxes === 1 ? "" : "es"})`} />
              </dl>
              <div className="flex flex-wrap gap-2 border-t border-border px-5 py-3.5">
                <Button onClick={() => setEditing(true)}><KeyRound className="h-4 w-4" /> Replace credentials</Button>
                <Button variant="danger" onClick={remove}><Trash2 className="h-4 w-4" /> Remove</Button>
              </div>
            </Card>
          )}
          {showForm && (
            <CredentialsForm
              replacing={s.configured}
              onCancel={s.configured ? () => setEditing(false) : undefined}
              onSaved={(next) => { status.setData(next); setEditing(false); }}
            />
          )}
          <Card title="Privacy" padded>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium">Show the sender and subject in notifications</span>
              <Toggle checked={s.show_preview} onChange={setPreview} label="Show the sender and subject in notifications" />
            </div>
            <p className="mt-2 text-[13px] text-muted">
              When on, the sender and subject are sent through Google&apos;s push service to the user&apos;s browser. When off, notifications only say &ldquo;New message&rdquo;.
            </p>
          </Card>
        </div>

        <Card title="How to get the credentials" className="self-start">
          <ol className="list-decimal space-y-2.5 p-5 pl-9 text-[13px] text-text-2">
            <li>In the <a className="text-accent underline" href={CONSOLE} target="_blank" rel="noopener noreferrer">Firebase console</a> create a project (or open yours).</li>
            <li><b>Project settings → General → Your apps</b>: add a <b>Web</b> app and copy its <code>firebaseConfig</code>.</li>
            <li><b>Project settings → Cloud Messaging → Web Push certificates</b>: click <b>Generate key pair</b> and copy the key.</li>
            <li><b>Project settings → Service accounts</b>: click <b>Generate new private key</b>. A JSON file downloads.</li>
            <li>Paste all three here and save. The server checks them with Google first.</li>
          </ol>
          <p className="flex items-start gap-2 border-t border-border px-5 py-3.5 text-xs text-muted">
            <Lock className="mt-px h-3.5 w-3.5 shrink-0" />
            Stored encrypted in the database with a key derived from the server&apos;s secret key, which is kept outside the database. The private key is never shown again.
          </p>
        </Card>
      </div>
    </>
  );
}

function Item({ label, value }: { label: string; value?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-medium" title={value}>{value || "—"}</dd>
    </div>
  );
}

function CredentialsForm({ replacing, onSaved, onCancel }: { replacing: boolean; onSaved: (s: Status) => void; onCancel?: () => void }) {
  const [webConfig, setWebConfig] = useState("");
  const [vapid, setVapid] = useState("");
  const [sa, setSa] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const next = await api<Status>("/admin/push", { method: "PUT", json: { web_config: webConfig, vapid_key: vapid, service_account: sa } });
      setWebConfig(""); setVapid(""); setSa("");
      toast.ok("Firebase connected. Users can now turn on notifications in the webmail.");
      onSaved(next);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title={replacing ? "Replace Firebase credentials" : "Connect Firebase"} description="Checked with Google before saving, then stored encrypted">
      <form onSubmit={save} className="space-y-4 p-5">
        <Field label="Web app config" hint="The firebaseConfig block from Project settings → Your apps. Paste it as shown, JavaScript or JSON.">
          <Textarea
            value={webConfig}
            onChange={(e) => setWebConfig(e.target.value)}
            rows={6}
            required
            className="font-mono text-xs"
            placeholder={'const firebaseConfig = {\n  apiKey: "AIza…",\n  authDomain: "…",\n  projectId: "…",\n  messagingSenderId: "…",\n  appId: "…"\n};'}
          />
        </Field>
        <Field label="Web Push certificate (key pair)" hint="Project settings → Cloud Messaging → Web Push certificates.">
          <Input value={vapid} onChange={(e) => setVapid(e.target.value)} required autoComplete="off" className="font-mono text-xs" placeholder="BKx…" />
        </Field>
        <Field label="Service account key (JSON)" hint="Project settings → Service accounts → Generate new private key.">
          <Textarea value={sa} onChange={(e) => setSa(e.target.value)} rows={4} required className="font-mono text-xs" placeholder='{"type": "service_account", …}' />
        </Field>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setSa(await f.text());
            e.target.value = "";
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy}><CheckCircle2 className="h-4 w-4" /> Save and connect</Button>
          <Button type="button" onClick={() => fileRef.current?.click()}><BellRing className="h-4 w-4" /> Load key file</Button>
          {onCancel && <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>}
        </div>
      </form>
    </Card>
  );
}

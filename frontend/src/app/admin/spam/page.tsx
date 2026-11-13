"use client";

import { ShieldAlert, ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";
import { api, useLoad } from "@/lib/api";
import { Button, Card, Field, Input, PageHeader, PageSkeleton, Toggle, confirmDialog, cx, toast } from "@/components/ui";

type Features = {
  spam_filter: boolean;
  redis: boolean;
  greylist: boolean;
  junk_score: number;
  reject_score: number;
  track_subjects: boolean;
};

function Row({ title, description, children, muted }: { title: string; description: string; children: React.ReactNode; muted?: boolean }) {
  return (
    <div className={cx("flex items-start justify-between gap-4 py-4", muted && "opacity-50")}>
      <div className="min-w-0">
        <p className="font-medium">{title}</p>
        <p className="mt-0.5 text-sm text-muted">{description}</p>
      </div>
      <div className="shrink-0 pt-0.5">{children}</div>
    </div>
  );
}

export default function SpamPage() {
  const { data, loading, setData } = useLoad<Features>("/admin/features");
  const [form, setForm] = useState<Features | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  if (loading || !form) return <PageSkeleton />;

  const dirty = JSON.stringify(form) !== JSON.stringify(data);
  const set = <K extends keyof Features>(key: K, value: Features[K]) => setForm({ ...form, [key]: value });

  async function save() {
    if (!form) return;
    if (data?.spam_filter && !form.spam_filter && !(await confirmDialog({ title: "Turn the spam filter off?", message: "Incoming mail will be delivered to inboxes without spam checks. Mail filter rules keep working.", confirmLabel: "Turn off", danger: true }))) return;
    setBusy(true);
    try {
      const saved = await api<Features>("/admin/features", { method: "PUT", json: form });
      setData(saved);
      setForm(saved);
      toast.ok("Saved and applied to the mail server");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Spam filter" description="Rspamd checks incoming mail. Changes are applied to the mail server immediately." />

      {!form.spam_filter && (
        <Card className="mb-4 flex items-start gap-3 border-warn/40 bg-warn-soft p-4 text-warn">
          <ShieldOff className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="text-sm">
            The spam filter is off: incoming mail is delivered without any spam or virus checks. Outgoing mail is still signed with DKIM.
          </p>
        </Card>
      )}

      <Card className="mb-5 divide-y divide-border px-5">
        <Row title="Spam filter" description="Scan incoming mail and move likely spam to the Junk folder.">
          <Toggle label="Spam filter" checked={form.spam_filter} onChange={(v) => set("spam_filter", v)} />
        </Row>

        <div className={cx("grid gap-4 py-4 sm:grid-cols-2", !form.spam_filter && "pointer-events-none opacity-50")}>
          <Field label="Junk score" hint="Mail scoring at least this much goes to the Junk folder. Lower is stricter (default 6).">
            <Input type="number" step="0.5" min={1} max={199} value={form.junk_score} disabled={!form.spam_filter} onChange={(e) => set("junk_score", Number(e.target.value))} />
          </Field>
          <Field label="Reject score" hint="Mail scoring at least this much is refused outright (default 15).">
            <Input type="number" step="0.5" min={2} max={200} value={form.reject_score} disabled={!form.spam_filter} onChange={(e) => set("reject_score", Number(e.target.value))} />
          </Field>
        </div>

        <Row
          title="Greylisting"
          description="Ask unknown senders to retry after a few minutes. Stops a lot of spam, but delays first mail from new senders. Needs Redis."
          muted={!form.spam_filter || !form.redis}
        >
          <Toggle label="Greylisting" checked={form.greylist && form.redis} onChange={(v) => form.redis && set("greylist", v)} />
        </Row>

        <Row
          title="Redis"
          description="Memory store used by the spam filter for learning (Bayes), greylisting and rate limits. Turning it off saves about 50–100 MB of RAM; the spam filter keeps working with fewer checks."
        >
          <Toggle label="Redis" checked={form.redis} onChange={(v) => setForm({ ...form, redis: v, greylist: v ? form.greylist : false })} />
        </Row>
      </Card>

      <Card className="divide-y divide-border px-5">
        <Row
          title="Record subjects in the message log"
          description="Shows each message's subject line in the Message log and reports. Message bodies are never recorded. Check your privacy policy and local law before turning this on."
        >
          <Toggle label="Record subjects" checked={form.track_subjects} onChange={(v) => set("track_subjects", v)} />
        </Row>
      </Card>

      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={save} loading={busy} disabled={!dirty}>
          {!busy && <ShieldAlert className="h-4 w-4" />} Save and apply
        </Button>
        {dirty && (
          <Button variant="ghost" onClick={() => data && setForm(data)} disabled={busy}>
            Discard changes
          </Button>
        )}
      </div>
    </>
  );
}

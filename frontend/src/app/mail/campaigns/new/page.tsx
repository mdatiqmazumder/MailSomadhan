"use client";

import type { Editor } from "@tiptap/react";
import { Clock, Eye, FileUp, Info, Paperclip, Send, Shuffle, Timer, Users, X, Zap } from "lucide-react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, formatBytes, useLoad } from "@/lib/api";
import { type Limits, averageGap, duration } from "@/lib/campaign";
import { type Recipient, parseRecipients } from "@/lib/recipients";
import MessageBody from "@/components/mail/MessageBody";
import { Badge, Button, Card, Field, Input, Modal, Notice, PageHeader, Textarea, Toggle, cx, toast } from "@/components/ui";

const RichEditor = dynamic(() => import("@/components/RichEditor"), { ssr: false });

type Mode = "instant" | "fixed" | "random";
type Preview = { subject: string; html: string; to: string; valid: number; invalid: string[]; invalid_count: number; duplicates: number; suppressed: number; missing_fields: Record<string, number> };

const MODES: { value: Mode; label: string; icon: typeof Zap; text: string }[] = [
  { value: "instant", label: "Send now", icon: Zap, text: "All at once, about one per second." },
  { value: "fixed", label: "Fixed interval", icon: Timer, text: "One message every few minutes." },
  { value: "random", label: "Random interval", icon: Shuffle, text: "A random pause within a range between messages." },
];

function Step({ n, title, description, children }: { n: number; title: string; description?: string; children: React.ReactNode }) {
  return (
    <Card>
      <header className="flex items-start gap-3 border-b border-border px-5 py-3.5">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">{n}</span>
        <div>
          <h2 className="text-[15px] font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
        </div>
      </header>
      <div className="p-5">{children}</div>
    </Card>
  );
}

export default function NewCampaign() {
  const router = useRouter();
  const limits = useLoad<Limits>("/mail/campaigns/limits");
  const [raw, setRaw] = useState("");
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const html = useRef("");
  const [htmlTick, setHtmlTick] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<Mode>("random");
  const [intervalMin, setIntervalMin] = useState(2);
  const [randMin, setRandMin] = useState(1);
  const [randMax, setRandMax] = useState(5);
  const [scheduleLater, setScheduleLater] = useState(false);
  const [startAt, setStartAt] = useState("");
  const [unsubscribe, setUnsubscribe] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const editor = useRef<Editor | null>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<"subject" | "body">("body");

  const parsed = useMemo(() => parseRecipients(raw), [raw]);
  const unique = useMemo(() => {
    const seen = new Set<string>();
    return parsed.recipients.filter((r) => (seen.has(r.email.toLowerCase()) ? false : (seen.add(r.email.toLowerCase()), true)));
  }, [parsed]);
  const fields = useMemo(() => ["name", "first_name", "company", ...parsed.columns.filter((c) => !["name", "first_name", "company"].includes(c))], [parsed.columns]);
  const lim = limits.data;
  const timing = { mode, interval_seconds: intervalMin * 60, random_min_seconds: randMin * 60, random_max_seconds: randMax * 60 };
  const estimate = Math.max(0, unique.length - 1) * averageGap(timing);
  const remainingToday = lim ? Math.max(0, lim.daily_limit - lim.used_24h) : 0;
  const attachBytes = files.reduce((s, f) => s + f.size, 0);
  const tooBig = lim ? attachBytes > lim.max_attachment_mb * 1024 * 1024 : false;

  const onEditor = useCallback((e: Editor) => { editor.current = e; }, []);

  function insertField(f: string) {
    const token = `{{${f}}}`;
    if (lastFocus.current === "subject" && subjectRef.current) {
      const el = subjectRef.current;
      const pos = el.selectionStart ?? subject.length;
      setSubject(subject.slice(0, pos) + token + subject.slice(el.selectionEnd ?? pos));
      requestAnimationFrame(() => { el.focus(); el.setSelectionRange(pos + token.length, pos + token.length); });
    } else {
      editor.current?.chain().focus().insertContent(token).run();
    }
  }

  // Server-side check (suppressed addresses, missing fields) shortly after the inputs settle.
  useEffect(() => {
    if (!unique.length && !subject && !html.current) { setPreview(null); return; }
    const t = setTimeout(async () => {
      try {
        setPreview(await api<Preview>("/mail/campaigns/preview", { json: { subject, html: html.current, unsubscribe, recipients: unique.slice(0, 5000) } }));
      } catch { /* shown on send */ }
    }, 600);
    return () => clearTimeout(t);
  }, [unique, subject, htmlTick, unsubscribe]);

  async function loadCsv(file: File) {
    const text = await file.text();
    setRaw(text);
  }

  const problems: string[] = [];
  if (!unique.length) problems.push("Add at least one recipient.");
  if (lim && unique.length > lim.max_recipients) problems.push(`At most ${lim.max_recipients} recipients per campaign.`);
  if (!subject.trim()) problems.push("Add a subject.");
  if (!html.current.replace(/<[^>]+>|&nbsp;|\s/g, "")) problems.push("Write the message.");
  if (mode === "random" && (randMin < 1 || randMax < randMin)) problems.push("The random range is invalid.");
  if (mode === "fixed" && intervalMin <= 0) problems.push("The interval must be at least a few seconds.");
  if (tooBig) problems.push(`Attachments exceed ${lim?.max_attachment_mb} MB.`);
  if (scheduleLater && !startAt) problems.push("Choose a start time.");

  async function submit() {
    if (problems.length) { toast.error(problems[0]); return; }
    setBusy(true);
    try {
      const form = new FormData();
      form.set("data", JSON.stringify({
        name, subject, html: html.current, mode, unsubscribe, recipients: unique,
        interval_seconds: Math.round(intervalMin * 60), random_min_seconds: Math.round(randMin * 60), random_max_seconds: Math.round(randMax * 60),
        start_at: scheduleLater && startAt ? new Date(startAt).toISOString() : undefined,
      }));
      files.forEach((f) => form.append("files", f, f.name));
      const c = await api<{ id: number; status: string }>("/mail/campaigns", { form });
      toast.ok(c.status === "pending_approval" ? "Campaign created; waiting for administrator approval" : "Campaign started");
      router.push(`/mail/campaigns/${c.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="New campaign" description="Each recipient receives a separate email addressed only to them. Replies come back to your inbox." />
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-5">
          <Step n={1} title="Recipients" description="Paste addresses (one per line, optionally “email, name, company”) or upload a CSV with an email column.">
            <Textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              rows={7}
              className="font-mono text-[12.5px]"
              placeholder={"email,name,company\nrahim@client.com,Rahim Uddin,Client Ltd\nsara@partner.co,Sara Khan,Partner Co"}
              aria-label="Recipients"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input ref={csvInput} type="file" accept=".csv,text/csv,text/plain" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) loadCsv(f); e.target.value = ""; }} />
              <Button size="sm" onClick={() => csvInput.current?.click()}><FileUp className="h-4 w-4" /> Upload CSV</Button>
              <span className="flex-1" />
              <Badge tone={unique.length ? "accent" : "muted"}><Users className="h-3 w-3" /> {unique.length} recipient{unique.length === 1 ? "" : "s"}</Badge>
              {parsed.recipients.length > unique.length && <Badge tone="warn">{parsed.recipients.length - unique.length} duplicates removed</Badge>}
              {parsed.invalid.length > 0 && <Badge tone="danger">{parsed.invalid.length} invalid</Badge>}
              {!!preview?.suppressed && <Badge tone="warn">{preview.suppressed} unsubscribed or bounced, will be skipped</Badge>}
            </div>
            {parsed.invalid.length > 0 && (
              <p className="mt-2 text-xs break-words text-danger">Not valid: {parsed.invalid.slice(0, 5).join(" · ")}{parsed.invalid.length > 5 ? " …" : ""}</p>
            )}
            {parsed.columns.length > 0 && (
              <p className="mt-2 text-xs text-muted">Columns found: {parsed.columns.map((c) => <code key={c} className="mr-1 rounded bg-sunken px-1">{c}</code>)}</p>
            )}
          </Step>

          <Step n={2} title="Message" description="Insert fields to personalise each email. {{first_name|there}} uses “there” when a name is missing.">
            <div className="space-y-4">
              <Field label="Campaign name" hint="Only you see this.">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="November partner outreach" maxLength={200} />
              </Field>
              <Field label="Subject">
                <Input ref={subjectRef} value={subject} onFocus={() => (lastFocus.current = "subject")} onChange={(e) => setSubject(e.target.value)} placeholder="Quick question, {{first_name|there}}" />
              </Field>
              <div>
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[13px] font-medium">Insert field</span>
                  {fields.map((f) => (
                    <button key={f} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => insertField(f)} className="rounded-md border border-border bg-raised px-2 py-0.5 font-mono text-xs hover:border-accent hover:text-accent">
                      {`{{${f}}}`}
                    </button>
                  ))}
                </div>
                <div className="overflow-hidden rounded-lg border border-border" onFocusCapture={() => (lastFocus.current = "body")}>
                  <RichEditor
                    initialHtml=""
                    minHeight={240}
                    placeholder="Hi {{first_name|there}}, …"
                    onEditor={onEditor}
                    onChange={(v) => { html.current = v; setHtmlTick((t) => t + 1); }}
                  />
                </div>
                {preview && Object.keys(preview.missing_fields).length > 0 && (
                  <p className="mt-2 text-xs text-warn">
                    {Object.entries(preview.missing_fields).map(([f, n]) => `${n} recipient${n > 1 ? "s have" : " has"} no “${f}”`).join(" · ")}. Add a fallback like {"{{"}{Object.keys(preview.missing_fields)[0]}|…{"}}"} or the field is left empty.
                  </p>
                )}
              </div>
              <div>
                <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) setFiles((cur) => [...cur, ...Array.from(e.target.files!)]); e.target.value = ""; }} />
                <Button size="sm" onClick={() => fileInput.current?.click()}><Paperclip className="h-4 w-4" /> Attach files</Button>
                {files.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {files.map((f, i) => (
                      <span key={i} className="inline-flex items-center gap-1.5 rounded-md bg-sunken px-2 py-1 text-xs">
                        <Paperclip className="h-3 w-3" /> {f.name} <span className="text-muted">{formatBytes(f.size)}</span>
                        <button aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} className="text-muted hover:text-danger"><X className="h-3 w-3" /></button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Step>

          <Step n={3} title="Sending pace" description="How quickly the emails go out. Limits set by your administrator always apply.">
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Sending pace">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  role="radio"
                  aria-checked={mode === m.value}
                  onClick={() => setMode(m.value)}
                  className={cx("rounded-xl border p-3 text-left transition-colors", mode === m.value ? "border-accent bg-accent-soft" : "border-border hover:bg-hover")}
                >
                  <m.icon className={cx("mb-1.5 h-4 w-4", mode === m.value ? "text-accent" : "text-muted")} />
                  <p className="text-sm font-medium">{m.label}</p>
                  <p className="mt-0.5 text-xs text-muted">{m.text}</p>
                </button>
              ))}
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {mode === "fixed" && (
                <Field label="Minutes between emails">
                  <Input type="number" min={0.25} step={0.25} value={intervalMin} onChange={(e) => setIntervalMin(Number(e.target.value))} />
                </Field>
              )}
              {mode === "random" && (
                <>
                  <Field label="Shortest pause (minutes)">
                    <Input type="number" min={0.25} step={0.25} value={randMin} onChange={(e) => setRandMin(Number(e.target.value))} />
                  </Field>
                  <Field label="Longest pause (minutes)">
                    <Input type="number" min={0.25} step={0.25} value={randMax} onChange={(e) => setRandMax(Number(e.target.value))} />
                  </Field>
                </>
              )}
            </div>
            <div className="mt-4 space-y-3 border-t border-border pt-4">
              <label className="flex items-start gap-3">
                <Toggle label="Schedule for later" checked={scheduleLater} onChange={setScheduleLater} />
                <span className="text-sm"><span className="font-medium">Start later</span><span className="block text-muted">Otherwise sending starts right away.</span></span>
              </label>
              {scheduleLater && (
                <Field label="Start at (your local time)">
                  <Input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} className="w-auto" />
                </Field>
              )}
              <label className="flex items-start gap-3">
                <Toggle label="Unsubscribe link" checked={unsubscribe} onChange={setUnsubscribe} />
                <span className="text-sm">
                  <span className="font-medium">Include an unsubscribe link</span>
                  <span className="block text-muted">Recommended, especially for people who have not emailed you before. Gmail and Yahoo expect it, and people who opt out are skipped automatically next time.</span>
                </span>
              </label>
            </div>
          </Step>
        </div>

        <aside className="lg:sticky lg:top-20 lg:self-start">
          <Card title="Summary">
            <dl className="space-y-3 p-5 text-sm">
              <div className="flex justify-between gap-3"><dt className="text-muted">Recipients</dt><dd className="font-semibold tabular">{unique.length - (preview?.suppressed || 0)}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted">Pace</dt><dd className="text-right">{MODES.find((m) => m.value === mode)?.label}</dd></div>
              <div className="flex justify-between gap-3">
                <dt className="flex items-center gap-1 text-muted"><Clock className="h-3.5 w-3.5" /> Estimated time</dt>
                <dd className="font-medium">{unique.length ? `≈ ${duration(estimate)}` : "—"}</dd>
              </div>
              {lim && (
                <div className="flex justify-between gap-3"><dt className="text-muted">Can send today</dt><dd className="tabular">{remainingToday} of {lim.daily_limit}</dd></div>
              )}
              {files.length > 0 && <div className="flex justify-between gap-3"><dt className="text-muted">Attachments</dt><dd>{formatBytes(attachBytes)}</dd></div>}
            </dl>
            {lim && unique.length > remainingToday && (
              <div className="px-5 pb-4"><Notice tone="accent">Only {remainingToday} can go out in the next 24 hours; the rest continue automatically when the daily limit allows.</Notice></div>
            )}
            {lim && lim.approval_over > 0 && unique.length > lim.approval_over && (
              <div className="px-5 pb-4"><Notice>Campaigns over {lim.approval_over} recipients need administrator approval before they start.</Notice></div>
            )}
            <div className="space-y-2 border-t border-border p-5">
              <Button className="w-full" onClick={() => setShowPreview(true)} disabled={!preview}><Eye className="h-4 w-4" /> Preview</Button>
              <Button className="w-full" variant="primary" onClick={submit} loading={busy} disabled={busy}>
                {!busy && <Send className="h-4 w-4" />} {scheduleLater ? "Schedule campaign" : "Start sending"}
              </Button>
              {problems.length > 0 && <p className="text-xs text-muted">{problems[0]}</p>}
            </div>
          </Card>
          <p className="mt-3 flex gap-2 text-xs text-muted">
            <Info className="h-3.5 w-3.5 shrink-0" />
            Pacing protects against receiving servers rejecting bursts from a new sender. Whether mail lands in the inbox depends mostly on the message being relevant and on few people marking it as spam.
          </p>
        </aside>
      </div>

      {showPreview && preview && (
        <Modal title="Preview" description={`As received by ${preview.to}`} onClose={() => setShowPreview(false)} size="lg">
          <div className="mb-3 rounded-lg border border-border px-3 py-2 text-sm">
            <p><span className="text-muted">To:</span> {preview.to}</p>
            <p><span className="text-muted">Subject:</span> <b>{preview.subject || "(no subject)"}</b></p>
          </div>
          <MessageBody html={preview.html || "<p style='color:#888'>(empty message)</p>"} text="" />
        </Modal>
      )}
    </>
  );
}

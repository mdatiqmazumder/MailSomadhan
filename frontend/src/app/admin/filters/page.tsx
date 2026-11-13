"use client";

import { Ban, CheckCircle2, FileX2, Network, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, formatDate, useLoad } from "@/lib/api";
import { Button, Card, Empty, Field, IconButton, Input, Modal, Notice, PageHeader, Tabs, Textarea, confirmDialog, toast } from "@/components/ui";

type Rule = { id: number; kind: string; value: string; note: string; created_at: string };
type Kind = "block_sender" | "allow_sender" | "block_ip" | "block_ext";

const KINDS: Record<Kind, { label: string; icon: typeof Ban; title: string; help: string; placeholder: string }> = {
  block_sender: {
    label: "Blocked senders", icon: Ban, title: "Block senders",
    help: "Mail from these addresses or whole domains is refused before it reaches any mailbox.",
    placeholder: "spammer@example.com\nbad-domain.com",
  },
  allow_sender: {
    label: "Trusted senders", icon: CheckCircle2, title: "Trust senders",
    help: "Mail from these addresses or domains is never treated as spam (blocked attachments still apply).",
    placeholder: "partner.com\nceo@client.com",
  },
  block_ip: {
    label: "Blocked IP ranges", icon: Network, title: "Block servers",
    help: "Connections from these IP addresses or networks cannot deliver mail.",
    placeholder: "203.0.113.7\n198.51.100.0/24",
  },
  block_ext: {
    label: "Blocked attachments", icon: FileX2, title: "Block attachment types",
    help: "Incoming and outgoing messages carrying files with these extensions are refused.",
    placeholder: "exe\nbat\njs",
  },
};

export default function MailFilters() {
  const { data, reload } = useLoad<{ rules: Rule[]; suggested_extensions: string[] }>("/admin/filters");
  const spam = useLoad<{ spam_filter: boolean }>("/admin/features");
  const [tab, setTab] = useState<Kind>("block_sender");
  const [adding, setAdding] = useState(false);
  const rules = (data?.rules || []).filter((r) => r.kind === tab);
  const meta = KINDS[tab];

  async function remove(r: Rule) {
    if (!(await confirmDialog({ title: `Remove ${r.value}?`, message: "The rule stops applying within a few seconds.", confirmLabel: "Remove", danger: true }))) return;
    try {
      await api(`/admin/filters/${r.id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Mail filters"
        description="Organisation-wide rules applied by the mail server to every message. Changes take effect within seconds."
        action={<Button variant="primary" onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add rule</Button>}
      />
      {spam.data && !spam.data.spam_filter && (
        <div className="mb-4">
          <Notice>The spam filter is off. Filter rules still apply, but trusted senders have no effect until it is turned on again.</Notice>
        </div>
      )}
      <Card>
        <div className="px-5 pt-2">
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={(Object.keys(KINDS) as Kind[]).map((k) => ({ value: k, label: KINDS[k].label, count: (data?.rules || []).filter((r) => r.kind === k).length }))}
          />
        </div>
        <p className="px-5 pt-3 text-sm text-muted">{meta.help}</p>
        {!rules.length ? (
          <Empty icon={meta.icon} title={`No ${meta.label.toLowerCase()} yet`} action={<Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add</Button>} />
        ) : (
          <ul className="mt-3 divide-y divide-border border-t border-border">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-5 py-2.5 hover:bg-raised">
                <meta.icon className="h-4 w-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{tab === "block_ext" ? `.${r.value}` : r.value}</p>
                  {r.note && <p className="truncate text-xs text-muted">{r.note}</p>}
                </div>
                <span className="hidden text-xs text-muted sm:inline">added {formatDate(r.created_at)}</span>
                <IconButton label={`Remove ${r.value}`} onClick={() => remove(r)}><Trash2 className="h-4 w-4" /></IconButton>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {adding && (
        <AddRules
          kind={tab}
          suggestions={tab === "block_ext" ? (data?.suggested_extensions || []).filter((e) => !rules.some((r) => r.value === e)) : []}
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); reload(); }}
        />
      )}
    </>
  );
}

function AddRules({ kind, suggestions, onClose, onDone }: { kind: Kind; suggestions: string[]; onClose: () => void; onDone: () => void }) {
  const meta = KINDS[kind];
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await api<{ added: string[]; skipped: string[] }>("/admin/filters/bulk", { json: { kind, value, note } });
      if (res.skipped.length) toast.error(`Not valid, skipped: ${res.skipped.join(", ")}`);
      if (res.added.length) toast.ok(`${res.added.length} rule${res.added.length > 1 ? "s" : ""} added`);
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal title={meta.title} description={meta.help} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Values" hint="One per line, or separated by commas.">
          <Textarea autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder={meta.placeholder} required rows={5} />
        </Field>
        {suggestions.length > 0 && (
          <div>
            <p className="mb-1.5 text-[13px] font-medium">Commonly blocked</p>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className="rounded-md border border-accent/40 bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent" onClick={() => setValue(suggestions.join("\n"))}>
                Add all
              </button>
              {suggestions.map((s) => (
                <button key={s} type="button" className="rounded-md border border-border px-2 py-0.5 text-xs hover:bg-hover" onClick={() => setValue((v) => (v.trim() ? `${v.trim()}\n${s}` : s))}>
                  .{s}
                </button>
              ))}
            </div>
          </div>
        )}
        <Field label="Note" hint="Optional: why the rule exists.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={busy}>Add</Button>
        </div>
      </form>
    </Modal>
  );
}

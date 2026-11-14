"use client";

import { ChevronLeft, ChevronRight, Download, File as FileIcon, Forward, Inbox, KeyRound, Mail, MailOpen, Paperclip, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, formatBytes, formatDate } from "@/lib/api";
import MessageBody from "@/components/mail/MessageBody";
import { addrFull, addrLabel, type Folder, type ListItem, type Message } from "@/components/mail/types";
import { Badge, Button, Card, Checkbox, Drawer, Empty, Field, IconButton, Input, Notice, PageHeader, PageSkeleton, Select, Spinner, Textarea, Toggle, cx, toast } from "@/components/ui";

type Row = {
  domain_id: number; domain: string; email: string; status: "mailbox" | "alias" | "missing";
  mailbox_id?: number; active?: boolean; forward_to?: string; forward_keep?: boolean; alias_to?: string;
};
type Overview = { auto: boolean; can_change_auto: boolean; domains: Row[]; created?: string[]; failed?: string[] };
type Listing = { total: number; page: number; items: ListItem[] };
const PAGE = 40;

export default function Postmaster() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api<Overview>("/admin/postmaster");
      setData(d);
      setSelected((cur) => cur ?? d.domains[0]?.domain_id ?? null);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <Notice tone="danger">{error}</Notice>;
  if (!data) return <PageSkeleton />;
  const missing = data.domains.filter((d) => d.status === "missing").length;
  const row = data.domains.find((d) => d.domain_id === selected) || null;

  function replace(r: Row) {
    setData((d) => d && { ...d, domains: d.domains.map((x) => (x.domain_id === r.domain_id ? r : x)) });
  }

  async function setupAll() {
    setBusy(true);
    try {
      const res = await api<Overview>("/admin/postmaster-all", { method: "POST" });
      setData(res);
      if (res.created?.length) toast.ok(`Created postmaster@ for ${res.created.length} domain${res.created.length > 1 ? "s" : ""}`);
      res.failed?.forEach((f) => toast.error(f));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function setAuto(on: boolean) {
    try {
      await api("/admin/postmaster-auto", { method: "PUT", json: { enabled: on } });
      setData((d) => d && { ...d, auto: on });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Postmaster"
        description="Every domain needs a postmaster@ address: bounce notices, DMARC reports and abuse complaints are sent there. Read it here, or give it a password for the webmail."
        action={missing > 0 && <Button variant="primary" onClick={setupAll} loading={busy}><Plus className="h-4 w-4" /> Set up {missing} missing</Button>}
      />

      {data.can_change_auto && (
        <div className="mb-5 flex items-center justify-between gap-4 rounded-xl border border-border bg-surface px-5 py-3.5 shadow-card">
          <div>
            <p className="text-sm font-medium">Create postmaster@ automatically for new domains</p>
            <p className="text-[13px] text-muted">Recommended. Mail servers and DMARC reporters expect this address to exist.</p>
          </div>
          <Toggle checked={data.auto} onChange={setAuto} label="Create postmaster automatically for new domains" />
        </div>
      )}

      {!data.domains.length ? (
        <Card><Empty icon={ShieldCheck} title="No domains yet">Add a domain first; its postmaster@ is created with it.</Empty></Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <Card className="self-start">
            <ul className="p-2">
              {data.domains.map((d) => (
                <li key={d.domain_id}>
                  <button
                    onClick={() => setSelected(d.domain_id)}
                    aria-current={d.domain_id === selected ? "true" : undefined}
                    className={cx("flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm",
                      d.domain_id === selected ? "bg-accent-soft font-medium text-accent" : "hover:bg-hover")}
                  >
                    <span className="min-w-0 truncate">{d.domain}</span>
                    {d.status === "mailbox" ? <Badge tone="ok" dot>ready</Badge> : d.status === "alias" ? <Badge>alias</Badge> : <Badge tone="warn" dot>missing</Badge>}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {row && <DomainPanel key={row.domain_id} row={row} onChange={replace} />}
        </div>
      )}
    </>
  );
}

function DomainPanel({ row, onChange }: { row: Row; onChange: (r: Row) => void }) {
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      onChange(await api<Row>(`/admin/postmaster/${row.domain_id}`, { method: "POST" }));
      toast.ok(`${row.email} created`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (row.status === "missing") {
    return (
      <Card>
        <Empty icon={Mail} title={`${row.email} does not exist`} action={<Button variant="primary" onClick={create} loading={busy}><Plus className="h-4 w-4" /> Create {row.email}</Button>}>
          Mail sent to it is refused, and DMARC reports for {row.domain} are lost.
        </Empty>
      </Card>
    );
  }
  if (row.status === "alias") {
    return (
      <Card padded>
        <Notice tone="accent" title={`${row.email} is an alias`}>
          It forwards to <b>{row.alias_to}</b>. To read it here instead, delete the alias under <Link className="text-accent underline" href="/admin/aliases">Aliases</Link> and create the postmaster mailbox.
        </Notice>
      </Card>
    );
  }
  return (
    <div className="min-w-0 space-y-5">
      <MailboxView row={row} />
      <div className="grid gap-5 xl:grid-cols-2">
        <PasswordCard row={row} />
        <ForwardCard row={row} onChange={onChange} />
      </div>
    </div>
  );
}

function MailboxView({ row }: { row: Row }) {
  const base = `/admin/postmaster/${row.domain_id}`;
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folder, setFolder] = useState("INBOX");
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Message | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [f, l] = await Promise.all([
        api<{ folders: Folder[] }>(`${base}/folders`),
        api<Listing>(`${base}/messages?${new URLSearchParams({ folder, page: String(page), size: String(PAGE), q: search })}`),
      ]);
      setFolders(f.folders);
      setListing(l);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [base, folder, page, search]);
  useEffect(() => { load(); }, [load]);

  async function read(item: ListItem) {
    try {
      const msg = await api<Message>(`${base}/message?${new URLSearchParams({ folder, uid: String(item.uid) })}`);
      setOpen(msg);
      setListing((l) => l && { ...l, items: l.items.map((i) => (i.uid === item.uid ? { ...i, seen: true } : i)) });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function act(action: "delete" | "unread", uids: number[]) {
    try {
      await api(`${base}/action`, { json: { folder, uids, action } });
      setOpen(null);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const items = listing?.items || [];
  const total = listing?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <Card
      title={row.email}
      description="Read in the panel. Each message you open is recorded in the audit log."
      actions={
        <>
          <Select value={folder} onChange={(e) => { setFolder(e.target.value); setPage(1); }} aria-label="Folder" className="w-auto min-w-36">
            {(folders.length ? folders : [{ name: "INBOX", role: "inbox", total: 0, unseen: 0 }]).map((f) => (
              <option key={f.name} value={f.name}>{f.role === "inbox" ? "Inbox" : f.name}{f.unseen ? ` (${f.unseen})` : ""}</option>
            ))}
          </Select>
          <IconButton label="Refresh" onClick={load}><RefreshCw className={cx("h-4 w-4", loading && "animate-spin")} /></IconButton>
        </>
      }
    >
      <form className="relative border-b border-border px-5 py-3" onSubmit={(e) => { e.preventDefault(); setPage(1); setSearch(query.trim()); }}>
        <Search className="pointer-events-none absolute top-1/2 left-8 h-4 w-4 -translate-y-1/2 text-muted" />
        <Input type="search" value={query} onChange={(e) => { setQuery(e.target.value); if (!e.target.value && search) { setSearch(""); setPage(1); } }} placeholder="Search subject, sender…" aria-label="Search postmaster mail" className="pl-9" />
      </form>
      {error ? (
        <div className="p-5"><Notice tone="danger">{error}</Notice></div>
      ) : loading && !listing ? (
        <div className="flex justify-center p-10"><Spinner /></div>
      ) : !items.length ? (
        <Empty icon={Inbox} title={search ? "No messages match" : "No mail here"}>{search ? "Try other words." : "Bounce notices and DMARC reports will show up here."}</Empty>
      ) : (
        <>
          <ul>
            {items.map((item) => (
              <li key={item.uid} className="border-b border-border last:border-0">
                <button onClick={() => read(item)} className="flex w-full items-start gap-3 px-5 py-3 text-left hover:bg-hover">
                  {!item.seen ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" /> : <span className="w-2 shrink-0" />}
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={cx("min-w-0 flex-1 truncate text-sm", !item.seen && "font-semibold")}>{item.from.map(addrLabel).join(", ") || "(unknown sender)"}</span>
                      <span className="shrink-0 text-xs text-muted">{formatDate(item.date)}</span>
                    </span>
                    <span className="mt-0.5 flex items-center gap-1.5">
                      <span className={cx("min-w-0 flex-1 truncate text-[13px]", item.seen ? "text-muted" : "font-medium")}>{item.subject || "(no subject)"}</span>
                      {item.has_attachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="Has attachments" />}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {total > PAGE && (
            <div className="flex items-center justify-end gap-1 border-t border-border px-5 py-2 text-xs text-muted">
              {(page - 1) * PAGE + 1}–{Math.min(page * PAGE, total)} of {total}
              <IconButton label="Newer" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></IconButton>
              <IconButton label="Older" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></IconButton>
            </div>
          )}
        </>
      )}
      {open && (
        <Drawer
          title={open.subject || "(no subject)"}
          subtitle={<>{open.from.map(addrFull).join(", ")} · {formatDate(open.date, true)}</>}
          onClose={() => setOpen(null)}
          actions={
            <>
              <IconButton label="Mark as unread" onClick={() => act("unread", [open.uid])}><MailOpen className="h-4 w-4" /></IconButton>
              <IconButton label="Delete" onClick={() => act("delete", [open.uid])}><Trash2 className="h-4 w-4" /></IconButton>
            </>
          }
        >
          <p className="mb-4 text-[13px] break-words text-muted">To: {open.to.map(addrLabel).join(", ") || "—"}</p>
          <MessageBody html={open.html} text={open.text} />
          {open.attachments.length > 0 && (
            <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
              {open.attachments.map((a) => (
                <a
                  key={a.index}
                  href={`/api${base}/attachment?${new URLSearchParams({ folder: open.folder, uid: String(open.uid), index: String(a.index) })}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  download={a.filename}
                  className="flex max-w-full items-center gap-2.5 rounded-lg border border-border px-3 py-2 hover:bg-hover"
                >
                  <FileIcon className="h-5 w-5 shrink-0 text-muted" />
                  <span className="min-w-0">
                    <span className="block max-w-56 truncate text-[13px] font-medium">{a.filename}</span>
                    <span className="block text-xs text-muted">{formatBytes(a.size)}</span>
                  </span>
                  <Download className="h-4 w-4 shrink-0 text-muted" />
                </a>
              ))}
            </div>
          )}
        </Drawer>
      )}
    </Card>
  );
}

function PasswordCard({ row }: { row: Row }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api(`/admin/postmaster/${row.domain_id}/password`, { method: "PUT", json: { password } });
      setPassword("");
      toast.ok(`Password set. ${row.email} can now sign in to the webmail or an email app.`);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Webmail and email apps" description="Optional: give the mailbox a password to use it outside the admin panel.">
      <form onSubmit={save} className="space-y-3 p-5">
        <Field label="New password" hint="Sets or replaces the password. Sessions using the old one are signed out.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Button type="submit" loading={busy} disabled={!password}><KeyRound className="h-4 w-4" /> Set password</Button>
      </form>
    </Card>
  );
}

function ForwardCard({ row, onChange }: { row: Row; onChange: (r: Row) => void }) {
  const [to, setTo] = useState(row.forward_to?.split(",").join(", ") || "");
  const [keep, setKeep] = useState(row.forward_keep ?? true);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      onChange(await api<Row>(`/admin/postmaster/${row.domain_id}/forward`, { method: "PUT", json: { forward_to: to, forward_keep: keep } }));
      toast.ok(to.trim() ? "Forwarding saved" : "Forwarding turned off");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Forward copies" description="Also send postmaster mail to other addresses, for example your own.">
      <form onSubmit={save} className="space-y-3 p-5">
        <Field label="Forward to" hint="Separate addresses with commas. Leave empty to stop forwarding.">
          <Textarea value={to} onChange={(e) => setTo(e.target.value)} rows={2} placeholder="you@example.com" />
        </Field>
        <Checkbox checked={keep} onChange={setKeep} label="Keep a copy here too" />
        <div><Button type="submit" loading={busy}><Forward className="h-4 w-4" /> Save forwarding</Button></div>
      </form>
    </Card>
  );
}

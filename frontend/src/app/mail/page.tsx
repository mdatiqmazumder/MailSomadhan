"use client";

import {
  Archive, ArrowLeft, ChevronLeft, ChevronRight, CornerUpLeft, CornerUpRight, Download, File as FileIcon, FolderIcon,
  FolderPlus, Inbox, LogOut, Mail, MailOpen, Menu, OctagonAlert, Paperclip, PenLine, RefreshCw, ReplyAll, Search,
  Send, Settings, Star, Trash2, X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatBytes, formatDate, logout, useMe } from "@/lib/api";
import Composer from "@/components/mail/Composer";
import MessageBody from "@/components/mail/MessageBody";
import { addrFull, addrLabel, escapeHtml, textToHtml, type Draft, type Folder, type ListItem, type Message } from "@/components/mail/types";
import { Button, IconButton, Spinner, cx, toast, confirmDialog } from "@/components/ui";

const PAGE_SIZE = 40;
const ROLE_ICONS: Record<string, typeof Inbox> = {
  inbox: Inbox, drafts: PenLine, sent: Send, junk: OctagonAlert, trash: Trash2, archive: Archive,
};
const ROLE_LABELS: Record<string, string> = {
  inbox: "Inbox", drafts: "Drafts", sent: "Sent", junk: "Spam", trash: "Trash", archive: "Archive",
};

type Listing = { total: number; page: number; items: ListItem[] };
type Quota = { used_kb: number; limit_kb: number } | null;

function folderLabel(f: Folder) {
  return ROLE_LABELS[f.role] || f.name;
}

export default function MailPage() {
  const { me } = useMe("user");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [quota, setQuota] = useState<Quota>(null);
  const [folder, setFolder] = useState("INBOX");
  const [listing, setListing] = useState<Listing | null>(null);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [loadingList, setLoadingList] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<Message | null>(null);
  const [loadingMessage, setLoadingMessage] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [composerKey, setComposerKey] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const requestId = useRef(0);

  const current = folders.find((f) => f.name === folder);
  const role = current?.role || "";

  const loadFolders = useCallback(async () => {
    try {
      const res = await api<{ folders: Folder[]; quota: Quota }>("/mail/folders");
      setFolders(res.folders);
      setQuota(res.quota);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, []);

  const loadList = useCallback(
    async (quiet = false) => {
      const id = ++requestId.current;
      if (!quiet) setLoadingList(true);
      try {
        const params = new URLSearchParams({ folder, page: String(page), size: String(PAGE_SIZE), q: search });
        const res = await api<Listing>(`/mail/messages?${params}`);
        if (id === requestId.current) setListing(res);
      } catch (err) {
        if (id === requestId.current && !quiet) toast.error((err as Error).message);
      } finally {
        if (id === requestId.current) setLoadingList(false);
      }
    },
    [folder, page, search],
  );

  useEffect(() => {
    if (me) loadFolders();
  }, [me, loadFolders]);

  useEffect(() => {
    if (me) loadList();
  }, [me, loadList]);

  // Check for new mail every minute while the tab is visible.
  useEffect(() => {
    if (!me) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        loadFolders();
        loadList(true);
      }
    }, 60000);
    return () => clearInterval(timer);
  }, [me, loadFolders, loadList]);

  useEffect(() => {
    if (me) document.title = `${current?.unseen ? `(${current.unseen}) ` : ""}${current ? folderLabel(current) : "Mail"} · ${me.brand_name}`;
  }, [me, current]);

  function openFolder(name: string) {
    setFolder(name);
    setPage(1);
    setSearch("");
    setQuery("");
    setSelected(new Set());
    setMessage(null);
    setNavOpen(false);
  }

  function refresh() {
    loadFolders();
    loadList();
  }

  async function openMessage(item: ListItem) {
    if (role === "drafts") {
      return editDraft(item.uid);
    }
    setLoadingMessage(true);
    setMessage(null);
    try {
      const msg = await api<Message>(`/mail/message?${new URLSearchParams({ folder, uid: String(item.uid) })}`);
      setMessage(msg);
      if (!item.seen) {
        setListing((l) => l && { ...l, items: l.items.map((i) => (i.uid === item.uid ? { ...i, seen: true } : i)) });
        setFolders((fs) => fs.map((f) => (f.name === folder ? { ...f, unseen: Math.max(0, f.unseen - 1) } : f)));
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoadingMessage(false);
    }
  }

  async function act(action: string, uids: number[], target?: string) {
    if (!uids.length) return;
    try {
      await api("/mail/action", { json: { folder, uids, action, target } });
      if (["delete", "move", "spam", "notspam", "archive"].includes(action)) {
        if (message && uids.includes(message.uid)) setMessage(null);
        setSelected(new Set());
      }
      loadFolders();
      loadList(true);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  /* ---------------- compose helpers ---------------- */
  function signature() {
    return me && me.kind === "user" && me.signature_html ? `<p></p><p>--</p>${me.signature_html}` : "";
  }

  function startCompose(d: Draft) {
    setDraft(d);
    setComposerKey((k) => k + 1);
  }

  function compose() {
    startCompose({ to: "", cc: "", bcc: "", subject: "", html: signature() });
  }

  function quoteOf(msg: Message, intro: string) {
    const body = msg.html || textToHtml(msg.text);
    return `<br><div>${intro}</div><blockquote style="border-left:3px solid #d5d9e0;margin:8px 0 0 4px;padding-left:12px">${body}</blockquote>`;
  }

  function reply(msg: Message, all: boolean) {
    const mine = me && me.kind === "user" ? me.email.toLowerCase() : "";
    const sender = msg.reply_to.length ? msg.reply_to : msg.from;
    const toList = msg.folder === folders.find((f) => f.role === "sent")?.name ? msg.to : sender;
    const others = all ? [...msg.to, ...msg.cc].filter((a) => a.email.toLowerCase() !== mine && !toList.some((t) => t.email === a.email)) : [];
    const intro = `On ${formatDate(msg.date, true)}, ${escapeHtml(msg.from.map(addrFull).join(", "))} wrote:`;
    startCompose({
      to: toList.map((a) => a.email).join(", "),
      cc: others.map((a) => a.email).join(", "),
      bcc: "",
      subject: /^re:/i.test(msg.subject) ? msg.subject : `Re: ${msg.subject}`,
      html: signature(),
      quotedHtml: quoteOf(msg, intro),
      inReplyTo: msg.message_id,
      references: msg.references,
      replyFolder: msg.folder,
      replyUid: msg.uid,
    });
  }

  function forward(msg: Message) {
    const intro = [
      "---------- Forwarded message ----------",
      `From: ${escapeHtml(msg.from.map(addrFull).join(", "))}`,
      `Date: ${formatDate(msg.date, true)}`,
      `Subject: ${escapeHtml(msg.subject)}`,
      `To: ${escapeHtml(msg.to.map(addrFull).join(", "))}`,
    ].join("<br>");
    startCompose({
      to: "",
      cc: "",
      bcc: "",
      subject: /^fwd?:/i.test(msg.subject) ? msg.subject : `Fwd: ${msg.subject}`,
      html: signature(),
      quotedHtml: quoteOf(msg, intro),
      carryFolder: msg.folder,
      carryUid: msg.uid,
      carryNames: msg.attachments.map((a) => a.filename),
    });
  }

  async function editDraft(uid: number) {
    try {
      const msg = await api<Message>(`/mail/message?${new URLSearchParams({ folder, uid: String(uid) })}`);
      startCompose({
        to: msg.to.map((a) => a.email).join(", "),
        cc: msg.cc.map((a) => a.email).join(", "),
        bcc: "",
        subject: msg.subject,
        html: msg.html || textToHtml(msg.text),
        draftUid: uid,
        carryFolder: folder,
        carryUid: uid,
        carryNames: msg.attachments.map((a) => a.filename),
      });
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function newFolder() {
    const name = window.prompt("Folder name");
    if (!name?.trim()) return;
    try {
      await api("/mail/folders", { json: { name: name.trim() } });
      loadFolders();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function removeFolder(f: Folder) {
    if (!(await confirmDialog({ title: `Delete the folder "${f.name}" and every message in it?`, danger: true }))) return;
    try {
      await api(`/mail/folders?${new URLSearchParams({ name: f.name })}`, { method: "DELETE" });
      if (folder === f.name) openFolder("INBOX");
      loadFolders();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function emptyFolder() {
    if (!current || !(await confirmDialog({ title: `Permanently delete everything in ${folderLabel(current)}?`, danger: true }))) return;
    try {
      await api("/mail/folders/empty", { json: { name: current.name } });
      setMessage(null);
      refresh();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (!me || me.kind !== "user") {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const items = listing?.items || [];
  const total = listing?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allSelected = items.length > 0 && items.every((i) => selected.has(i.uid));
  const selectedUids = [...selected];
  const quotaPct = quota && quota.limit_kb ? Math.min(100, Math.round((quota.used_kb / quota.limit_kb) * 100)) : null;

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* ---------- folders ---------- */}
      {navOpen && <div className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setNavOpen(false)} />}
      <aside
        className={cx(
          "fixed inset-y-0 left-0 z-30 flex w-60 shrink-0 flex-col border-r border-border bg-surface transition-transform md:static md:translate-x-0",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex items-center gap-2 px-4 py-3.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg">
            <Mail className="h-4 w-4" />
          </span>
          <span className="truncate font-semibold">{me.brand_name}</span>
        </div>
        <div className="px-3 pb-2">
          <Button variant="primary" className="w-full" onClick={() => { compose(); setNavOpen(false); }}>
            <PenLine className="h-4 w-4" /> Compose
          </Button>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-1" aria-label="Folders">
          {folders.map((f) => {
            const Icon = ROLE_ICONS[f.role] || FolderIcon;
            const active = f.name === folder;
            const count = f.role === "drafts" ? f.total : f.unseen;
            return (
              <div key={f.name} className="group relative">
                <button
                  onClick={() => openFolder(f.name)}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors",
                    active ? "bg-accent-soft font-medium text-accent" : "hover:bg-hover",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{folderLabel(f)}</span>
                  {count > 0 && <span className={cx("text-xs tabular-nums", !f.role && "group-hover:hidden")}>{count}</span>}
                </button>
                {!f.role && (
                  <button
                    aria-label={`Delete folder ${f.name}`}
                    title="Delete folder"
                    onClick={() => removeFolder(f)}
                    className="absolute top-1.5 right-1.5 hidden h-6 w-6 items-center justify-center rounded-md text-muted group-hover:flex hover:bg-danger-soft hover:text-danger"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            );
          })}
          <button onClick={newFolder} className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-muted hover:bg-hover hover:text-text">
            <FolderPlus className="h-4 w-4" /> New folder
          </button>
          <div className="my-2 border-t border-border" />
          <Link href="/mail/campaigns" className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm hover:bg-hover">
            <Send className="h-4 w-4" /> Campaigns
          </Link>
        </nav>
        <div className="border-t border-border p-3">
          {quotaPct !== null && quota && (
            <div className="mb-3">
              <div className="h-1.5 overflow-hidden rounded-full bg-hover" role="img" aria-label={`${quotaPct}% of storage used`}>
                <div className={quotaPct > 90 ? "h-full bg-danger" : "h-full bg-accent"} style={{ width: `${quotaPct}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted">
                {formatBytes(quota.used_kb * 1024)} of {formatBytes(quota.limit_kb * 1024)} used
              </p>
            </div>
          )}
          <p className="truncate text-[13px] font-medium" title={me.email}>{me.display_name || me.email}</p>
          {me.display_name && <p className="truncate text-xs text-muted">{me.email}</p>}
          <div className="mt-2 flex gap-1">
            <Link href="/account" className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-[13px] hover:bg-hover">
              <Settings className="h-3.5 w-3.5" /> Settings
            </Link>
            <button onClick={logout} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-[13px] hover:bg-hover">
              <LogOut className="h-3.5 w-3.5" /> Sign out
            </button>
          </div>
        </div>
      </aside>

      {/* ---------- message list ---------- */}
      <section className={cx("min-w-0 flex-1 flex-col border-r border-border bg-surface lg:max-w-md lg:flex-none lg:basis-[26rem]", message || loadingMessage ? "hidden lg:flex" : "flex")}>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <IconButton label="Folders" className="md:hidden" onClick={() => setNavOpen(true)}>
            <Menu className="h-5 w-5" />
          </IconButton>
          <form
            className="relative min-w-0 flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              setSearch(query.trim());
            }}
          >
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!e.target.value && search) {
                  setSearch("");
                  setPage(1);
                }
              }}
              placeholder={`Search ${current ? folderLabel(current) : "mail"}`}
              aria-label="Search mail"
              className="h-9 w-full rounded-lg border border-border bg-raised pr-3 pl-9 text-sm placeholder:text-muted/70 focus:border-accent focus:outline-none"
            />
          </form>
          <IconButton label="Refresh" onClick={refresh}>
            <RefreshCw className={cx("h-4 w-4", loadingList && "animate-spin")} />
          </IconButton>
        </div>

        <div className="flex h-10 items-center gap-1 border-b border-border px-3 text-[13px]">
          <input
            type="checkbox"
            aria-label="Select all"
            className="mx-1.5 h-4 w-4 accent-[var(--accent)]"
            checked={allSelected}
            onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.uid)) : new Set())}
          />
          {selected.size > 0 ? (
            <>
              <span className="mr-1 text-muted">{selected.size} selected</span>
              <IconButton label="Mark as read" onClick={() => act("read", selectedUids)}><MailOpen className="h-4 w-4" /></IconButton>
              <IconButton label="Mark as unread" onClick={() => act("unread", selectedUids)}><Mail className="h-4 w-4" /></IconButton>
              {role !== "archive" && role !== "drafts" && (
                <IconButton label="Archive" onClick={() => act("archive", selectedUids)}><Archive className="h-4 w-4" /></IconButton>
              )}
              {role === "junk" ? (
                <IconButton label="Not spam" onClick={() => act("notspam", selectedUids)}><Inbox className="h-4 w-4" /></IconButton>
              ) : (
                role !== "drafts" && role !== "sent" && (
                  <IconButton label="Report spam" onClick={() => act("spam", selectedUids)}><OctagonAlert className="h-4 w-4" /></IconButton>
                )
              )}
              <IconButton label={role === "trash" ? "Delete forever" : "Delete"} onClick={() => act("delete", selectedUids)}><Trash2 className="h-4 w-4" /></IconButton>
            </>
          ) : (
            <>
              <span className="min-w-0 flex-1 truncate font-medium">
                {search ? `Results for "${search}"` : current ? folderLabel(current) : folder}
              </span>
              {(role === "trash" || role === "junk") && total > 0 && !search && (
                <button className="text-xs text-danger hover:underline" onClick={emptyFolder}>Empty</button>
              )}
            </>
          )}
          <span className="flex-1" />
          {total > PAGE_SIZE && (
            <span className="flex shrink-0 items-center text-xs text-muted">
              {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
              <IconButton label="Newer" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft className="h-4 w-4" /></IconButton>
              <IconButton label="Older" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight className="h-4 w-4" /></IconButton>
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loadingList && !items.length ? (
            <div className="flex justify-center p-8"><Spinner /></div>
          ) : !items.length ? (
            <div className="px-6 py-16 text-center text-muted">
              <Inbox className="mx-auto mb-2 h-8 w-8 opacity-50" />
              <p>{search ? "No messages match your search" : "Nothing here yet"}</p>
            </div>
          ) : (
            <ul>
              {items.map((item) => {
                const people = role === "sent" || role === "drafts" ? item.to : item.from;
                const who = people.map(addrLabel).join(", ") || (role === "drafts" ? "(no recipient)" : "(unknown sender)");
                const open = message?.uid === item.uid;
                return (
                  <li key={item.uid} className={cx("flex border-b border-border", open ? "bg-accent-soft" : selected.has(item.uid) ? "bg-hover" : "hover:bg-hover")}>
                    <div className="flex flex-col items-center gap-2 py-3 pl-3">
                      <input
                        type="checkbox"
                        aria-label={`Select message from ${who}`}
                        className="mx-1.5 h-4 w-4 accent-[var(--accent)]"
                        checked={selected.has(item.uid)}
                        onChange={(e) => {
                          const next = new Set(selected);
                          if (e.target.checked) next.add(item.uid);
                          else next.delete(item.uid);
                          setSelected(next);
                        }}
                      />
                      <button
                        aria-label={item.flagged ? "Remove star" : "Add star"}
                        aria-pressed={item.flagged}
                        onClick={() => {
                          setListing((l) => l && { ...l, items: l.items.map((i) => (i.uid === item.uid ? { ...i, flagged: !i.flagged } : i)) });
                          act(item.flagged ? "unstar" : "star", [item.uid]);
                        }}
                      >
                        <Star className={cx("h-4 w-4", item.flagged ? "fill-warn text-warn" : "text-muted/50 hover:text-muted")} />
                      </button>
                    </div>
                    <button className="min-w-0 flex-1 py-2.5 pr-3 pl-2 text-left" onClick={() => openMessage(item)}>
                      <span className="flex items-baseline gap-2">
                        <span className={cx("min-w-0 flex-1 truncate", !item.seen && "font-semibold")}>{who}</span>
                        <span className={cx("shrink-0 text-xs", item.seen ? "text-muted" : "font-semibold text-accent")}>{formatDate(item.date)}</span>
                      </span>
                      <span className="mt-0.5 flex items-center gap-1.5">
                        {!item.seen && <span className="h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="Unread" />}
                        {item.answered && <CornerUpLeft className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="Replied" />}
                        <span className={cx("min-w-0 flex-1 truncate text-[13px]", item.seen ? "text-muted" : "font-medium")}>{item.subject || "(no subject)"}</span>
                        {item.has_attachments && <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="Has attachments" />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* ---------- reader ---------- */}
      <section className={cx("min-w-0 flex-1 flex-col bg-surface", message || loadingMessage ? "flex" : "hidden lg:flex")}>
        {loadingMessage ? (
          <div className="flex flex-1 items-center justify-center"><Spinner /></div>
        ) : !message ? (
          <div className="flex flex-1 flex-col items-center justify-center text-muted">
            <MailOpen className="mb-2 h-10 w-10 opacity-40" />
            <p>Select a message to read it</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1 border-b border-border px-3 py-2">
              <IconButton label="Back to list" className="lg:hidden" onClick={() => setMessage(null)}>
                <ArrowLeft className="h-5 w-5" />
              </IconButton>
              <Button size="sm" onClick={() => reply(message, false)}><CornerUpLeft className="h-4 w-4" /> Reply</Button>
              <Button size="sm" onClick={() => reply(message, true)} className="hidden sm:inline-flex"><ReplyAll className="h-4 w-4" /> Reply all</Button>
              <Button size="sm" onClick={() => forward(message)}><CornerUpRight className="h-4 w-4" /> Forward</Button>
              <span className="flex-1" />
              <IconButton label="Mark as unread" onClick={() => { act("unread", [message.uid]); setMessage(null); }}><Mail className="h-4 w-4" /></IconButton>
              {role !== "archive" && <IconButton label="Archive" onClick={() => act("archive", [message.uid])}><Archive className="h-4 w-4" /></IconButton>}
              {role === "junk" ? (
                <IconButton label="Not spam" onClick={() => act("notspam", [message.uid])}><Inbox className="h-4 w-4" /></IconButton>
              ) : (
                <IconButton label="Report spam" onClick={() => act("spam", [message.uid])}><OctagonAlert className="h-4 w-4" /></IconButton>
              )}
              <IconButton label={role === "trash" ? "Delete forever" : "Delete"} onClick={() => act("delete", [message.uid])}><Trash2 className="h-4 w-4" /></IconButton>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
              <h1 className="text-lg font-semibold break-words">{message.subject || "(no subject)"}</h1>
              <div className="mt-3 flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent uppercase">
                  {(message.from[0] ? addrLabel(message.from[0]) : "?").charAt(0)}
                </span>
                <div className="min-w-0 flex-1 text-[13px]">
                  <p className="break-words">
                    <span className="font-semibold">{message.from[0]?.name || message.from[0]?.email || "Unknown sender"}</span>{" "}
                    {message.from[0]?.name && <span className="text-muted">&lt;{message.from[0].email}&gt;</span>}
                  </p>
                  <p className="break-words text-muted">
                    To: {message.to.map(addrLabel).join(", ") || "—"}
                    {message.cc.length > 0 && <> · Cc: {message.cc.map(addrLabel).join(", ")}</>}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted">{formatDate(message.date, true)}</span>
              </div>

              <div className="mt-5">
                <MessageBody html={message.html} text={message.text} />
              </div>

              {message.attachments.length > 0 && (
                <div className="mt-5 border-t border-border pt-4">
                  <p className="mb-2 text-[13px] font-medium">
                    {message.attachments.length} attachment{message.attachments.length > 1 ? "s" : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {message.attachments.map((a) => (
                      <a
                        key={a.index}
                        href={`/api/mail/attachment?${new URLSearchParams({ folder: message.folder, uid: String(message.uid), index: String(a.index) })}`}
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
                </div>
              )}
            </div>
          </>
        )}
      </section>

      {draft && (
        <Composer
          key={composerKey}
          initial={draft}
          maxAttachmentMb={me.max_attachment_mb}
          onClose={(changed) => {
            setDraft(null);
            if (changed) refresh();
          }}
        />
      )}
    </div>
  );
}

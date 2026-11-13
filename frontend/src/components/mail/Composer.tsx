"use client";

import { ChevronDown, ChevronUp, Paperclip, Send, Trash2, X } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatBytes } from "@/lib/api";
import { Button, IconButton, cx, toast, confirmDialog } from "../ui";
import MessageBody from "./MessageBody";
import type { Draft } from "./types";

const RichEditor = dynamic(() => import("../RichEditor"), { ssr: false });

type Props = {
  initial: Draft;
  maxAttachmentMb: number;
  onClose: (changed: boolean) => void;
};

export default function Composer({ initial, maxAttachmentMb, onClose }: Props) {
  const [to, setTo] = useState(initial.to);
  const [cc, setCc] = useState(initial.cc);
  const [bcc, setBcc] = useState(initial.bcc);
  const [showCc, setShowCc] = useState(Boolean(initial.cc || initial.bcc));
  const [subject, setSubject] = useState(initial.subject);
  const [files, setFiles] = useState<File[]>([]);
  const [keepQuote, setKeepQuote] = useState(Boolean(initial.quotedHtml));
  const [keepCarried, setKeepCarried] = useState(Boolean(initial.carryNames?.length));
  const [busy, setBusy] = useState<"" | "send" | "draft">("");
  const [dragging, setDragging] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const html = useRef(initial.html);
  const draftUid = useRef(initial.draftUid);
  const dirty = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const tooBig = totalSize > maxAttachmentMb * 1024 * 1024;

  const addFiles = useCallback((list: FileList | File[]) => {
    setFiles((cur) => [...cur, ...Array.from(list)]);
    dirty.current = true;
  }, []);

  function buildForm(): FormData {
    const form = new FormData();
    form.set("to", to);
    form.set("cc", cc);
    form.set("bcc", bcc);
    form.set("subject", subject);
    form.set("html", html.current + (keepQuote && initial.quotedHtml ? initial.quotedHtml : ""));
    if (initial.inReplyTo) form.set("in_reply_to", initial.inReplyTo);
    if (initial.references) form.set("references", initial.references);
    if (draftUid.current) form.set("draft_uid", String(draftUid.current));
    if (keepCarried && initial.carryFolder && initial.carryUid) {
      form.set("forward_folder", initial.carryFolder);
      form.set("forward_uid", String(initial.carryUid));
    }
    files.forEach((f) => form.append("files", f, f.name));
    return form;
  }

  async function send() {
    if (!to.trim() && !cc.trim() && !bcc.trim()) {
      toast.error("Add at least one recipient");
      return;
    }
    if (!subject.trim() && !(await confirmDialog({ title: "Send this message without a subject?" }))) return;
    setBusy("send");
    try {
      const form = buildForm();
      if (initial.replyFolder && initial.replyUid) {
        form.set("reply_folder", initial.replyFolder);
        form.set("reply_uid", String(initial.replyUid));
      }
      await api("/mail/send", { form });
      toast.ok("Message sent");
      onClose(true);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy("");
    }
  }

  async function saveDraft() {
    setBusy("draft");
    try {
      await api<{ uid: number | null }>("/mail/draft", { form: buildForm() });
      dirty.current = false;
      toast.ok("Draft saved");
      onClose(true);
    } catch (err) {
      toast.error((err as Error).message);
      setBusy("");
    }
  }

  async function discard() {
    if (dirty.current && !(await confirmDialog({ title: "Discard this message?", danger: true }))) return;
    if (draftUid.current) {
      try {
        const folders = await api<{ folders: { name: string; role: string }[] }>("/mail/folders");
        const drafts = folders.folders.find((f) => f.role === "drafts")?.name || "Drafts";
        await api("/mail/action", { json: { folder: drafts, uids: [draftUid.current], action: "delete" } });
      } catch {
        /* the draft may already be gone */
      }
    }
    onClose(Boolean(draftUid.current));
  }

  function close() {
    if (dirty.current) {
      saveDraft();
    } else {
      onClose(false);
    }
  }

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);

  const field = "w-full bg-transparent py-2 text-sm placeholder:text-muted/70 focus:outline-none";
  const markDirty = () => {
    dirty.current = true;
  };

  return (
    <div
      className={cx(
        "fixed z-40 flex flex-col border border-border bg-surface shadow-2xl",
        minimized
          ? "right-4 bottom-0 w-72 rounded-t-xl"
          : "inset-0 sm:inset-auto sm:right-4 sm:bottom-0 sm:h-[min(680px,calc(100dvh-2rem))] sm:w-[min(720px,calc(100vw-2rem))] sm:rounded-t-xl",
      )}
      role="dialog"
      aria-label="New message"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      <div className="flex items-center justify-between rounded-t-xl bg-raised px-4 py-2">
        <button className="min-w-0 flex-1 truncate text-left text-sm font-semibold" onClick={() => setMinimized((m) => !m)}>
          {subject || "New message"}
        </button>
        <div className="flex">
          <IconButton label={minimized ? "Expand" : "Minimize"} onClick={() => setMinimized((m) => !m)} className="hidden sm:inline-flex">
            {minimized ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </IconButton>
          <IconButton label="Save and close" onClick={close}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      </div>

      <div className={cx("min-h-0 flex-1 flex-col", minimized ? "hidden" : "flex")}>
        <div className="divide-y divide-border border-b border-border px-4">
          <div className="flex items-center gap-2">
            <span className="w-8 shrink-0 text-xs text-muted">To</span>
            <input
              className={field}
              value={to}
              autoFocus={!initial.to}
              onChange={(e) => {
                setTo(e.target.value);
                markDirty();
              }}
              placeholder="Recipients, separated by commas"
              aria-label="To"
            />
            {!showCc && (
              <button className="shrink-0 text-xs text-muted hover:text-text" onClick={() => setShowCc(true)}>
                Cc / Bcc
              </button>
            )}
          </div>
          {showCc && (
            <>
              <div className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-xs text-muted">Cc</span>
                <input className={field} value={cc} onChange={(e) => { setCc(e.target.value); markDirty(); }} aria-label="Cc" />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-8 shrink-0 text-xs text-muted">Bcc</span>
                <input className={field} value={bcc} onChange={(e) => { setBcc(e.target.value); markDirty(); }} aria-label="Bcc" />
              </div>
            </>
          )}
          <input
            className={cx(field, "font-medium")}
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              markDirty();
            }}
            placeholder="Subject"
            aria-label="Subject"
          />
        </div>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
          <RichEditor
            initialHtml={initial.html}
            autoFocus={Boolean(initial.to)}
            minHeight={160}
            onChange={(value) => {
              html.current = value;
              markDirty();
            }}
          />
          {keepQuote && initial.quotedHtml && (
            <div className="mx-4 mb-3 rounded-lg border border-border">
              <div className="flex items-center justify-between border-b border-border px-3 py-1 text-xs text-muted">
                <span>Original message is included below your text</span>
                <button className="hover:text-text" onClick={() => { setKeepQuote(false); markDirty(); }}>
                  Remove
                </button>
              </div>
              <div className="max-h-44 overflow-auto p-2">
                <MessageBody html={initial.quotedHtml} text="" />
              </div>
            </div>
          )}
          {dragging && (
            <div className="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/80 text-sm font-medium text-accent">
              Drop files to attach
            </div>
          )}
        </div>

        {(files.length > 0 || (keepCarried && initial.carryNames?.length)) && (
          <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto border-t border-border px-4 py-2">
            {keepCarried &&
              initial.carryNames?.map((name, i) => (
                <span key={`c${i}`} className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-xs">
                  <Paperclip className="h-3 w-3 shrink-0" />
                  <span className="truncate">{name}</span>
                </span>
              ))}
            {keepCarried && Boolean(initial.carryNames?.length) && (
              <button className="rounded-md px-2 py-1 text-xs text-muted hover:bg-hover" onClick={() => { setKeepCarried(false); markDirty(); }}>
                Remove original attachments
              </button>
            )}
            {files.map((f, i) => (
              <span key={i} className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-raised px-2 py-1 text-xs">
                <Paperclip className="h-3 w-3 shrink-0" />
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 text-muted">{formatBytes(f.size)}</span>
                <button aria-label={`Remove ${f.name}`} className="shrink-0 text-muted hover:text-danger" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        {tooBig && <p className="px-4 pb-1 text-xs text-danger">Attachments exceed the {maxAttachmentMb} MB limit.</p>}

        <div className="flex items-center gap-2 border-t border-border px-4 py-2.5">
          <Button variant="primary" onClick={send} loading={busy === "send"} disabled={busy !== "" || tooBig}>
            {busy !== "send" && <Send className="h-4 w-4" />} Send
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Button onClick={() => fileInput.current?.click()}>
            <Paperclip className="h-4 w-4" /> Attach
          </Button>
          <Button variant="ghost" onClick={() => saveDraft()} loading={busy === "draft"} disabled={busy !== "" || tooBig}>
            Save draft
          </Button>
          <span className="flex-1" />
          <IconButton label="Discard" onClick={discard}>
            <Trash2 className="h-4 w-4" />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

"use client";

import { Check, Copy, Download, FileArchive, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api, formatBytes } from "@/lib/api";
import { Badge, Button, Checkbox, CopyText, Modal, Notice, Table, cx, toast } from "@/components/ui";

type ImportedAccount = {
  email: string;
  domain: string;
  password: string;
  password_mode?: "cpanel" | "random" | "unchanged";
  created: boolean;
  messages_imported: number;
  messages_skipped: number;
  folders: Record<string, number>;
};

type ImportResult = {
  domains_created: string[];
  mailboxes_total: number;
  messages_imported: number;
  messages_skipped: number;
  accounts: ImportedAccount[];
};

export function ImportBackupModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported?: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [useCpanelPasswords, setUseCpanelPasswords] = useState(true);
  const [resetExisting, setResetExisting] = useState(true);
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  async function runImport(fileToUpload: File) {
    setSelectedFile(fileToUpload);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", fileToUpload);
      form.append("use_cpanel_passwords", useCpanelPasswords ? "true" : "false");
      form.append("reset_existing_passwords", resetExisting ? "true" : "false");
      const res = await api<ImportResult>("/admin/mailboxes/import-backup", {
        method: "POST",
        form,
      });
      setResult(res);
      toast.ok(`Imported ${res.mailboxes_total} mailbox${res.mailboxes_total === 1 ? "" : "es"} (${res.messages_imported} messages)`);
      onImported?.();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function downloadCsv() {
    if (!result) return;
    const rows = [
      ["email", "password", "domain", "status", "messages_imported", "inbox_messages", "sent_messages"],
      ...result.accounts.map((a) => [
        a.email,
        a.password,
        a.domain,
        a.created ? "created" : "updated",
        String(a.messages_imported),
        String(a.folders?.INBOX ?? 0),
        String(a.folders?.Sent ?? 0),
      ]),
    ];
    const csvContent = rows
      .map((r) => r.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `mailsomadhan-imported-accounts-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  const hasRandomPasswords = result?.accounts.some((a) => a.password_mode === "random") ?? false;

  async function copyAllPasswords() {
    if (!result) return;
    const text = result.accounts.map((a) => `${a.email}\t${a.password}`).join("\n");
    await navigator.clipboard.writeText(text);
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1800);
    toast.ok("Copied all accounts");
  }

  return (
    <Modal
      title={result ? "Backup imported" : "Import email backup"}
      description={
        result
          ? "All mailboxes and their Sent & Received messages have been imported into MailSomadhan."
          : "One-click import of a cPanel backup archive (.tar.gz, .tgz, or .zip). Creates domains, mailboxes with their original cPanel passwords (or random passwords), and imports all Sent & Received messages."
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      wide={Boolean(result)}
    >
      {!result ? (
        <div className="space-y-4">
          <input
            ref={fileRef}
            type="file"
            accept=".tar.gz,.tgz,.tar,.zip,application/gzip,application/x-gzip,application/x-tar,application/zip"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) runImport(f);
            }}
          />

          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (busy) return;
              const f = e.dataTransfer.files?.[0];
              if (f) runImport(f);
            }}
            onClick={() => !busy && fileRef.current?.click()}
            className={cx(
              "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
              dragOver ? "border-accent bg-accent-soft/40" : "border-border bg-raised hover:border-accent/60 hover:bg-hover",
              busy && "pointer-events-none opacity-70",
            )}
          >
            <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-surface text-accent shadow-card">
              <FileArchive className="h-6 w-6" />
            </span>
            <p className="text-sm font-semibold">
              {busy && selectedFile
                ? `Importing ${selectedFile.name} (${formatBytes(selectedFile.size)})…`
                : "Click to select backup archive or drag & drop here"}
            </p>
            <p className="mt-1 max-w-md text-xs text-muted">
              Supports <code className="rounded bg-sunken px-1 py-0.5 font-mono">cpanel-backup-*.tar.gz</code> generated by{" "}
              <code className="rounded bg-sunken px-1 py-0.5 font-mono">cpanel-migrate.sh</code> or any cPanel{" "}
              <code className="rounded bg-sunken px-1 py-0.5 font-mono">mail/</code> archive. Selecting a file imports it immediately.
            </p>
            <div className="mt-4">
              <Button variant="primary" loading={busy} onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}>
                <Upload className="h-4 w-4" /> {busy ? "Importing mailboxes & messages…" : "Select backup & Import now"}
              </Button>
            </div>
          </div>

          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={useCpanelPasswords}
              onChange={setUseCpanelPasswords}
              label="Keep same passwords from cPanel"
            />
            <span>
              Keep original cPanel passwords (recommended)
              <span className="block text-[13px] text-muted">
                Uses the encrypted password hash from cPanel so users can sign in with their exact same email and password. Uncheck to generate new random passwords instead.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={resetExisting}
              onChange={setResetExisting}
              label="Update password for already-existing mailboxes too"
            />
            <span>
              Apply password to mailboxes that already exist on this server
              <span className="block text-[13px] text-muted">
                When checked, mailboxes that already existed in MailSomadhan will also have their password updated from the backup.
              </span>
            </span>
          </label>

          <div className="flex justify-end gap-2">
            <Button onClick={onClose} disabled={busy}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <Notice tone="ok" title={`Imported ${result.mailboxes_total} mailbox${result.mailboxes_total === 1 ? "" : "es"} and ${result.messages_imported.toLocaleString()} messages`}>
            {result.domains_created.length > 0 && (
              <span>Created domain{result.domains_created.length > 1 ? "s" : ""}: <b>{result.domains_created.join(", ")}</b>. </span>
            )}
            {result.messages_skipped > 0 && (
              <span>Skipped {result.messages_skipped.toLocaleString()} duplicate messages already in the mailbox. </span>
            )}
            {!hasRandomPasswords
              ? "Original cPanel passwords were preserved — users can sign in with their existing email and password."
              : "Download or copy the generated random passwords below before closing."}
          </Notice>

          <div className="rounded-xl border border-border">
            <Table head={["Mailbox", "Password", "Messages", "Status"]} minWidth={560}>
              {result.accounts.map((acc) => {
                const folderSummary = Object.entries(acc.folders || {})
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(", ");
                return (
                  <tr key={acc.email}>
                    <td className="font-medium">{acc.email}</td>
                    <td>
                      {acc.password_mode === "cpanel" ? (
                        <Badge tone="ok" dot>Same as cPanel</Badge>
                      ) : acc.password_mode === "unchanged" ? (
                        <Badge tone="muted">Unchanged</Badge>
                      ) : (
                        <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-sunken py-0.5 pr-1 pl-2.5">
                          <code className="font-mono text-xs select-all">{acc.password}</code>
                          <CopyText value={acc.password} label={`Copy password for ${acc.email}`} />
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="font-medium tabular">{acc.messages_imported.toLocaleString()}</span>
                      {folderSummary && <span className="block text-xs text-muted">{folderSummary}</span>}
                    </td>
                    <td>
                      <Badge tone={acc.created ? "ok" : "accent"} dot>
                        {acc.created ? "Created" : "Updated"}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </Table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={downloadCsv}>
                <Download className="h-4 w-4" /> Download Summary CSV
              </Button>
              {hasRandomPasswords && (
                <Button onClick={copyAllPasswords}>
                  {copiedAll ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />}
                  {copiedAll ? "Copied!" : "Copy all passwords"}
                </Button>
              )}
            </div>
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

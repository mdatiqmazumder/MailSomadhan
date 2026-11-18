"use client";

import { ArrowLeft, Check, Copy, Download, FileArchive, Globe, Loader2, Server, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, formatBytes } from "@/lib/api";
import { Badge, Button, Checkbox, CopyText, Field, Input, Modal, Notice, Select, Table, Tabs, cx, toast } from "@/components/ui";

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

type CPanelAccount = {
  email: string;
  local_part: string;
  domain: string;
  quota_mb: number;
  used_human: string;
  used_bytes: number;
};

type CPanelInspectResult = {
  cpanel_host: string;
  domains: string[];
  accounts: CPanelAccount[];
};

type CPanelJobStatus = {
  job_id: string;
  status: "running" | "done" | "failed";
  message: string;
  current: number;
  total: number;
  result: ImportResult | null;
  error: string;
};

export function ImportBackupModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported?: () => void;
}) {
  const [tab, setTab] = useState<"cpanel" | "file">("cpanel");

  // Shared options & result
  const [useCpanelPasswords, setUseCpanelPasswords] = useState(true);
  const [resetExisting, setResetExisting] = useState(true);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  // cPanel live import state
  const [cpHost, setCpHost] = useState("");
  const [cpUser, setCpUser] = useState("");
  const [cpPass, setCpPass] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [inspectData, setInspectData] = useState<CPanelInspectResult | null>(null);
  const [domainFilter, setDomainFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<CPanelJobStatus | null>(null);

  // Archive file upload state
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const busy = connecting || uploading || Boolean(jobId);

  // Poll cPanel background import job
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const st = await api<CPanelJobStatus>(`/admin/mailboxes/cpanel/import/${jobId}`);
        if (cancelled) return;
        setJobStatus(st);
        if (st.status === "done" && st.result) {
          setJobId(null);
          setResult(st.result);
          toast.ok(
            `Imported ${st.result.mailboxes_total} mailbox${st.result.mailboxes_total === 1 ? "" : "es"} (${st.result.messages_imported} messages)`,
          );
          onImported?.();
          return;
        }
        if (st.status === "failed") {
          setJobId(null);
          toast.error(st.error || st.message || "cPanel import failed");
          return;
        }
      } catch (err) {
        if (!cancelled) {
          setJobId(null);
          toast.error((err as Error).message);
          return;
        }
      }
      if (!cancelled) setTimeout(poll, 1200);
    };
    poll();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const domainsWithCounts = useMemo(() => {
    if (!inspectData) return [];
    const counts = new Map<string, number>();
    for (const acc of inspectData.accounts) {
      counts.set(acc.domain, (counts.get(acc.domain) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [inspectData]);

  const visibleAccounts = useMemo(() => {
    if (!inspectData) return [];
    const q = searchQuery.trim().toLowerCase();
    return inspectData.accounts.filter(
      (a) => (!domainFilter || a.domain === domainFilter) && (!q || a.email.includes(q)),
    );
  }, [inspectData, domainFilter, searchQuery]);

  const allVisibleSelected =
    visibleAccounts.length > 0 && visibleAccounts.every((a) => selectedEmails.has(a.email));

  function toggleSelectAllVisible(checked: boolean) {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      for (const a of visibleAccounts) {
        if (checked) next.add(a.email);
        else next.delete(a.email);
      }
      return next;
    });
  }

  function toggleEmail(email: string, checked: boolean) {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (checked) next.add(email);
      else next.delete(email);
      return next;
    });
  }

  function selectOnlyDomain(dom: string) {
    setDomainFilter(dom);
    if (!inspectData) return;
    if (!dom) {
      setSelectedEmails(new Set(inspectData.accounts.map((a) => a.email)));
    } else {
      setSelectedEmails(new Set(inspectData.accounts.filter((a) => a.domain === dom).map((a) => a.email)));
    }
  }

  async function connectCPanel(e: React.FormEvent) {
    e.preventDefault();
    setConnecting(true);
    try {
      const res = await api<CPanelInspectResult>("/admin/mailboxes/cpanel/inspect", {
        json: { host: cpHost.trim(), username: cpUser.trim(), password: cpPass },
      });
      setInspectData(res);
      setDomainFilter("");
      setSearchQuery("");
      setSelectedEmails(new Set(res.accounts.map((a) => a.email)));
      if (!res.accounts.length) {
        toast.error("Connected to cPanel, but no email accounts were found.");
      } else {
        toast.ok(`Connected! Found ${res.accounts.length} email account${res.accounts.length === 1 ? "" : "s"}.`);
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setConnecting(false);
    }
  }

  async function startCPanelImport() {
    if (!selectedEmails.size) {
      toast.error("Select at least one email account to import");
      return;
    }
    try {
      const res = await api<{ job_id: string }>("/admin/mailboxes/cpanel/import", {
        json: {
          host: cpHost.trim(),
          username: cpUser.trim(),
          password: cpPass,
          emails: Array.from(selectedEmails),
          use_cpanel_passwords: useCpanelPasswords,
          reset_existing_passwords: resetExisting,
        },
      });
      setJobStatus({
        job_id: res.job_id,
        status: "running",
        message: "Connecting to cPanel…",
        current: 0,
        total: selectedEmails.size,
        result: null,
        error: "",
      });
      setJobId(res.job_id);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function runFileImport(fileToUpload: File) {
    setSelectedFile(fileToUpload);
    setUploading(true);
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
      setUploading(false);
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
      title={result ? "Import completed" : "Import from cPanel"}
      description={
        result
          ? "All selected mailboxes and their Sent & Received messages have been imported into MailSomadhan."
          : "Connect directly to your cPanel server to select domains and mailboxes, or upload a backup archive."
      }
      onClose={() => {
        if (!busy) onClose();
      }}
      wide={Boolean(result || inspectData)}
    >
      {result ? (
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

          <div className="max-h-80 overflow-y-auto rounded-xl border border-border">
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
      ) : (
        <div className="space-y-4">
          {!jobId && (
            <Tabs
              value={tab}
              onChange={(v) => {
                if (!busy) setTab(v);
              }}
              tabs={[
                { value: "cpanel", label: "Connect cPanel" },
                { value: "file", label: "Upload Backup File" },
              ]}
            />
          )}

          {tab === "cpanel" ? (
            jobId && jobStatus ? (
              <div className="space-y-4 py-6 text-center">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-raised text-accent">
                  <Loader2 className="h-6 w-6 animate-spin" />
                </div>
                <div>
                  <p className="font-semibold">{jobStatus.message || "Importing from cPanel…"}</p>
                  <p className="mt-1 text-xs text-muted">
                    {jobStatus.current} of {jobStatus.total} account{jobStatus.total === 1 ? "" : "s"} processed
                  </p>
                </div>
                <div className="mx-auto h-2 w-full max-w-md overflow-hidden rounded-full bg-sunken">
                  <div
                    className="h-full rounded-full bg-accent transition-all duration-300"
                    style={{
                      width: `${Math.max(8, Math.round((jobStatus.current / Math.max(1, jobStatus.total)) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            ) : !inspectData ? (
              <form onSubmit={connectCPanel} className="space-y-4">
                <Field
                  label="cPanel Host / URL"
                  hint="Enter your domain, server IP, or full cPanel URL (e.g. example.com or https://server.example.com:2083)."
                >
                  <Input
                    autoFocus
                    value={cpHost}
                    onChange={(e) => setCpHost(e.target.value)}
                    placeholder="https://example.com:2083"
                    required
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="cPanel Username">
                    <Input
                      value={cpUser}
                      onChange={(e) => setCpUser(e.target.value)}
                      placeholder="cpaneluser"
                      autoComplete="off"
                      required
                    />
                  </Field>
                  <Field label="cPanel Password">
                    <Input
                      type="password"
                      value={cpPass}
                      onChange={(e) => setCpPass(e.target.value)}
                      placeholder="••••••••"
                      autoComplete="current-password"
                      required
                    />
                  </Field>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <Button onClick={onClose} disabled={connecting}>Cancel</Button>
                  <Button type="submit" variant="primary" loading={connecting}>
                    <Server className="h-4 w-4" /> Connect & Fetch Accounts
                  </Button>
                </div>
              </form>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-raised px-3.5 py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4 text-accent" />
                    <span>
                      Connected to <b>{inspectData.cpanel_host}</b> ({inspectData.accounts.length} accounts across {domainsWithCounts.length} domain{domainsWithCounts.length === 1 ? "" : "s"})
                    </span>
                  </div>
                  <Button size="xs" onClick={() => setInspectData(null)}>
                    <ArrowLeft className="h-3.5 w-3.5" /> Change server
                  </Button>
                </div>

                {/* Domain selector pills & search */}
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    className="max-w-60"
                    value={domainFilter}
                    onChange={(e) => selectOnlyDomain(e.target.value)}
                    aria-label="Select domain"
                  >
                    <option value="">All domains ({inspectData.accounts.length})</option>
                    {domainsWithCounts.map((d) => (
                      <option key={d.name} value={d.name}>
                        {d.name} ({d.count})
                      </option>
                    ))}
                  </Select>
                  <Input
                    className="max-w-xs"
                    placeholder="Filter email addresses…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    aria-label="Filter email addresses"
                  />
                  <span className="ml-auto text-xs font-medium text-muted tabular">
                    {selectedEmails.size} of {inspectData.accounts.length} selected
                  </span>
                </div>

                {/* Accounts checklist table */}
                <div className="max-h-64 overflow-y-auto rounded-xl border border-border">
                  <Table
                    head={[
                      <span key="sel" className="inline-flex items-center gap-2">
                        <Checkbox
                          checked={allVisibleSelected}
                          onChange={toggleSelectAllVisible}
                          label="Select all visible mailboxes"
                        />
                        <span>Email address</span>
                      </span>,
                      "Domain",
                      "Used / Quota",
                    ]}
                    minWidth={480}
                  >
                    {visibleAccounts.map((acc) => {
                      const checked = selectedEmails.has(acc.email);
                      return (
                        <tr
                          key={acc.email}
                          className="cursor-pointer"
                          onClick={() => toggleEmail(acc.email, !checked)}
                        >
                          <td>
                            <div className="flex items-center gap-2.5" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={checked}
                                onChange={(v) => toggleEmail(acc.email, v)}
                                label={`Select ${acc.email}`}
                              />
                              <span
                                className="font-medium"
                                onClick={() => toggleEmail(acc.email, !checked)}
                              >
                                {acc.email}
                              </span>
                            </div>
                          </td>
                          <td className="text-muted">{acc.domain}</td>
                          <td className="whitespace-nowrap text-muted tabular">
                            {acc.used_human || formatBytes(acc.used_bytes)} / {(acc.quota_mb / 1024).toFixed(1)} GB
                          </td>
                        </tr>
                      );
                    })}
                  </Table>
                </div>

                <div className="space-y-2.5 border-t border-border pt-3">
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <Checkbox
                      className="mt-0.5"
                      checked={useCpanelPasswords}
                      onChange={setUseCpanelPasswords}
                      label="Keep original cPanel passwords"
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
                    </span>
                  </label>
                </div>

                <div className="flex justify-end gap-2">
                  <Button onClick={onClose}>Cancel</Button>
                  <Button
                    variant="primary"
                    disabled={selectedEmails.size === 0}
                    onClick={startCPanelImport}
                  >
                    <Upload className="h-4 w-4" /> Import Selected ({selectedEmails.size})
                  </Button>
                </div>
              </div>
            )
          ) : (
            <div className="space-y-4">
              <input
                ref={fileRef}
                type="file"
                accept=".tar.gz,.tgz,.tar,.zip,application/gzip,application/x-gzip,application/x-tar,application/zip"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) runFileImport(f);
                }}
              />

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!uploading) setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (uploading) return;
                  const f = e.dataTransfer.files?.[0];
                  if (f) runFileImport(f);
                }}
                onClick={() => !uploading && fileRef.current?.click()}
                className={cx(
                  "flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
                  dragOver ? "border-accent bg-accent-soft/40" : "border-border bg-raised hover:border-accent/60 hover:bg-hover",
                  uploading && "pointer-events-none opacity-70",
                )}
              >
                <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-surface text-accent shadow-card">
                  <FileArchive className="h-6 w-6" />
                </span>
                <p className="text-sm font-semibold">
                  {uploading && selectedFile
                    ? `Importing ${selectedFile.name} (${formatBytes(selectedFile.size)})…`
                    : "Click to select backup archive or drag & drop here"}
                </p>
                <p className="mt-1 max-w-md text-xs text-muted">
                  Supports <code className="rounded bg-sunken px-1 py-0.5 font-mono">cpanel-backup-*.tar.gz</code> or any cPanel{" "}
                  <code className="rounded bg-sunken px-1 py-0.5 font-mono">mail/</code> archive (.tar.gz, .tgz, .zip).
                </p>
                <div className="mt-4">
                  <Button variant="primary" loading={uploading} onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}>
                    <Upload className="h-4 w-4" /> {uploading ? "Importing mailboxes & messages…" : "Select backup & Import now"}
                  </Button>
                </div>
              </div>

              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={useCpanelPasswords}
                  onChange={setUseCpanelPasswords}
                  label="Keep original cPanel passwords"
                />
                <span>
                  Keep original cPanel passwords (recommended)
                  <span className="block text-[13px] text-muted">
                    Uses the encrypted password hash from cPanel when available. Uncheck to generate new random passwords instead.
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={resetExisting}
                  onChange={setResetExisting}
                  label="Apply password to already-existing mailboxes too"
                />
                <span>
                  Apply password to mailboxes that already exist on this server
                </span>
              </label>

              <div className="flex justify-end gap-2">
                <Button onClick={onClose} disabled={uploading}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

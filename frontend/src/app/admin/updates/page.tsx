"use client";

import { CheckCircle2, CircleAlert, Download, GitCommitHorizontal, Loader2, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, formatDate, useLoad } from "@/lib/api";
import { Badge, Button, Card, PageHeader, Spinner, toast, confirmDialog } from "@/components/ui";

type Result = { status: "running" | "success" | "failed" | "rolled_back"; message: string; time: string } | null;
type SystemInfo = { version: string; commit: string; installed_at: string | null; update_running: boolean; last_result: Result };
type Check = {
  latest_version: string;
  latest_commit: string;
  latest_date: string;
  update_available: boolean;
  changes: { commit: string; date: string; subject: string }[];
  changes_complete: boolean;
};
type Status = { running: boolean; result: Result; log: string };

const short = (sha: string) => (sha && sha !== "local" ? sha.slice(0, 7) : sha || "—");

export default function UpdatesPage() {
  const info = useLoad<SystemInfo>("/admin/system");
  const [check, setCheck] = useState<Check | null>(null);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [watching, setWatching] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      setCheck(await api<Check>("/admin/system/check", { method: "POST" }));
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setChecking(false);
    }
  }, []);

  // Resume watching if an update is already running (e.g. after a page reload).
  useEffect(() => {
    if (info.data?.update_running) setWatching(true);
  }, [info.data]);

  // Poll while an update runs. The panel itself restarts mid-way, so failed requests are expected.
  useEffect(() => {
    if (!watching) return;
    let stopped = false;
    let sawRunning = false;
    const tick = async () => {
      try {
        const res = await fetch("/api/admin/system/update-status", { cache: "no-store", credentials: "same-origin" });
        if (!res.ok) throw new Error(String(res.status));
        const s = (await res.json()) as Status;
        if (stopped) return;
        setUnreachable(false);
        setStatus(s);
        if (s.running) sawRunning = true;
        if (!s.running && (sawRunning || s.result?.status !== "running") && s.result?.status !== "running") {
          setWatching(false);
          info.reload();
          setCheck(null);
          if (s.result?.status === "success") toast.ok(s.result.message);
          else if (s.result) toast.error(s.result.message);
          return;
        }
      } catch {
        if (!stopped) setUnreachable(true);
      }
      if (!stopped) setTimeout(tick, 2500);
    };
    tick();
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [status?.log]);

  async function startUpdate() {
    if (!(await confirmDialog({ title: "Install the latest version now? Mail and the panel restart during the update (usually 2–5 minutes). Mail in transit is queued, not lost.", danger: true }))) return;
    try {
      await api("/admin/system/update", { method: "POST" });
      setStatus(null);
      setWatching(true);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  if (info.loading) return <Spinner />;
  const sys = info.data;
  const last = status?.result ?? sys?.last_result ?? null;

  return (
    <>
      <PageHeader title="Updates" description="Install the newest MailSomadhan release from GitHub with one click. Your data and settings are kept." />

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-5">
          <p className="text-sm text-muted">Installed version</p>
          <p className="mt-1 text-2xl font-semibold">{sys?.version ?? "unknown"}</p>
          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
            <GitCommitHorizontal className="h-4 w-4" /> {short(sys?.commit ?? "")}
            {sys?.installed_at && <> · installed {formatDate(sys.installed_at, true)}</>}
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-sm text-muted">Latest version</p>
          {check ? (
            <>
              <p className="mt-1 flex flex-wrap items-center gap-2 text-2xl font-semibold">
                {check.latest_version || short(check.latest_commit)}
                {check.update_available ? <Badge tone="accent">Update available</Badge> : <Badge tone="ok">Up to date</Badge>}
              </p>
              <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                <GitCommitHorizontal className="h-4 w-4" /> {short(check.latest_commit)} · {formatDate(check.latest_date, true)}
              </p>
            </>
          ) : (
            <p className="mt-1 text-sm text-muted">Not checked yet.</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={runCheck} loading={checking} disabled={watching}>
              {!checking && <RefreshCw className="h-4 w-4" />} Check for updates
            </Button>
            <Button variant="primary" onClick={startUpdate} disabled={watching || checking}>
              <Download className="h-4 w-4" /> {check && !check.update_available ? "Reinstall latest" : "Update now"}
            </Button>
          </div>
        </Card>
      </div>

      {check && check.update_available && check.changes.length > 0 && (
        <Card className="mt-4 p-5">
          <h2 className="mb-3 font-semibold">What&apos;s new</h2>
          <ul className="space-y-2 text-sm">
            {check.changes.map((c) => (
              <li key={c.commit} className="flex gap-3">
                <code className="shrink-0 text-xs text-muted">{short(c.commit)}</code>
                <span className="min-w-0 flex-1 break-words">{c.subject}</span>
                <span className="shrink-0 text-xs text-muted">{formatDate(c.date)}</span>
              </li>
            ))}
          </ul>
          {!check.changes_complete && <p className="mt-2 text-xs text-muted">Showing the most recent changes only.</p>}
        </Card>
      )}

      {(watching || status?.log) && (
        <Card className="mt-4 p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {watching ? <Loader2 className="h-4 w-4 animate-spin text-accent" /> : last?.status === "success" ? <CheckCircle2 className="h-4 w-4 text-ok" /> : <CircleAlert className="h-4 w-4 text-danger" />}
            <h2 className="font-semibold">{watching ? "Updating…" : "Update log"}</h2>
            {watching && unreachable && <span className="text-sm text-muted">The panel is restarting; reconnecting…</span>}
          </div>
          <pre ref={logRef} className="max-h-96 overflow-auto rounded-lg bg-raised p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {status?.log || "Starting…"}
          </pre>
        </Card>
      )}

      {!watching && last && last.status !== "running" && (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted">
          Last update: {last.status === "success" ? <Badge tone="ok">succeeded</Badge> : last.status === "rolled_back" ? <Badge tone="warn">rolled back</Badge> : <Badge tone="danger">failed</Badge>}
          {last.message} · {formatDate(last.time, true)}
        </p>
      )}

      <p className="mt-6 text-sm text-muted">
        Updates always install the newest code from the project&apos;s GitHub repository. If an update fails, the previous version is restored automatically. You can also run <code>sudo mailsomadhan update</code> on the server.
      </p>
    </>
  );
}

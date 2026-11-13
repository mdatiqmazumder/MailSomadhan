"use client";

import { RefreshCw, RotateCw } from "lucide-react";
import { useState } from "react";
import { api, formatDate, useLoad } from "@/lib/api";
import { Badge, Button, Card, CopyText, Notice, PageHeader, PageSkeleton, Table, toast, confirmDialog } from "@/components/ui";

type Unit = {
  name: string; label: string; description: string; restartable?: boolean;
  state: string; sub: string; enabled: string; installed: boolean; since: string | null; next: string | null; last: string | null;
};

function when(value: string | null): string {
  return value ? formatDate(value) : "—";
}

function ServiceState({ u }: { u: Unit }) {
  if (u.state === "active") return <Badge tone="ok" dot>Running</Badge>;
  if (u.state === "activating" || u.state === "reloading") return <Badge tone="accent" dot>Starting</Badge>;
  if (u.name === "redis-server" && u.enabled === "disabled") return <Badge>Turned off</Badge>;
  return <Badge tone="danger" dot>Stopped</Badge>;
}

const COMMANDS: [string, string][] = [
  ["Status of all services", "sudo mailsomadhan status"],
  ["Restart everything", "sudo mailsomadhan restart"],
  ["Recent logs", "sudo mailsomadhan logs 200"],
  ["Follow the campaign sender", "sudo journalctl -u mailsomadhan-campaigns -f"],
  ["Show the mail queue", "sudo postqueue -p"],
  ["Retry all queued mail now", "sudo postqueue -f"],
];

export default function ServicesPage() {
  const { data, loading, reload } = useLoad<{ services: Unit[]; timers: Unit[] }>("/admin/system/services");
  const [busy, setBusy] = useState("");

  async function restart(u: Unit) {
    const self = u.name === "mailsomadhan-api" || u.name === "mailsomadhan-web";
    if (!(await confirmDialog({ title: `Restart ${u.label}?${self ? " The panel is unavailable for a few seconds." : ""}` }))) return;
    setBusy(u.name);
    try {
      await api(`/admin/system/services/${u.name}/restart`, { method: "POST" });
      toast.ok(`${u.label} restarted`);
      setTimeout(reload, self ? 6000 : 1500);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (loading || !data) return <PageSkeleton />;
  const down = data.services.filter((s) => s.state !== "active" && !(s.name === "redis-server" && s.enabled === "disabled"));
  return (
    <>
      <PageHeader
        title="Services & jobs"
        description="Everything MailSomadhan needs runs as a system service."
        action={<Button onClick={reload}><RefreshCw className="h-4 w-4" /> Refresh</Button>}
      />
      <div className="mb-5">
        {down.length ? (
          <Notice tone="danger" title={`${down.length} service${down.length === 1 ? " is" : "s are"} not running`}>
            {down.map((s) => s.label).join(", ")}. Try Restart below; if it stops again, the log shows why (commands at the bottom of this page).
          </Notice>
        ) : (
          <Notice tone="ok" title="Nothing to run by hand">
            There is no queue worker, cron job or scheduler to start yourself. Every service below starts when the server boots and restarts on its own if it stops. Campaign messages and the mail queue are processed automatically.
          </Notice>
        )}
      </div>

      <Card title="Services" description="Long-running programs. Workers and the mail log collector are included here." className="mb-5">
        <Table head={["Service", "Status", "Running since", ""]} minWidth={720}>
          {data.services.map((u) => (
            <tr key={u.name}>
              <td>
                <span className="block font-medium">{u.label}</span>
                <span className="block text-xs text-muted">{u.description}</span>
                <code className="mt-0.5 block text-[11px] text-faint">{u.name}</code>
              </td>
              <td className="whitespace-nowrap"><ServiceState u={u} /></td>
              <td className="whitespace-nowrap text-muted">{u.state === "active" ? when(u.since) : "—"}</td>
              <td>
                <div className="flex justify-end">
                  {u.restartable && (
                    <Button size="sm" onClick={() => restart(u)} loading={busy === u.name} disabled={!!busy}>
                      {busy !== u.name && <RotateCw className="h-3.5 w-3.5" />} Restart
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card title="Scheduled jobs" description="These run on their own at set times." className="mb-5">
        <Table head={["Job", "Status", "Next run", "Last run"]} minWidth={640}>
          {data.timers.map((u) => (
            <tr key={u.name}>
              <td>
                <span className="block font-medium">{u.label}</span>
                <span className="block text-xs text-muted">{u.description}</span>
              </td>
              <td className="whitespace-nowrap">
                {!u.installed ? <Badge>Not set up</Badge> : u.state === "active" ? <Badge tone="ok" dot>Scheduled</Badge> : <Badge>Off</Badge>}
              </td>
              <td className="whitespace-nowrap text-muted">{u.state === "active" ? when(u.next) : "—"}</td>
              <td className="whitespace-nowrap text-muted">{when(u.last)}</td>
            </tr>
          ))}
        </Table>
        <p className="border-t border-border px-5 py-3 text-xs text-muted">The backup job is set up when backups are turned on under Backups.</p>
      </Card>

      <Card title="From the server's command line" description="Only needed for troubleshooting. Connect with SSH and run:">
        <div className="divide-y divide-border">
          {COMMANDS.map(([label, cmd]) => (
            <div key={cmd} className="flex items-center gap-3 px-5 py-2">
              <span className="w-56 shrink-0 text-sm text-muted">{label}</span>
              <code className="min-w-0 flex-1 rounded bg-sunken px-2 py-1 font-mono text-xs break-all">{cmd}</code>
              <CopyText value={cmd} />
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

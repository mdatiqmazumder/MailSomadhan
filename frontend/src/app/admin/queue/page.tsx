"use client";

import { RefreshCw, Send, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, formatBytes, formatDate, useLoad } from "@/lib/api";
import { Button, Card, Empty, IconButton, PageHeader, Spinner, Table, toast, confirmDialog } from "@/components/ui";

type Item = {
  id: string;
  queue: string;
  arrival: number;
  size: number;
  sender: string;
  recipients: { address: string; reason: string }[];
};

export default function QueuePage() {
  const { data, loading, reload } = useLoad<Item[]>("/admin/queue");
  const [busy, setBusy] = useState(false);

  async function flush() {
    setBusy(true);
    try {
      await api("/admin/queue/flush", { method: "POST" });
      toast.ok("Retrying delivery of queued mail");
      setTimeout(reload, 2500);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: Item) {
    if (!(await confirmDialog({ title: `Delete queued message ${item.id}? It will not be delivered.`, danger: true }))) return;
    try {
      await api(`/admin/queue/${item.id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        title="Mail queue"
        description="Messages waiting for delivery. Temporary failures are retried automatically."
        action={
          <div className="flex gap-2">
            <Button onClick={reload}>
              <RefreshCw className="h-4 w-4" /> Refresh
            </Button>
            <Button variant="primary" onClick={flush} loading={busy} disabled={!data?.length}>
              {!busy && <Send className="h-4 w-4" />} Retry all now
            </Button>
          </div>
        }
      />
      <Card>
        {loading ? (
          <div className="p-6"><Spinner /></div>
        ) : !data?.length ? (
          <Empty title="The queue is empty">All mail has been delivered.</Empty>
        ) : (
          <Table head={["Queued", "From", "To / status", "Size", ""]}>
            {data.map((item) => (
              <tr key={item.id} className="align-top">
                <td className="whitespace-nowrap text-muted">{formatDate(new Date(item.arrival * 1000).toISOString())}</td>
                <td className="break-all">{item.sender || "(bounce)"}</td>
                <td>
                  {item.recipients.map((r) => (
                    <div key={r.address} className="mb-1">
                      <span className="break-all">{r.address}</span>
                      {r.reason && <p className="text-xs break-words text-warn">{r.reason}</p>}
                    </div>
                  ))}
                </td>
                <td className="whitespace-nowrap tabular-nums">{formatBytes(item.size)}</td>
                <td>
                  <div className="flex justify-end">
                    <IconButton label="Delete from queue" onClick={() => remove(item)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}

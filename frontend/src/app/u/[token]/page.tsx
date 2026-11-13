"use client";

import { CheckCircle2, MailX } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Spinner } from "@/components/ui";

type Info = { email: string; sender: string; unsubscribed: boolean };

/** Public page behind the unsubscribe link in campaign emails. */
export default function Unsubscribe() {
  const { token } = useParams<{ token: string }>();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Info>(`/public/unsubscribe/${token}`, { noRedirect: true }).then(setInfo).catch((e) => setError((e as Error).message));
  }, [token]);

  async function confirm() {
    setBusy(true);
    try {
      setInfo(await api<Info>(`/public/unsubscribe/${token}`, { method: "POST", noRedirect: true }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-8 text-center shadow-card">
        {error ? (
          <>
            <MailX className="mx-auto mb-3 h-10 w-10 text-muted" />
            <h1 className="text-lg font-semibold">Link not valid</h1>
            <p className="mt-1 text-sm text-muted">{error}</p>
          </>
        ) : !info ? (
          <Spinner className="mx-auto" />
        ) : info.unsubscribed ? (
          <>
            <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-ok" />
            <h1 className="text-lg font-semibold">You are unsubscribed</h1>
            <p className="mt-1 text-sm text-muted"><b className="text-text">{info.email}</b> will not receive these emails from {info.sender} again.</p>
          </>
        ) : (
          <>
            <MailX className="mx-auto mb-3 h-10 w-10 text-muted" />
            <h1 className="text-lg font-semibold">Unsubscribe?</h1>
            <p className="mt-1 text-sm text-muted">Stop emails like this from {info.sender} to <b className="text-text">{info.email}</b>.</p>
            <Button variant="primary" className="mt-6 w-full" loading={busy} onClick={confirm}>Unsubscribe</Button>
          </>
        )}
      </div>
    </main>
  );
}

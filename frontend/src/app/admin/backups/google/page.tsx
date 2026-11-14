"use client";

import { ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, Notice, toast } from "@/components/ui";

/** Google's consent screen sends the admin here with ?code=…&state=…; this finishes the Drive connection. */
export default function GoogleCallback() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // the code works once; React's dev double-run must not spend it twice
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    // Drop the code from the address bar and history straight away.
    window.history.replaceState(null, "", "/admin/backups/google");
    const denied = params.get("error");
    const code = params.get("code");
    const state = params.get("state");
    if (denied) {
      setError(denied === "access_denied" ? "Access was not allowed on Google's page, so Google Drive was not connected." : `Google returned an error: ${denied}`);
      return;
    }
    if (!code || !state) {
      setError("This page is opened by Google after you sign in. Start from Backups → Connect Google Drive.");
      return;
    }
    api("/admin/backup/google/finish", { json: { code, state } })
      .then(() => {
        setDone(true);
        toast.ok("Google Drive connected");
        setTimeout(() => router.replace("/admin/backups"), 1200);
      })
      .catch((e) => setError((e as Error).message));
  }, [router]);

  return (
    <div className="mx-auto max-w-lg pt-10">
      <Card padded>
        {error ? (
          <>
            <Notice tone="danger" title="Google Drive was not connected">{error}</Notice>
            <Link href="/admin/backups" className="mt-4 inline-block">
              <Button><ArrowLeft className="h-4 w-4" /> Back to Backups</Button>
            </Link>
          </>
        ) : done ? (
          <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="h-5 w-5 text-ok" /> Google Drive connected. Taking you back to Backups…</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted"><Loader2 className="h-5 w-5 animate-spin text-accent" /> Connecting Google Drive and testing access…</p>
        )}
      </Card>
    </div>
  );
}

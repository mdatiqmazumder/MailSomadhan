"use client";

import { Camera, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Avatar, Button, Card, Field, Input, Notice, Spinner, toast } from "@/components/ui";

/** Upload or remove a profile picture. `endpoint` is /account/avatar or an admin mailbox's avatar path. */
export function AvatarEditor({ name, url, endpoint, onChange }: {
  name: string; url: string | null; endpoint: string; onChange: (url: string | null) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    if (file.size > 5 * 1024 * 1024) {
      toast.error("The picture can be at most 5 MB");
      return;
    }
    const form = new FormData();
    form.append("file", file);
    setBusy(true);
    try {
      const res = await api<{ avatar_url: string | null }>(endpoint, { method: "PUT", form });
      onChange(res.avatar_url);
      toast.ok("Profile picture updated");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api(endpoint, { method: "DELETE" });
      onChange(null);
      toast.ok("Profile picture removed");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative">
        <Avatar name={name} src={url} size={72} />
        {busy && <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/40"><Spinner className="text-white" /></span>}
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => input.current?.click()} disabled={busy}>
            <Camera className="h-4 w-4" /> {url ? "Change picture" : "Upload picture"}
          </Button>
          {url && (
            <Button size="sm" variant="ghost" onClick={remove} disabled={busy}>
              <Trash2 className="h-4 w-4" /> Remove
            </Button>
          )}
        </div>
        <p className="text-xs text-muted">JPEG, PNG, WebP or GIF, up to 5 MB. It is cropped to a square.</p>
      </div>
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
      />
    </div>
  );
}

type Forwarding = { forward_to: string; forward_keep: boolean };

/** The mailbox user's own forwarding to other addresses. */
export function ForwardingCard({ email }: { email: string }) {
  const [data, setData] = useState<Forwarding | null>(null);
  const [to, setTo] = useState("");
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Forwarding>("/account/forwarding")
      .then((f) => {
        setData(f);
        setTo(f.forward_to.split(",").filter(Boolean).join(", "));
        setKeep(f.forward_keep);
      })
      .catch((err) => toast.error((err as Error).message));
  }, []);

  async function save(next: { forward_to: string; forward_keep: boolean }, message: string) {
    setBusy(true);
    try {
      const f = await api<Forwarding>("/account/forwarding", { method: "PUT", json: next });
      setData(f);
      setTo(f.forward_to.split(",").filter(Boolean).join(", "));
      setKeep(f.forward_keep);
      toast.ok(message);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const active = !!data?.forward_to;
  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="font-semibold">Forwarding</h2>
        {data && <span className={active ? "text-xs font-medium text-ok" : "text-xs text-muted"}>{active ? "On" : "Off"}</span>}
      </div>
      <p className="mb-4 text-sm text-muted">Send a copy of every message that arrives at {email} to another address, for example your personal email.</p>
      {!data ? (
        <Spinner />
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); save({ forward_to: to, forward_keep: keep }, to.trim() ? "Forwarding saved" : "Forwarding turned off"); }} className="space-y-4">
          <Field label="Forward to" hint="One address, or up to 5 separated by commas. Leave empty to turn forwarding off.">
            <Input type="text" inputMode="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@gmail.com" autoComplete="email" />
          </Field>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className="mt-0.5 h-4 w-4 cursor-pointer accent-[var(--accent)]" />
            <span>
              Keep a copy in this mailbox
              <span className="block text-[13px] text-muted">When off, forwarded messages are not stored here.</span>
            </span>
          </label>
          {!keep && to.trim() && <Notice tone="warn">Messages will only exist at the forwarding address. If that address rejects a message, it is lost.</Notice>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" loading={busy}>Save forwarding</Button>
            {active && <Button onClick={() => save({ forward_to: "", forward_keep: true }, "Forwarding turned off")} disabled={busy}>Turn off</Button>}
          </div>
        </form>
      )}
    </Card>
  );
}

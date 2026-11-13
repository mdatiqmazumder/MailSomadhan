"use client";

import { ArrowLeft } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, useLoad, useMe, type Me } from "@/lib/api";
import { ConnectionSettings, type Connection } from "@/components/ConnectionSettings";
import { PasswordCard } from "@/components/PasswordCard";
import { Button, Card, Field, Input, Spinner, toast } from "@/components/ui";

const RichEditor = dynamic(() => import("@/components/RichEditor"), { ssr: false });

export default function AccountPage() {
  const { me, setMe } = useMe("user");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const signature = useRef("");
  const loaded = useRef(false);
  const connection = useLoad<Connection>("/mail/connection");

  useEffect(() => {
    if (me && me.kind === "user" && !loaded.current) {
      loaded.current = true;
      setName(me.display_name);
      signature.current = me.signature_html;
    }
  }, [me]);

  if (!me || me.kind !== "user") {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const updated = await api<Me>("/account/profile", { method: "PUT", json: { display_name: name, signature_html: signature.current } });
      setMe(updated);
      toast.ok("Profile saved");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-6">
      <Link href="/mail" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-text">
        <ArrowLeft className="h-4 w-4" /> Back to mail
      </Link>
      <h1 className="text-xl font-semibold">Account settings</h1>
      <p className="mt-0.5 mb-5 text-sm text-muted">{me.email}</p>

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Card className="p-5">
          <h2 className="mb-4 font-semibold">Profile</h2>
          <form onSubmit={save} className="space-y-4">
            <Field label="Display name" hint="Recipients see this name next to your address.">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
            </Field>
            <div>
              <span className="mb-1 block text-[13px] font-medium">Signature</span>
              <div className="overflow-hidden rounded-lg border border-border">
                <RichEditor initialHtml={me.signature_html} minHeight={140} placeholder="Added to the end of new messages" onChange={(html) => (signature.current = html)} />
              </div>
            </div>
            <Button type="submit" variant="primary" loading={busy}>Save profile</Button>
          </form>
        </Card>
        <div className="space-y-5">
          <PasswordCard />
        </div>
      </div>

      <Card className="mt-5 p-5">
        <h2 className="font-semibold">Connection settings</h2>
        <p className="mt-0.5 mb-4 text-sm text-muted">Use these to add your mailbox to Outlook, Thunderbird, Apple Mail or the mail app on your phone.</p>
        {connection.data ? <ConnectionSettings info={connection.data} /> : connection.error ? <p className="text-sm text-danger">{connection.error}</p> : <Spinner />}
      </Card>
    </main>
  );
}

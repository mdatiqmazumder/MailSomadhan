"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Button, Card, Field, Input, toast } from "@/components/ui";

export function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) {
      toast.error("The new passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await api("/account/password", { json: { current_password: current, new_password: next } });
      toast.ok("Password changed");
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="h-fit p-5">
      <h2 className="mb-4 font-semibold">Change password</h2>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Current password">
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </Field>
        <Field label="New password" hint="At least 8 characters.">
          <Input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </Field>
        <Button type="submit" loading={busy}>Change password</Button>
      </form>
    </Card>
  );
}

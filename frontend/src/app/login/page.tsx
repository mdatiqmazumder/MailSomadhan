"use client";

import { BarChart3, Eye, EyeOff, Lock, Mail, ShieldCheck, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Field, Input } from "@/components/ui";

const POINTS = [
  { icon: ShieldCheck, title: "Secure by default", text: "TLS everywhere, DKIM, SPF and DMARC, spam and malware filtering." },
  { icon: BarChart3, title: "Full visibility", text: "Message tracking, per-user analytics and audit-ready reports." },
  { icon: Zap, title: "Always current", text: "One-click updates and encrypted backups to Google Drive." },
];

export default function LoginPage() {
  const [brand, setBrand] = useState("MailSomadhan");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ brand_name: string }>("/public/info", { noRedirect: true })
      .then((info) => {
        setBrand(info.brand_name);
        document.title = `Sign in · ${info.brand_name}`;
      })
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api<{ kind: string }>("/auth/login", { json: { identifier, password }, noRedirect: true });
      window.location.href = res.kind === "admin" ? "/admin" : "/mail";
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden overflow-hidden bg-[#0f1b33] px-14 py-12 text-white lg:flex lg:flex-col">
        <div aria-hidden className="pointer-events-none absolute -top-40 -right-32 h-[520px] w-[520px] rounded-full bg-[#2a62d6] opacity-30 blur-3xl" />
        <div aria-hidden className="pointer-events-none absolute -bottom-48 -left-24 h-[420px] w-[420px] rounded-full bg-[#1baf7a] opacity-15 blur-3xl" />
        <div className="relative flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15"><Mail className="h-5 w-5" /></span>
          <span className="text-lg font-semibold">{brand}</span>
        </div>
        <div className="relative my-auto max-w-md">
          <h1 className="text-[34px] leading-tight font-semibold tracking-tight">Business email you control, end to end.</h1>
          <p className="mt-3 text-[15px] text-white/70">Mail server, webmail and administration for your organisation, on your own infrastructure.</p>
          <ul className="mt-10 space-y-6">
            {POINTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/8 ring-1 ring-white/12"><Icon className="h-5 w-5 text-[#9ec5f4]" /></span>
                <div>
                  <p className="font-medium">{title}</p>
                  <p className="mt-0.5 text-sm text-white/60">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/40">© {new Date().getFullYear()} {brand}</p>
      </section>

      <section className="flex items-center justify-center px-5 py-12">
        <div className="w-full max-w-[380px]">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-accent-fg"><Mail className="h-5 w-5" /></span>
            <span className="text-lg font-semibold">{brand}</span>
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
          <p className="mt-1 text-sm text-muted">Use your email address, or the admin username for the console.</p>
          <form onSubmit={submit} className="mt-8 space-y-5">
            <Field label="Email or username">
              <Input autoFocus autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="you@company.com" required className="h-10" />
            </Field>
            <Field label="Password">
              <div className="relative">
                <Input type={show ? "text" : "password"} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required className="h-10 pr-10" />
                <button type="button" onClick={() => setShow((s) => !s)} aria-label={show ? "Hide password" : "Show password"} className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-muted hover:text-text">
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
            {error && (
              <p role="alert" className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
            )}
            <Button type="submit" variant="primary" loading={busy} className="h-10 w-full">Sign in</Button>
          </form>
          <p className="mt-8 flex items-center gap-1.5 text-xs text-muted">
            <Lock className="h-3.5 w-3.5" /> Encrypted connection. Repeated failed sign-ins are blocked automatically.
          </p>
        </div>
      </section>
    </main>
  );
}

"use client";

import { Eye, EyeOff, Lock, Mail, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Button, Field, Input } from "@/components/ui";

const REPO_NAME = "mdatiqmazumder/MailSomadhan";
const REPO_URL = `https://github.com/${REPO_NAME}`;

export default function LoginPage() {
  const [brand, setBrand] = useState("MailSomadhan");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [otp, setOtp] = useState("");
  const [needOtp, setNeedOtp] = useState(false);
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
      const res = await api<{ kind: string }>("/auth/login", { json: { identifier, password, otp }, noRedirect: true });
      window.location.href = res.kind === "admin" ? "/admin" : "/mail/dashboard";
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "otp_required") {
        setNeedOtp(true);
        setError("");
      } else {
        setError(msg);
      }
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">
      <div className="w-full max-w-[380px]">
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-7">
          <div className="mb-6 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent text-accent-fg">
              <Mail className="h-5 w-5" />
            </span>
            <span className="text-lg font-semibold tracking-tight">{brand}</span>
          </div>

          <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>

          <div className="mt-3 flex items-start gap-2.5 rounded-xl border border-ok/25 bg-ok-soft px-3.5 py-2.5 text-ok">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="text-xs leading-relaxed">
              <p className="font-semibold">End-to-end encrypted</p>
              <p className="opacity-85">All messages, credentials, and sessions are end-to-end encrypted.</p>
            </div>
          </div>

          <form onSubmit={submit} className="mt-5 space-y-4">
            <Field label="Email or username">
              <Input
                autoFocus
                autoComplete="username"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="you@company.com"
                required
                className="h-10"
              />
            </Field>
            <Field label="Password">
              <div className="relative">
                <Input
                  type={show ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="h-10 pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShow((s) => !s)}
                  aria-label={show ? "Hide password" : "Show password"}
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-md p-1 text-muted hover:text-text"
                >
                  {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </Field>
            {needOtp && (
              <Field label="Verification code" hint="The 6-digit code from your authenticator app.">
                <Input
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                  maxLength={6}
                  required
                  className="h-10 font-mono tracking-[0.3em]"
                  placeholder="123456"
                />
              </Field>
            )}
            {error && (
              <p role="alert" className="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary" loading={busy} className="h-10 w-full">
              <Lock className="h-4 w-4" /> Sign in
            </Button>
          </form>
        </div>

        <p className="mt-5 flex items-center justify-center gap-1.5 text-center text-xs text-muted">
          <span>Installed from</span>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-text hover:underline"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3.5 w-3.5 fill-current">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
            {REPO_NAME}
          </a>
        </p>
      </div>
    </main>
  );
}

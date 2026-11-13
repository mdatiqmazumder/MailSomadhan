"use client";

import { useCallback, useEffect, useState } from "react";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type Options = { method?: string; json?: unknown; form?: FormData; noRedirect?: boolean };

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { "X-Requested-With": "mailsomadhan" };
  let body: BodyInit | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    body = opts.form;
  }
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method || (body ? "POST" : "GET"),
      headers,
      body,
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "Cannot reach the server. Check your connection.");
  }
  if (res.status === 401 && !opts.noRedirect && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
    throw new ApiError(401, "Session expired");
  }
  if (res.status === 403 && !opts.noRedirect && !window.location.pathname.startsWith("/admin/account")) {
    const peek = await res.clone().json().catch(() => ({}));
    if (peek.detail === "two_factor_setup_required") {
      window.location.href = "/admin/account?setup2fa=1";
      throw new ApiError(403, "Two-factor sign-in must be set up first");
    }
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (typeof data.detail === "string") message = data.detail;
      else if (Array.isArray(data.detail) && data.detail[0]?.msg) {
        const first = data.detail[0];
        const field = Array.isArray(first.loc) ? first.loc[first.loc.length - 1] : "";
        message = field ? `${field}: ${first.msg}` : first.msg;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/** Load a GET endpoint and expose reload/loading/error state. */
export function useLoad<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

export type AdminMe = {
  kind: "admin";
  username: string;
  brand_name: string;
  role: "super_admin" | "admin";
  permissions: string[];
  domains: { id: number; name: string }[] | null;
  totp_enabled: boolean;
  require_2fa: boolean;
  max_mailbox_mb: number;
};

export type Me =
  | AdminMe
  | {
      kind: "user";
      email: string;
      display_name: string;
      signature_html: string;
      brand_name: string;
      max_attachment_mb: number;
    };

/** Current session; redirects to /login when signed out or when the role does not match. */
export function useMe(required?: "admin" | "user") {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api<Me>("/auth/me")
      .then((m) => {
        if (required && m.kind !== required) {
          window.location.href = m.kind === "admin" ? "/admin" : "/mail";
          return;
        }
        setMe(m);
      })
      .catch(() => {});
  }, [required]);
  return { me, setMe };
}

export async function logout() {
  try {
    await api("/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/login";
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function formatDate(iso: string | null, long = false): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (long) {
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  }
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

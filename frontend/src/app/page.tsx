"use client";

import { useEffect } from "react";
import { api, type Me } from "@/lib/api";
import { Spinner } from "@/components/ui";

export default function Home() {
  useEffect(() => {
    api<Me>("/auth/me", { noRedirect: true })
      .then((me) => window.location.replace(me.kind === "admin" ? "/admin" : "/mail"))
      .catch(() => window.location.replace("/login"));
  }, []);
  return (
    <div className="flex h-dvh items-center justify-center">
      <Spinner />
    </div>
  );
}

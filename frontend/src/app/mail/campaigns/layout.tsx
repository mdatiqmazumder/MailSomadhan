"use client";

import { ArrowLeft, Mail, Send } from "lucide-react";
import Link from "next/link";
import ThemeToggle from "@/components/ThemeToggle";
import { useMe } from "@/lib/api";
import { Avatar, Spinner } from "@/components/ui";

export default function CampaignsLayout({ children }: { children: React.ReactNode }) {
  const { me } = useMe("user");
  if (!me || me.kind !== "user") {
    return <div className="flex h-dvh items-center justify-center"><Spinner /></div>;
  }
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface/85 px-4 backdrop-blur-md lg:px-6">
        <Link href="/mail" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-hover hover:text-text">
          <ArrowLeft className="h-4 w-4" /> Inbox
        </Link>
        <span className="h-5 w-px bg-border" />
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-fg"><Mail className="h-4 w-4" /></span>
        <Link href="/mail/campaigns" className="flex items-center gap-1.5 text-sm font-semibold">
          <Send className="h-4 w-4 text-muted" /> Campaigns
        </Link>
        <span className="flex-1" />
        <ThemeToggle />
        <span className="flex items-center gap-2 text-sm">
          <Avatar name={me.display_name || me.email} size={28} />
          <span className="hidden sm:inline">{me.email}</span>
        </span>
      </header>
      <main className="px-4 py-6 lg:px-8 lg:py-8">
        <div className="mx-auto max-w-[1100px]">{children}</div>
      </main>
    </div>
  );
}

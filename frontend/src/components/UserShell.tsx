"use client";

import { Inbox, LayoutDashboard, Mail, Send } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";
import { useMe, type Me } from "@/lib/api";
import { Avatar, Spinner, cx } from "@/components/ui";

type UserMe = Extract<Me, { kind: "user" }>;

/** Top bar shared by the mailbox user's pages outside the webmail (dashboard, campaigns). */
export default function UserShell({ children }: { children: (me: UserMe) => React.ReactNode }) {
  const { me } = useMe("user");
  const path = usePathname();
  if (!me || me.kind !== "user") {
    return <div className="flex h-dvh items-center justify-center"><Spinner /></div>;
  }
  const links = [
    { href: "/mail/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/mail", label: "Inbox", icon: Inbox },
    ...(me.can_campaign ? [{ href: "/mail/campaigns", label: "Campaigns", icon: Send }] : []),
  ];
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/85 px-3 backdrop-blur-md sm:gap-3 lg:px-6">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg"><Mail className="h-4 w-4" /></span>
        <span className="hidden truncate font-semibold md:inline">{me.brand_name}</span>
        <nav className="ml-1 flex min-w-0 items-center gap-0.5" aria-label="Sections">
          {links.map(({ href, label, icon: Icon }) => {
            const active = href === "/mail" ? path === "/mail" : path.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm",
                  active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-hover hover:text-text",
                )}
              >
                <Icon className="h-4 w-4" /> <span className="hidden sm:inline">{label}</span>
              </Link>
            );
          })}
        </nav>
        <span className="flex-1" />
        <ThemeToggle />
        <Link href="/account" className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-hover" title="Account settings">
          <Avatar name={me.display_name || me.email} src={me.avatar_url} size={28} />
          <span className="hidden lg:inline">{me.email}</span>
        </Link>
      </header>
      <main className="px-4 py-6 lg:px-8 lg:py-8">
        <div className="mx-auto max-w-[1200px]">{children(me)}</div>
      </main>
    </div>
  );
}

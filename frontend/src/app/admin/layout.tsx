"use client";

import {
  Activity, AtSign, BarChart3, ChevronsLeft, DatabaseBackup, Download, FileText, Filter, Forward, Gauge, Globe, ListOrdered,
  LogOut, Mail, Megaphone, Menu as MenuIcon, ScrollText, Send, Server, Settings, ShieldAlert, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { logout, useMe } from "@/lib/api";
import ThemeToggle from "@/components/ThemeToggle";
import { Avatar, Menu, MenuItem, Spinner, cx } from "@/components/ui";

const NAV = [
  { group: "Overview", items: [{ href: "/admin", label: "Dashboard", icon: Gauge }] },
  {
    group: "Monitoring",
    items: [
      { href: "/admin/analytics", label: "User analytics", icon: BarChart3 },
      { href: "/admin/messages", label: "Message log", icon: ScrollText },
      { href: "/admin/reports", label: "Reports", icon: FileText },
      { href: "/admin/campaigns", label: "Campaigns", icon: Megaphone },
      { href: "/admin/queue", label: "Mail queue", icon: ListOrdered },
    ],
  },
  {
    group: "Mail",
    items: [
      { href: "/admin/domains", label: "Domains", icon: Globe },
      { href: "/admin/mailboxes", label: "Mailboxes", icon: AtSign },
      { href: "/admin/aliases", label: "Aliases", icon: Forward },
    ],
  },
  {
    group: "Security",
    items: [
      { href: "/admin/spam", label: "Spam filter", icon: ShieldAlert },
      { href: "/admin/filters", label: "Mail filters", icon: Filter },
    ],
  },
  {
    group: "System",
    items: [
      { href: "/admin/hosts", label: "Hosts & TLS", icon: Server },
      { href: "/admin/relays", label: "SMTP relays", icon: Send },
      { href: "/admin/backups", label: "Backups", icon: DatabaseBackup },
      { href: "/admin/updates", label: "Updates", icon: Download },
      { href: "/admin/settings", label: "Settings", icon: Settings },
    ],
  },
];

const ALL = NAV.flatMap((g) => g.items.map((i) => ({ ...i, group: g.group })));

function current(pathname: string) {
  return [...ALL].sort((a, b) => b.href.length - a.href.length).find((i) => (i.href === "/admin" ? pathname === "/admin" : pathname.startsWith(i.href)));
}

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { me } = useMe("admin");
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => setMobileOpen(false), [pathname]);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("ms.sidebar") === "collapsed");
    } catch {
      /* storage unavailable */
    }
  }, []);
  useEffect(() => {
    const page = current(pathname);
    if (me) document.title = `${page ? `${page.label} · ` : ""}${me.brand_name} Admin`;
  }, [pathname, me]);

  if (!me || me.kind !== "admin") {
    return (
      <div className="flex h-dvh items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const page = current(pathname);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("ms.sidebar", c ? "open" : "collapsed");
      } catch {
        /* storage unavailable */
      }
      return !c;
    });
  };

  const sidebar = (mobile: boolean) => (
    <div className="flex h-full flex-col">
      <div className={cx("flex h-14 shrink-0 items-center gap-2.5 border-b border-border", collapsed && !mobile ? "justify-center px-2" : "px-4")}>
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg shadow-card">
          <Mail className="h-4 w-4" />
        </span>
        {(!collapsed || mobile) && (
          <div className="min-w-0 flex-1">
            <p className="truncate text-[15px] leading-tight font-semibold">{me.brand_name}</p>
            <p className="text-[11px] tracking-wide text-muted uppercase">Admin console</p>
          </div>
        )}
        {mobile && (
          <button onClick={() => setMobileOpen(false)} className="rounded-lg p-1.5 text-muted hover:bg-hover" aria-label="Close menu">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2.5 py-3" aria-label="Admin">
        {NAV.map((g) => (
          <div key={g.group} className="mb-4">
            {(!collapsed || mobile) && <p className="mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-faint uppercase">{g.group}</p>}
            {g.items.map(({ href, label, icon: Icon }) => {
              const active = page?.href === href;
              return (
                <Link
                  key={href}
                  href={href}
                  title={collapsed && !mobile ? label : undefined}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "group relative flex items-center gap-2.5 rounded-lg py-[7px] text-[13.5px] transition-colors",
                    collapsed && !mobile ? "justify-center px-0" : "px-2.5",
                    active ? "bg-accent-soft font-medium text-accent" : "text-text-2 hover:bg-hover hover:text-text",
                  )}
                >
                  <Icon className={cx("h-[17px] w-[17px] shrink-0", active ? "text-accent" : "text-muted group-hover:text-text")} />
                  {(!collapsed || mobile) && label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      {!mobile && (
        <button onClick={toggleCollapsed} className="flex h-10 shrink-0 items-center gap-2 border-t border-border px-4 text-[13px] text-muted hover:bg-hover hover:text-text">
          <ChevronsLeft className={cx("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
          {!collapsed && "Collapse"}
        </button>
      )}
    </div>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className={cx("sticky top-0 hidden h-dvh shrink-0 border-r border-border bg-surface transition-[width] lg:block", collapsed ? "w-[60px]" : "w-60")}>
        {sidebar(false)}
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="animate-slide absolute inset-y-0 left-0 w-64 border-r border-border bg-surface shadow-modal">{sidebar(true)}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface/85 px-4 backdrop-blur-md lg:px-6">
          <button onClick={() => setMobileOpen(true)} className="-ml-1 rounded-lg p-1.5 text-muted hover:bg-hover lg:hidden" aria-label="Open menu">
            <MenuIcon className="h-5 w-5" />
          </button>
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            <span className="hidden text-muted sm:inline">{page?.group || "Admin"}</span>
            <span className="hidden text-faint sm:inline">/</span>
            <span className="truncate font-medium">{page?.label || "Admin"}</span>
          </nav>
          <span className="flex-1" />
          <span className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted md:inline-flex">
            <Activity className="h-3.5 w-3.5 text-ok" /> Live
          </span>
          <ThemeToggle />
          <Menu
            trigger={(toggle) => (
              <button onClick={toggle} className="flex items-center gap-2 rounded-lg py-1 pr-2 pl-1 hover:bg-hover" aria-label="Account menu">
                <Avatar name={me.username} size={28} />
                <span className="hidden text-sm font-medium sm:inline">{me.username}</span>
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="border-b border-border px-2.5 pt-1.5 pb-2.5">
                  <p className="text-sm font-medium">{me.username}</p>
                  <p className="text-xs text-muted">Administrator</p>
                </div>
                <div className="pt-1">
                  <MenuItem onClick={() => { close(); window.location.href = "/admin/settings"; }}>Settings & password</MenuItem>
                  <MenuItem danger onClick={logout}>
                    <span className="flex items-center gap-2"><LogOut className="h-4 w-4" /> Sign out</span>
                  </MenuItem>
                </div>
              </>
            )}
          </Menu>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 lg:px-8 lg:py-8">
          <div className="mx-auto max-w-[1280px]">{children}</div>
        </main>
      </div>
    </div>
  );
}

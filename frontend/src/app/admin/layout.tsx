"use client";

import {
  Activity, AtSign, BarChart3, ChevronsLeft, Cpu, DatabaseBackup, Download, FileText, Filter, Forward, Gauge, Globe, ListOrdered,
  History, LogOut, Mail, Megaphone, Menu as MenuIcon, ScrollText, Send, Server, Settings, ShieldAlert, UserCog, X,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { type AdminMe, api, logout, useMe } from "@/lib/api";
import { AdminContext } from "@/lib/admin";
import ThemeToggle from "@/components/ThemeToggle";
import { Avatar, Menu, MenuItem, Spinner, cx } from "@/components/ui";

type Item = { href: string; label: string; icon: typeof Gauge; perm?: string };

// perm: permission needed by limited admins; no perm = super administrators only.
const NAV: { group: string; items: Item[] }[] = [
  { group: "Overview", items: [{ href: "/admin", label: "Dashboard", icon: Gauge, perm: "analytics.view" }] },
  {
    group: "Monitoring",
    items: [
      { href: "/admin/analytics", label: "User analytics", icon: BarChart3, perm: "analytics.view" },
      { href: "/admin/messages", label: "Message log", icon: ScrollText, perm: "analytics.view" },
      { href: "/admin/reports", label: "Reports", icon: FileText, perm: "analytics.view" },
      { href: "/admin/campaigns", label: "Campaigns", icon: Megaphone, perm: "campaigns.manage" },
      { href: "/admin/queue", label: "Mail queue", icon: ListOrdered },
    ],
  },
  {
    group: "Mail",
    items: [
      { href: "/admin/domains", label: "Domains", icon: Globe, perm: "domains.view" },
      { href: "/admin/mailboxes", label: "Mailboxes", icon: AtSign, perm: "mailboxes.view" },
      { href: "/admin/aliases", label: "Aliases", icon: Forward, perm: "aliases.manage" },
    ],
  },
  {
    group: "Security",
    items: [
      { href: "/admin/spam", label: "Spam filter", icon: ShieldAlert },
      { href: "/admin/filters", label: "Mail filters", icon: Filter },
      { href: "/admin/admins", label: "Administrators", icon: UserCog },
      { href: "/admin/audit", label: "Audit log", icon: History },
    ],
  },
  {
    group: "System",
    items: [
      { href: "/admin/hosts", label: "Hosts & TLS", icon: Server },
      { href: "/admin/relays", label: "SMTP relays", icon: Send },
      { href: "/admin/backups", label: "Backups", icon: DatabaseBackup },
      { href: "/admin/services", label: "Services & jobs", icon: Cpu },
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

  const admin = me && me.kind === "admin" ? (me as AdminMe) : null;
  const isSuper = admin?.role === "super_admin";
  const [notice, setNotice] = useState<{ update_available: boolean; latest_version: string; current_version: string; update_running: boolean } | null>(null);

  // "Update available" in the header. Reads the result of the server's own periodic check
  // (every 6 hours) and looks again every 30 minutes and whenever the window regains focus.
  useEffect(() => {
    if (!isSuper) return;
    const load = () => api<typeof notice>("/admin/system/update-notice", { noRedirect: true }).then(setNotice).catch(() => {});
    load();
    const timer = setInterval(load, 30 * 60 * 1000);
    window.addEventListener("focus", load);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, [isSuper, pathname]);
  const allowed = (i: Item) => admin?.role === "super_admin" || (!!i.perm && !!admin?.permissions.includes(i.perm));
  const nav = NAV.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length);
  const first = nav[0]?.items[0]?.href;

  // A limited admin landing on a page they cannot use goes to their first allowed page;
  // anyone who must set up two-factor sign-in goes to their account page first.
  useEffect(() => {
    if (!admin || pathname.startsWith("/admin/account")) return;
    if (admin.require_2fa && !admin.totp_enabled) {
      window.location.replace("/admin/account?setup2fa=1");
      return;
    }
    const page = current(pathname);
    if (page && !allowed(page) && first) window.location.replace(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin, pathname, first]);

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
        {nav.map((g) => (
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
            <span className="hidden text-muted sm:inline">{page?.group || (pathname.startsWith("/admin/account") ? "Account" : "Admin")}</span>
            <span className="hidden text-faint sm:inline">/</span>
            <span className="truncate font-medium">{page?.label || (pathname.startsWith("/admin/account") ? "My account" : "Admin")}</span>
          </nav>
          <span className="flex-1" />
          {notice?.update_running && !pathname.startsWith("/admin/updates") && (
            <Link href="/admin/updates" className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent-soft px-3 py-1 text-xs font-medium text-accent">
              <Download className="h-3.5 w-3.5 animate-pulse" /> Updating…
            </Link>
          )}
          {notice?.update_available && !pathname.startsWith("/admin/updates") && (
            <Link
              href="/admin/updates"
              className="inline-flex items-center gap-1.5 rounded-full bg-accent px-3 py-1 text-xs font-semibold text-accent-fg shadow-card hover:opacity-90"
              title="A new version of MailSomadhan is available"
            >
              <Download className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Update available{notice.latest_version && notice.latest_version !== notice.current_version ? ` · v${notice.latest_version}` : ""} — Update now</span>
              <span className="sm:hidden">Update</span>
            </Link>
          )}
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
                  <p className="text-xs text-muted">{admin?.role === "super_admin" ? "Super administrator" : `Administrator · ${admin?.domains?.map((d) => d.name).join(", ")}`}</p>
                </div>
                <div className="pt-1">
                  <MenuItem onClick={() => { close(); window.location.href = "/admin/account"; }}>My account & security</MenuItem>
                  <MenuItem danger onClick={logout}>
                    <span className="flex items-center gap-2"><LogOut className="h-4 w-4" /> Sign out</span>
                  </MenuItem>
                </div>
              </>
            )}
          </Menu>
        </header>
        <main className="min-w-0 flex-1 px-4 py-6 lg:px-8 lg:py-8">
          <div className="mx-auto max-w-[1280px]">
            {admin && admin.require_2fa && !admin.totp_enabled && !pathname.startsWith("/admin/account") ? null : (
              <AdminContext.Provider value={admin}>
                {page && !allowed(page) ? (
                  first ? (
                    <div className="flex justify-center py-16"><Spinner /></div>
                  ) : (
                    <div className="mx-auto max-w-md py-16 text-center">
                      <p className="text-base font-semibold">No access yet</p>
                      <p className="mt-2 text-sm text-muted">
                        Your account has no permissions in this console. Ask a super administrator to grant you access to a domain.
                      </p>
                      <Link href="/admin/account" className="mt-4 inline-block text-sm font-medium text-accent hover:underline">Go to my account</Link>
                    </div>
                  )
                ) : (
                  children
                )}
              </AdminContext.Provider>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

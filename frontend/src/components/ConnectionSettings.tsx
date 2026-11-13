"use client";

import { Badge, CopyText, Notice } from "@/components/ui";

export type Connection = {
  email: string;
  username: string;
  host: string;
  certificate: "trusted" | "self-signed" | "none" | "error";
  webmail_url: string;
  imap: { host: string; port: number; security: string };
  smtp: { host: string; port: number; security: string }[];
};

function Row({ label, value, copy = true, mono = true }: { label: string; value: string; copy?: boolean; mono?: boolean }) {
  return (
    <div className="flex items-center gap-3 border-t border-border py-2 first:border-t-0">
      <dt className="w-32 shrink-0 text-[13px] text-muted">{label}</dt>
      <dd className={`min-w-0 flex-1 break-all text-[13px] ${mono ? "font-mono" : ""}`}>{value}</dd>
      {copy && <CopyText value={value} label={`Copy ${label.toLowerCase()}`} />}
    </div>
  );
}

function Section({ title, badge, children }: { title: string; badge?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {badge}
      </div>
      <dl className="rounded-lg border border-border bg-sunken px-3">{children}</dl>
    </div>
  );
}

/** Webmail, IMAP and SMTP settings for one mailbox: shown to the user and to administrators. */
export function ConnectionSettings({ info }: { info: Connection }) {
  return (
    <div className="space-y-4">
      {info.certificate !== "trusted" && (
        <Notice tone="warn" title="No trusted certificate yet">
          {info.host} does not have a certificate from a public authority, so browsers and mail apps will show a security
          warning. An administrator can request one under Hosts &amp; TLS.
        </Notice>
      )}
      <Section title="Account">
        <Row label="Email address" value={info.email} />
        <Row label="Username" value={info.username} />
        <Row label="Password" value="Your mailbox password" copy={false} mono={false} />
      </Section>
      <Section title="Webmail">
        <Row label="Address" value={info.webmail_url} />
      </Section>
      <Section title="Incoming mail" badge={<Badge>IMAP</Badge>}>
        <Row label="Server" value={info.imap.host} />
        <Row label="Port" value={String(info.imap.port)} />
        <Row label="Security" value={info.imap.security} copy={false} mono={false} />
      </Section>
      <Section title="Outgoing mail" badge={<Badge>SMTP</Badge>}>
        <Row label="Server" value={info.smtp[0].host} />
        {info.smtp.map((s) => (
          <Row key={s.port} label={`Port (${s.security})`} value={String(s.port)} />
        ))}
        <Row label="Authentication" value="Required: same username and password" copy={false} mono={false} />
      </Section>
      <p className="text-[13px] text-muted">
        In a mail app choose manual setup and IMAP, and use the full email address as the username for both incoming and outgoing mail.
      </p>
    </div>
  );
}

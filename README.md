# MailSomadhan

A self-hosted, secure email server with a web admin panel and webmail, installed on Ubuntu with one command.

- **Mail server**: Postfix (SMTP), Dovecot (IMAP, storage, quotas), Rspamd (spam filter, DKIM signing), PostgreSQL
- **Web panel and webmail**: Next.js frontend, FastAPI (Python) backend, served by nginx over HTTPS
- **Security**: TLS 1.2+ everywhere, Let's Encrypt certificates, DKIM/SPF/DMARC, bcrypt passwords, fail2ban, ufw firewall, sender-spoofing protection

## Install

Requirements: a fresh Ubuntu 22.04 or 24.04 server (2 GB RAM recommended), a hostname such as `mail.example.com` whose DNS A record points to the server, and port 25 open at your hosting provider.

```bash
curl -fsSL https://raw.githubusercontent.com/mdatiqmazumder/MailSomadhan/main/install.sh | sudo bash
```

The installer asks two questions (mail hostname and the HTTPS port of the panel), then prints the panel address and the generated admin password. Everything else is configured in the panel.

Unattended install:

```bash
curl -fsSL https://raw.githubusercontent.com/mdatiqmazumder/MailSomadhan/main/install.sh | sudo MAILSOMADHAN_HOSTNAME=mail.example.com MAILSOMADHAN_PORT=8443 bash
```

## What the panel does

**Admin** (sign in as `admin`)

| Page | Purpose |
| --- | --- |
| Dashboard | Mail flow, delivery rate, threats stopped, bounces, top senders and destinations, server health |
| User analytics | Per-user sent/received, external recipients, bounce rate, spam-flagged mail, volume; drill-down with activity heatmap and top recipients |
| Message log | Every message with filters (direction, status, domain, sender, recipient, spam, attachments) and full delivery details |
| Reports | CSV exports (traffic, users, sender domains, full log) and a printable PDF management report |
| Campaigns | Choose which mailboxes may send campaigns, oversee users' individual sending, approve large campaigns, set daily and per-domain limits, manage the do-not-send list |
| Mail filters | Block or trust senders and domains, block IP ranges and attachment types |
| Backups | Encrypted, scheduled backups to Google Drive, connected with a Google sign-in link or an rclone token (see [docs/BACKUP.md](docs/BACKUP.md)) |
| Push notifications | Firebase Cloud Messaging credentials (stored encrypted) so users get browser notifications of new mail, even with the webmail closed; option to hide sender and subject |
| Domains | Add any number of domains; shows the MX, SPF, DKIM and DMARC records to publish and checks them live, or creates them automatically on Cloudflare after a one-time connection (optionally deleting old records of the same kind and adding fresh ones); DKIM key rotation; a storage pool shared by its mailboxes |
| Mailboxes | Create users, set each mailbox's storage (a size in GB or unlimited; never above the server maximum or the domain's pool), see real usage, reset passwords, disable accounts, set profile pictures, see and clear forwarding; open a user's mailbox to read and send as them for one hour (audit-logged) |
| Postmaster | A postmaster@ mailbox for every domain (created automatically for new domains): read bounce notices and DMARC reports in the panel, set a password for the webmail, forward copies |
| Aliases | Forwarding addresses, and a catch-all per domain for mail to unknown addresses |
| Hosts & TLS | Extra hostnames for the panel, SMTP and IMAP, each with its own Let's Encrypt certificate (SNI) |
| SMTP relays | Send through external SMTP services; one relay per domain or a default for all |
| Mail queue | See, retry and delete queued mail |
| Spam filter | Turn the spam filter on or off, set junk and reject scores, greylisting, Redis on/off, and whether subjects are recorded |
| Updates | Check GitHub for a newer version and install it with one click; a failed update is rolled back automatically |
| Administrators | Super administrators and limited administrators with chosen permissions on chosen domains; two-factor sign-in |
| Audit log | Every console change and sign-in, with who, when and from where |
| Settings | Product name, attachment limit, default quota, admin password |

**Users** (sign in with their email address)

A personal dashboard on sign-in (sent, delivered, bounced, delayed and received mail, campaign quota, recent sent mail with bounce reasons). Webmail with folders, search, new mail shown instantly, browser notifications, rich-text editor, attachments (drag and drop), reply/forward, drafts, spam and archive handling, print and PDF download of any email, profile picture, forwarding to another address (with or without a copy), signature and password settings. Users stay signed in for a year (administrators for 12 hours).

**Campaigns** (webmail → Campaigns, for mailboxes an administrator allowed): send one message to many recipients, each as a separate personal email (nobody sees the other addresses). Recipients from a pasted list or CSV, merge fields such as `{{first_name|there}}`, attachments, and pacing: all at once, one every N minutes, or a random pause within a range. Every campaign respects the administrator's daily limit per user and hourly limit per recipient domain, includes a one-click unsubscribe link (RFC 8058) by default, skips people who unsubscribed or bounced, and shows per-recipient delivery status. Any IMAP/SMTP mail app works too: IMAP 993 (SSL), SMTP 465 (SSL) or 587 (STARTTLS).

## Managing the server

```bash
sudo mailsomadhan status                 # state of every service
sudo mailsomadhan reset-admin-password   # new admin password
sudo mailsomadhan update                 # pull the latest version and re-apply
sudo mailsomadhan logs                   # recent logs
sudo mailsomadhan uninstall              # remove MailSomadhan (see below)
```

### Uninstalling

```bash
sudo mailsomadhan uninstall
```

It asks you to type the mail hostname to confirm, then removes the panel, API, services, management commands, the panel's Let's Encrypt certificates and the MailSomadhan configuration of Postfix, Dovecot, Rspamd, nginx and fail2ban, and closes the mail ports in ufw. By default the mail in `/var/vmail`, the `mailsomadhan` PostgreSQL database and the DKIM keys stay on the server, and the configuration and secrets (including the backup passphrase) are saved to `/root/mailsomadhan-saved-<date>.tar.gz`. Other websites, PostgreSQL, nginx, Redis and Node.js are never removed.

| Option | Effect |
| --- | --- |
| `--purge` | Also delete all mail, the database, DKIM keys and secrets. Cannot be undone. |
| `--remove-packages` | Also remove the Postfix, Dovecot and Rspamd packages |
| `--yes` | Skip the confirmation (for scripts) |

Files: application in `/opt/mailsomadhan`, configuration and secrets in `/etc/mailsomadhan`, mail in `/var/vmail`, install log in `/var/log/mailsomadhan-install.log`.

## Updating

Every push to the `main` branch of this repository is a new release. Bump the number in `VERSION` when you publish one.

Admins open **Updates** in the panel, click **Check for updates** to see what changed, then **Update now**. The server downloads the latest code, re-runs the installer (data, settings and secrets are kept) and restarts the services, usually within a few minutes. If anything fails, the previous version is restored automatically. The same update can be run with `sudo mailsomadhan update`.

The repository must stay public, because servers download updates without credentials.

## Deliverability checklist

1. Publish the DNS records the panel shows for each domain.
2. Set the reverse DNS (PTR) of the server IP to the mail hostname at your hosting provider.
3. Issue a trusted certificate under Hosts & TLS.
4. If your provider blocks outbound port 25, add an SMTP relay.

## Development

```bash
# API (SQLite, no mail server needed for the admin pages)
cd backend && python -m venv .venv && .venv/bin/pip install -r requirements.txt
MAILSOMADHAN_DEV_MODE=true MAILSOMADHAN_COOKIE_SECURE=false .venv/bin/uvicorn app.main:app --port 18080

# Web panel
cd frontend && npm install && npm run dev
```

## Layout

```
install.sh            one-command bootstrap (clones the repo, runs installer/setup.sh)
installer/setup.sh    idempotent installer: packages, database, Postfix, Dovecot, Rspamd, nginx, firewall
installer/mailsomadhan-helper   small root helper the panel calls through sudo (validated subcommands only)
installer/mailsomadhan     management command
backend/              FastAPI application
frontend/             Next.js application
```

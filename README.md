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
| Mail filters | Block or trust senders and domains, block IP ranges and attachment types |
| Backups | Encrypted, scheduled backups to Google Drive (see [docs/BACKUP.md](docs/BACKUP.md)) |
| Domains | Add any number of domains; shows the MX, SPF, DKIM and DMARC records to publish and checks them live; DKIM key rotation |
| Mailboxes | Create users, set quotas, reset passwords, disable accounts |
| Aliases | Forwarding addresses and catch-alls |
| Hosts & TLS | Extra hostnames for the panel, SMTP and IMAP, each with its own Let's Encrypt certificate (SNI) |
| SMTP relays | Send through external SMTP services; one relay per domain or a default for all |
| Mail queue | See, retry and delete queued mail |
| Spam filter | Turn the spam filter on or off, set junk and reject scores, greylisting, Redis on/off, and whether subjects are recorded |
| Updates | Check GitHub for a newer version and install it with one click; a failed update is rolled back automatically |
| Settings | Product name, attachment limit, default quota, admin password |

**Users** (sign in with their email address)

Webmail with folders, search, rich-text editor, attachments (drag and drop), reply/forward, drafts, spam and archive handling, signature and password settings. Any IMAP/SMTP mail app works too: IMAP 993 (SSL), SMTP 465 (SSL) or 587 (STARTTLS).

## Managing the server

```bash
sudo mailsomadhan status                 # state of every service
sudo mailsomadhan reset-admin-password   # new admin password
sudo mailsomadhan update                 # pull the latest version and re-apply
sudo mailsomadhan logs                   # recent logs
```

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

# Security audit — MailSomadhan 1.5.0

Date: 2026-11-13 · Scope: installer, privileged helper, FastAPI backend, Next.js console and webmail, mail stack configuration (Postfix, Dovecot, Rspamd, PostgreSQL, Redis, nginx) · Method: code review plus live checks on a test installation (Ubuntu 24.04).

## Summary

| Severity | Found | Fixed in 1.5.0 | Open (recommendations) |
| --- | --- | --- | --- |
| High | 1 | 1 | 0 |
| Medium | 9 | 9 | 0 |
| Low / hardening | 4 | 2 | 2 |
| Recommendations | — | — | 6 |

## Findings fixed in this release

### H-1 · Root could be tricked into overwriting system files (privilege escalation)
Root (the installer and the privileged helper) wrote status files (`version.json`, `update-result.json`, `backup-*.json`) into `/var/lib/mailsomadhan`, a directory owned by the panel user. An attacker who compromised the panel process could replace one of those files with a symbolic link to, for example, `/etc/shadow`, and the next update or backup would overwrite that file as root.
**Fix:** root now writes only into `/var/lib/mailsomadhan-status` (owned by root, mode 755). Old files are removed from the panel directory during the update. Verified: a link planted by the panel user is not followed.

### M-1 · Sessions survived password changes and account disabling
Login tokens stayed valid for 12 hours even after a password reset or after an account was disabled.
**Fix:** every account has a session version included in the token. Changing a password, disabling an account, changing an administrator's rights or resetting 2FA ends all other sessions at once. "Sign out everywhere else" was added.

### M-2 · Sign-in throttling was per worker process
The failed-login counter lived in memory, so each of the two API workers counted separately and restarts reset it.
**Fix:** failures are stored in the database: 10 per IP and 15 per account within 15 minutes, shared by all workers. fail2ban still bans repeat offenders at the firewall.

### M-3 · No second factor for console accounts
**Fix:** TOTP two-factor sign-in (any authenticator app) with QR setup; a super administrator can make it mandatory for every console account and can reset it for someone who lost their phone.

### M-4 · No audit trail
**Fix:** every change made through the console and every console sign-in (successful or not) is recorded with account, time, IP address and request details. Passwords, tokens, codes and secrets are removed before storing. Viewable under Security → Audit log.

### M-5 · The internet-facing API could read all system logs
The panel user was a member of `adm` and `systemd-journal` (added for the log collector), so a compromised API could read every system log.
**Fix:** only the collector service gets these groups (through its systemd unit); the groups were removed from the user.

### M-6 · Rspamd controller used the distribution's default password and trusted localhost
The spam filter's control interface (localhost only) used the default password `q1` and accepted any local process without a password.
**Fix:** a random password is generated at install and the localhost exception is removed. Verified: requests without the password, or with `q1`, are refused.

### M-7 · No Content-Security-Policy
**Fix:** the console and webmail send a strict policy (`default-src 'self'`, no plugins, no framing by other sites, forms only to itself) plus `Permissions-Policy` and `Cross-Origin-Opener-Policy`. Email bodies keep their own, stricter policy inside a sandboxed frame.

### M-8 · IMAP command injection through folder names
Folder names from the browser were sent to the IMAP server without rejecting line breaks; a crafted name could add extra IMAP commands (limited to the user's own mailbox).
**Fix:** names with control characters are refused.

### M-9 · Spreadsheet formula injection in CSV reports
Subjects and addresses written by outsiders (for example `=HYPERLINK(...)`) were exported unchanged and would run as formulas in Excel.
**Fix:** such cells are prefixed so they are shown as text.

### L-1 · Weak passwords accepted
**Fix:** console accounts need 12 characters, mailboxes 8; very common passwords and passwords with fewer than 4 different characters are refused.

### L-2 · Console reachable from anywhere
**Fix (optional):** Settings → Console security → "Allow console sign-in only from" accepts IP addresses and networks. Saving a list that would lock you out is refused; `sudo mailsomadhan open-console` removes the list in an emergency. Webmail is not affected.

## New: role-based access control

* **Super administrator:** everything.
* **Administrator (limited):** only the permissions ticked on the account (view domain/DNS, view/create/edit/delete mailboxes, reset passwords, aliases, analytics and reports, campaigns), and only on the domains assigned to them.
* Every console endpoint is super-administrator-only unless it explicitly checks a permission **and** restricts its data to the account's domains, so a forgotten endpoint fails closed. Objects on other domains answer "not found", so their existence is not revealed.
* There is always at least one active super administrator; nobody can demote, disable or delete themselves.

## Verified as already sound

| Area | Result |
| --- | --- |
| TLS | TLS 1.0/1.1 refused on 8443 (console), 465, 587 and 993; TLS 1.2/1.3 accepted |
| Open relay | Port 25 offers no authentication and relays only for local domains; submission (587/465) requires TLS and login, and senders cannot use addresses they do not own |
| Exposed services | PostgreSQL, Redis, Rspamd, the API, the Next.js server and the webmail IMAP port listen on 127.0.0.1 only |
| Database access | Postfix/Dovecot use a read-only database role limited to four tables; queries use the servers' own escaping |
| Secrets on disk | `install.conf`, backup key and Drive token are root-only (600); the API's environment file is 640 root:panel; TLS private keys 600 |
| Privileged helper | The panel can only run one script through sudo; every argument is validated against a fixed pattern and nothing is evaluated |
| Web session | HttpOnly, Secure, SameSite=Strict cookie, plus a required custom header on every change (CSRF) |
| Email rendering | HTML is sanitised server-side (scripts, handlers, forms, frames removed) and shown in a sandboxed frame without scripts; remote images are blocked until the reader allows them |
| Attachments | Downloaded with `nosniff` and a sandboxing policy; only images, PDF and plain text open inline |
| Brute force on mail ports | fail2ban jails for SSH, Postfix, Dovecot and the console |

## Recommendations (not yet implemented)

1. **Signed releases.** Updates install whatever is on the `main` branch of the GitHub repository; anyone who gains write access to the repository can push code to every server. Protect the branch (required reviews, 2FA on GitHub) and consider signing release tags and verifying the signature before updating.
2. **Outbound limit for ordinary mail.** Campaigns are rate-limited, but a stolen mailbox password still allows unlimited normal sending through SMTP, which could get the server's IP blacklisted. Add a per-account hourly limit at the SMTP level (Rspamd ratelimit, needs Redis).
3. **App passwords for mail clients.** Mailbox users cannot use two-factor sign-in because IMAP/SMTP clients only send a password. Per-device app passwords would allow 2FA for webmail.
4. **Pin dependency versions.** Python requirements use minimum versions; pin exact versions (with hashes) for reproducible, reviewable installs. The Node.js lockfile is already committed.
5. **Relay passwords at rest.** External SMTP relay passwords are stored readable in the database because Postfix must read them; database access is local-only, but keep relay credentials scoped to sending only.
6. **Installer integrity.** `curl … | sudo bash` trusts GitHub and TLS; publish a checksum so cautious administrators can verify `install.sh` before running it.

## Test evidence (test installation)

* Security checks: 29/29 (status-directory symlink attack, log access, Rspamd controller, headers, RBAC on PostgreSQL, 2FA, IP allowlist and emergency reset, audit log without secrets)
* RBAC unit checks: 39/39 (domain isolation for mailboxes, aliases, analytics, message log and CSV reports; permission checks; session revocation)
* Regression: mail end-to-end 35/35, spam filter and Redis switches 16/16, campaigns 27/27

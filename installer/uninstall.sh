#!/usr/bin/env bash
#
# MailSomadhan uninstaller.
#
#   sudo mailsomadhan uninstall [options]
#   sudo bash /opt/mailsomadhan/src/installer/uninstall.sh [options]
#
# By default the mail itself is kept: mailboxes in /var/vmail, the PostgreSQL database and the
# DKIM keys stay where they are, and the configuration and secrets (including the backup
# passphrase) are saved to /root/mailsomadhan-saved-<date>.tar.gz before they are removed.
#
# Options:
#   --purge             also delete all mail, the database, DKIM keys and saved secrets (no undo)
#   --remove-packages   also remove the mail server packages (Postfix, Dovecot, Rspamd);
#                       PostgreSQL, nginx, Redis, Node.js and other shared packages are kept
#   --yes               do not ask for confirmation (for scripts)
#
set -uo pipefail
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
cd /

APP_DIR=/opt/mailsomadhan
ETC_DIR=/etc/mailsomadhan
STATE_DIR=/var/lib/mailsomadhan
STATUS_DIR=/var/lib/mailsomadhan-status
MAIL_DIR=/var/vmail
DKIM_DIR=/var/lib/rspamd/dkim

c_bold=$'\033[1m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_green=$'\033[32m'; c_off=$'\033[0m'
step() { echo; echo "${c_bold}==> $*${c_off}"; }
info() { echo "    $*"; }
warn() { echo "${c_yellow}    warning: $*${c_off}"; }
fail() { echo "${c_red}error: $*${c_off}" >&2; exit 1; }

PURGE=0; REMOVE_PACKAGES=0; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=1 ;;
    --remove-packages) REMOVE_PACKAGES=1 ;;
    --yes|-y) ASSUME_YES=1 ;;
    -h|--help) sed -n '2,17p' "$SELF" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) fail "unknown option: $arg (see --help)" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || fail "run as root: sudo mailsomadhan uninstall"
[ -d "$APP_DIR" ] || [ -d "$ETC_DIR" ] || fail "MailSomadhan does not seem to be installed here"

MAIL_HOSTNAME=""; WEB_PORT=""; HTTP_PORT=""
# shellcheck disable=SC1091
[ -f "$ETC_DIR/helper.conf" ] && . "$ETC_DIR/helper.conf"
HTTP_PORT="${HTTP_PORT:-80}"

# --------------------------------------------------------------------------- confirmation
echo
echo "${c_bold}Uninstall MailSomadhan${MAIL_HOSTNAME:+ ($MAIL_HOSTNAME)}${c_off}"
echo
echo "  Removed: the web panel, API, background services, management commands, Let's Encrypt"
echo "           certificates, and the MailSomadhan configuration of Postfix, Dovecot, Rspamd,"
echo "           nginx and fail2ban."
if [ "$PURGE" -eq 1 ]; then
  echo "${c_red}  Deleted for good: every mailbox in $MAIL_DIR, the database, DKIM keys"
  echo "           and secrets (including the backup passphrase). This cannot be undone.${c_off}"
else
  echo "  Kept:    mail in $MAIL_DIR, the PostgreSQL database 'mailsomadhan' and DKIM keys."
  echo "           Configuration and secrets are saved to /root before removal."
fi
[ "$REMOVE_PACKAGES" -eq 1 ] && echo "  Packages: postfix, dovecot and rspamd are removed."
echo

if [ "$ASSUME_YES" -ne 1 ]; then
  (exec </dev/tty) 2>/dev/null || fail "no terminal to confirm on; re-run with --yes"
  expected="${MAIL_HOSTNAME:-uninstall}"
  read -r -p "Type '$expected' to continue: " reply </dev/tty >/dev/tty 2>&1 || reply=""
  [ "$reply" = "$expected" ] || fail "cancelled, nothing was changed"
fi

LOG_FILE=/root/mailsomadhan-uninstall.log
: > "$LOG_FILE"; chmod 600 "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

# Hosts with certificates issued through the panel (the primary name plus the extra hosts).
HOST_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
HOSTS="$( { [ -n "$MAIL_HOSTNAME" ] && echo "$MAIL_HOSTNAME"; [ -f "$STATE_DIR/hosts.txt" ] && head -n 500 "$STATE_DIR/hosts.txt"; } \
          | tr -d '\r' | grep -E "$HOST_RE" | sort -u || true)"

# --------------------------------------------------------------------------- save configuration
SAVE=""
if [ "$PURGE" -eq 0 ]; then
  step "Saving configuration and secrets"
  SAVE="/root/mailsomadhan-saved-$(date +%Y%m%d-%H%M%S).tar.gz"
  paths=()
  for p in "$ETC_DIR" "$STATE_DIR" "$STATUS_DIR" "$DKIM_DIR"; do [ -e "$p" ] && paths+=("${p#/}"); done
  if [ "${#paths[@]}" -gt 0 ]; then
    (umask 077; tar -czf "$SAVE" -C / "${paths[@]}") && info "Saved to $SAVE (keep it private: it holds passwords and keys)" \
      || fail "could not save the configuration; nothing was removed"
  fi
fi

# --------------------------------------------------------------------------- services
step "Stopping MailSomadhan services"
UNITS=(mailsomadhan-api mailsomadhan-web mailsomadhan-collector mailsomadhan-campaigns
       mailsomadhan-backup.timer mailsomadhan-backup mailsomadhan-update mailsomadhan-tls
       mailsomadhan-update-check.timer mailsomadhan-update-check)
for u in "${UNITS[@]}"; do
  systemctl disable -q --now "$u" 2>/dev/null || systemctl stop "$u" 2>/dev/null || true
done
for u in api web collector campaigns backup update-check; do rm -f "/etc/systemd/system/mailsomadhan-$u.service"; done
rm -f /etc/systemd/system/mailsomadhan-backup.timer /etc/systemd/system/mailsomadhan-update-check.timer
systemctl daemon-reload
systemctl reset-failed 'mailsomadhan-*' 2>/dev/null || true

# --------------------------------------------------------------------------- nginx
step "Removing the web panel from nginx"
rm -f /etc/nginx/conf.d/mailsomadhan.conf /etc/nginx/snippets/mailsomadhan-app.conf
rm -rf /var/www/mailsomadhan-acme
if command -v nginx >/dev/null; then
  if nginx -t >/dev/null 2>&1; then
    systemctl reload nginx 2>/dev/null || true
  else
    warn "nginx configuration test fails now; check 'nginx -t' (other sites were not touched)"
  fi
fi

# --------------------------------------------------------------------------- certificates
step "Removing certificates"
rm -f /etc/letsencrypt/renewal-hooks/deploy/mailsomadhan
if command -v certbot >/dev/null; then
  for h in $HOSTS; do
    if [ -d "/etc/letsencrypt/live/$h" ]; then
      certbot delete --non-interactive --cert-name "$h" >/dev/null 2>&1 && info "Let's Encrypt certificate for $h removed" \
        || warn "could not remove the certificate for $h (certbot delete --cert-name $h)"
    fi
  done
fi

# --------------------------------------------------------------------------- fail2ban
rm -f /etc/fail2ban/filter.d/mailsomadhan-panel.conf /etc/fail2ban/jail.d/mailsomadhan.local
systemctl is-active -q fail2ban 2>/dev/null && { systemctl restart fail2ban 2>/dev/null || warn "fail2ban did not restart"; }

# --------------------------------------------------------------------------- mail server
step "Removing the mail server configuration"
for s in postfix dovecot rspamd; do systemctl disable -q --now "$s" 2>/dev/null || true; done

if [ "$REMOVE_PACKAGES" -eq 1 ]; then
  # Rspamd's purge may delete /var/lib/rspamd; the DKIM keys are in the saved archive (or purged anyway).
  export DEBIAN_FRONTEND=noninteractive
  apt-get purge -y -qq postfix postfix-pgsql dovecot-core dovecot-imapd dovecot-lmtpd dovecot-pgsql \
    dovecot-sieve rspamd >/dev/null 2>&1 || warn "some mail packages could not be removed"
  apt-get autoremove -y -qq >/dev/null 2>&1 || true
  rm -rf /etc/postfix/pgsql
  info "Postfix, Dovecot and Rspamd removed"
else
  # Postfix: drop the listeners and every setting that points at MailSomadhan files.
  if command -v postconf >/dev/null; then
    postconf -MX 587/inet 465/inet 127.0.0.1:10025/inet 2>/dev/null || true
    postconf -X virtual_mailbox_domains virtual_mailbox_maps virtual_alias_maps virtual_transport \
      smtpd_sender_login_maps sender_dependent_relayhost_maps smtp_sender_dependent_authentication \
      smtp_sasl_auth_enable smtp_sasl_password_maps smtpd_sasl_type smtpd_sasl_path \
      smtpd_tls_chain_files tls_server_sni_maps header_checks smtpd_milters non_smtpd_milters \
      milter_protocol milter_default_action milter_mail_macros 2>/dev/null || true
  fi
  rm -rf /etc/postfix/pgsql
  rm -f /etc/postfix/mailsomadhan_sni /etc/postfix/mailsomadhan_sni.db /etc/postfix/mailsomadhan_header_checks

  # Dovecot: put the distribution's configuration back.
  if [ -f /etc/dovecot/dovecot.conf.mailsomadhan-orig ]; then
    mv -f /etc/dovecot/dovecot.conf.mailsomadhan-orig /etc/dovecot/dovecot.conf
  fi
  rm -f /etc/dovecot/mailsomadhan-sql.conf.ext /etc/dovecot/mailsomadhan-master /etc/dovecot/mailsomadhan-sni.conf
  rm -f /etc/dovecot/sieve/spam-to-junk.sieve /etc/dovecot/sieve/spam-to-junk.svbin
  rmdir /etc/dovecot/sieve 2>/dev/null || true

  # Rspamd: our local overrides only.
  for f in worker-controller.inc worker-proxy.inc milter_headers.conf dkim_signing.conf multimap.conf \
           redis.conf classifier-bayes.conf actions.conf; do
    rm -f "/etc/rspamd/local.d/$f"
  done
  info "Postfix, Dovecot and Rspamd are stopped and disabled (their packages are still installed)"
fi

# --------------------------------------------------------------------------- data
if [ "$PURGE" -eq 1 ]; then
  step "Deleting mail, database and keys"
  if command -v psql >/dev/null && systemctl is-active -q postgresql 2>/dev/null; then
    (cd /tmp && sudo -u postgres psql -q -v ON_ERROR_STOP=0 <<'SQL') >/dev/null 2>&1 || warn "could not drop the database"
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'mailsomadhan' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS mailsomadhan;
DROP ROLE IF EXISTS mailsomadhan_mta;
DROP ROLE IF EXISTS mailsomadhan;
SQL
    info "Database 'mailsomadhan' dropped"
  else
    warn "PostgreSQL is not running: database 'mailsomadhan' was not dropped"
  fi
  rm -rf "$MAIL_DIR" "$DKIM_DIR"
  rm -f /var/log/mailsomadhan-*.log
  info "Mail in $MAIL_DIR and DKIM keys deleted"
fi

# --------------------------------------------------------------------------- files, users, firewall
step "Removing MailSomadhan files"
rm -f /usr/local/bin/mailsomadhan /usr/local/sbin/mailsomadhan-helper /usr/local/sbin/mailsomadhan-cloudflare /etc/sudoers.d/mailsomadhan
rm -rf "$APP_DIR" "$ETC_DIR" "$STATE_DIR" "$STATUS_DIR" /var/cache/mailsomadhan
rm -f /root/mailsomadhan-credentials.txt /var/log/mailsomadhan-install.log
rm -f /var/log/mailsomadhan-update.log /var/log/mailsomadhan-backup.log /var/log/mailsomadhan-tls.log

pkill -u mailsomadhan 2>/dev/null || true
if id mailsomadhan >/dev/null 2>&1; then userdel mailsomadhan 2>/dev/null || warn "could not remove user 'mailsomadhan'"; fi
getent group mailsomadhan >/dev/null && { groupdel mailsomadhan 2>/dev/null || true; }
if [ "$PURGE" -eq 1 ] && id vmail >/dev/null 2>&1; then
  userdel vmail 2>/dev/null || true
  getent group vmail >/dev/null && { groupdel vmail 2>/dev/null || true; }
fi

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  # SSH and port 80 stay open: other services on this server may rely on them.
  ports="25 465 587 993 $WEB_PORT"
  [ "$HTTP_PORT" != 80 ] && ports="$ports $HTTP_PORT"
  for p in $ports; do [ -n "$p" ] && ufw delete allow "$p/tcp" >/dev/null 2>&1 || true; done
  info "Firewall: closed ports $ports"
fi

# --------------------------------------------------------------------------- done
echo
echo "${c_green}${c_bold}MailSomadhan has been uninstalled.${c_off}"
if [ "$PURGE" -eq 0 ]; then
  echo
  echo "  Still on this server:"
  echo "    - mail:          $MAIL_DIR"
  echo "    - database:      'mailsomadhan' in PostgreSQL"
  echo "    - DKIM keys:     $DKIM_DIR"
  [ -n "$SAVE" ] && echo "    - saved config:  $SAVE"
  echo "  A new installation does not reuse them automatically; delete them when no longer needed."
fi
echo
echo "  Not removed (other software may use them): PostgreSQL, nginx, Redis, Node.js, certbot, ufw, fail2ban."
echo "  Log of this run: $LOG_FILE"

#!/usr/bin/env bash
#
# MailSomadhan installer. Safe to re-run: it keeps existing secrets, data and settings
# (this is also what `mailsomadhan update` executes).
#
set -euo pipefail

APP_DIR=/opt/mailsomadhan
SRC_DIR=$APP_DIR/src
ETC_DIR=/etc/mailsomadhan
STATE_DIR=/var/lib/mailsomadhan
INSTALL_CONF=$ETC_DIR/install.conf     # secrets generated at first install (root only)
HELPER_CONF=$ETC_DIR/helper.conf       # non-secret values read by the root helper
ENV_FILE=$ETC_DIR/mailsomadhan.env          # backend environment
TLS_DIR=$ETC_DIR/tls
MAIL_DIR=/var/vmail
DKIM_DIR=/var/lib/rspamd/dkim
ACME_ROOT=/var/www/mailsomadhan-acme
API_PORT=18080
WEB_INTERNAL_PORT=13000
IMAP_INTERNAL_PORT=10143   # loopback-only IMAP used by the webmail
CRED_FILE=/root/mailsomadhan-credentials.txt
LOG_FILE=/var/log/mailsomadhan-install.log

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

c_bold=$'\033[1m'; c_green=$'\033[32m'; c_yellow=$'\033[33m'; c_red=$'\033[31m'; c_off=$'\033[0m'
step() { echo; echo "${c_bold}==> $*${c_off}"; }
info() { echo "    $*"; }
warn() { echo "${c_yellow}    warning: $*${c_off}"; }
fail() { echo "${c_red}error: $*${c_off}" >&2; exit 1; }
trap 'echo "${c_red}Installation failed (line $LINENO). Full log: $LOG_FILE${c_off}" >&2' ERR

[ "$(id -u)" -eq 0 ] || fail "run as root"
[ -f "$SRC_DIR/installer/setup.sh" ] || fail "source tree not found in $SRC_DIR (run install.sh)"

mkdir -p "$ETC_DIR" "$STATE_DIR"
touch "$LOG_FILE" && chmod 600 "$LOG_FILE"   # the log contains the generated admin password
exec > >(tee -a "$LOG_FILE") 2>&1

# --------------------------------------------------------------------------- checks
. /etc/os-release
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04) ;;
  *) fail "Unsupported system: ${PRETTY_NAME:-unknown}. MailSomadhan supports Ubuntu 22.04 and 24.04." ;;
esac

FIRST_INSTALL=1
if [ -f "$INSTALL_CONF" ]; then
  FIRST_INSTALL=0
  # shellcheck disable=SC1090
  . "$INSTALL_CONF"
fi

# --------------------------------------------------------------------------- questions
HOST_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'
RESERVED_PORTS=" 22 25 80 110 143 465 587 993 995 4190 5432 6379 11332 11333 11334 $API_PORT $WEB_INTERNAL_PORT $IMAP_INTERNAL_PORT "

HAVE_TTY=0
if (exec </dev/tty) 2>/dev/null; then HAVE_TTY=1; fi

ask() { # ask <prompt> <default>  -> prints the answer; falls back to the default without a terminal
  local reply=""
  if [ "$HAVE_TTY" -eq 1 ]; then
    read -r -p "$1 [$2]: " reply </dev/tty >/dev/tty 2>&1 || reply=""
  fi
  echo "${reply:-$2}"
}

valid_port() {
  [[ "$1" =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ] && [[ "$RESERVED_PORTS" != *" $1 "* ]]
}

if [ "$FIRST_INSTALL" -eq 1 ]; then
  echo
  echo "${c_bold}MailSomadhan installer${c_off}"
  echo "Two quick questions; everything else is configured later in the web panel."
  echo

  MAIL_HOSTNAME="${MAILSOMADHAN_HOSTNAME:-}"
  default_host="$(hostname -f 2>/dev/null || hostname)"
  [[ "$default_host" =~ $HOST_RE ]] || default_host="mail.example.com"
  while :; do
    [ -n "$MAIL_HOSTNAME" ] || MAIL_HOSTNAME="$(ask "Mail server hostname (its DNS A record must point to this server)" "$default_host")"
    MAIL_HOSTNAME="$(echo "$MAIL_HOSTNAME" | tr 'A-Z' 'a-z')"
    if [[ "$MAIL_HOSTNAME" =~ $HOST_RE ]]; then break; fi
    echo "  '$MAIL_HOSTNAME' is not a valid fully qualified hostname (example: mail.example.com)"
    [ "$HAVE_TTY" -eq 1 ] || fail "invalid hostname; set MAILSOMADHAN_HOSTNAME=mail.example.com"
    MAIL_HOSTNAME=""
  done

  WEB_PORT="${MAILSOMADHAN_PORT:-}"
  while :; do
    [ -n "$WEB_PORT" ] || WEB_PORT="$(ask "HTTPS port for the web panel" "8443")"
    if valid_port "$WEB_PORT"; then
      if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${WEB_PORT}\$"; then
        echo "  Port $WEB_PORT is already in use by another program."
      else
        break
      fi
    else
      echo "  '$WEB_PORT' cannot be used (reserved for mail services or not a valid port)."
    fi
    [ "$HAVE_TTY" -eq 1 ] || fail "port $WEB_PORT is not usable; set MAILSOMADHAN_PORT to a free port"
    WEB_PORT=""
  done

  HTTP_PORT="${MAILSOMADHAN_HTTP_PORT:-80}"   # plain HTTP: Let's Encrypt validation and redirect to the panel
  [[ "$HTTP_PORT" =~ ^[0-9]{1,5}$ ]] || fail "invalid MAILSOMADHAN_HTTP_PORT"

  rand() { openssl rand -hex "$1"; }
  command -v openssl >/dev/null || { apt-get update -qq; apt-get install -y -qq openssl >/dev/null; }
  DB_PASS="$(rand 24)"
  MTA_DB_PASS="$(rand 24)"
  MASTER_PASS="$(rand 24)"
  SECRET_KEY="$(rand 48)"
  ADMIN_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"

  umask 077
  cat > "$INSTALL_CONF" <<EOF
MAIL_HOSTNAME='$MAIL_HOSTNAME'
WEB_PORT='$WEB_PORT'
HTTP_PORT='$HTTP_PORT'
DB_PASS='$DB_PASS'
MTA_DB_PASS='$MTA_DB_PASS'
MASTER_PASS='$MASTER_PASS'
SECRET_KEY='$SECRET_KEY'
EOF
  umask 022
else
  info "Existing installation found for $MAIL_HOSTNAME (panel port $WEB_PORT): updating in place."
  ADMIN_PASS=""
fi

HTTP_PORT="${HTTP_PORT:-80}"
# Where updates come from: keep what an earlier install recorded unless overridden.
OLD_REPO_URL=""; OLD_BRANCH=""
if [ -f "$HELPER_CONF" ]; then
  OLD_REPO_URL="$(. "$HELPER_CONF" >/dev/null 2>&1; echo "${REPO_URL:-}")"
  OLD_BRANCH="$(. "$HELPER_CONF" >/dev/null 2>&1; echo "${BRANCH:-}")"
fi
REPO_URL="${MAILSOMADHAN_REPO:-${OLD_REPO_URL:-https://github.com/mdatiqmazumder/MailSomadhan.git}}"
BRANCH="${MAILSOMADHAN_BRANCH:-${OLD_BRANCH:-main}}"
[[ "$REPO_URL" =~ ^(https://|file:///)[A-Za-z0-9._~/-]+$ ]] || fail "invalid repository URL: $REPO_URL"
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]{1,100}$ ]] || fail "invalid branch: $BRANCH"

cat > "$HELPER_CONF" <<EOF
MAIL_HOSTNAME='$MAIL_HOSTNAME'
WEB_PORT='$WEB_PORT'
HTTP_PORT='$HTTP_PORT'
REPO_URL='$REPO_URL'
BRANCH='$BRANCH'
EOF
chmod 644 "$HELPER_CONF"

# --------------------------------------------------------------------------- packages
step "Installing system packages (this takes a few minutes)"

# Low-memory servers cannot build the web panel without swap.
mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$mem_mb" -lt 1900 ] && [ "$(swapon --noheadings 2>/dev/null | wc -l)" -eq 0 ] && [ ! -f /swapfile ]; then
  info "Only ${mem_mb} MB RAM: adding a 2 GB swap file"
  if fallocate -l 2G /swapfile 2>/dev/null && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile 2>/dev/null; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  else
    rm -f /swapfile
    warn "could not create swap; the build may fail on this machine"
  fi
fi

apt-get update -qq
echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections
echo "postfix postfix/mailname string $MAIL_HOSTNAME" | debconf-set-selections

if ! apt-cache show rspamd >/dev/null 2>&1; then
  apt-get install -y -qq software-properties-common >/dev/null
  add-apt-repository -y universe >/dev/null
  apt-get update -qq
fi

# Keep freshly installed daemons from starting with their stock configuration (a busy port
# would make the package installation itself fail); they are configured and started below.
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod 755 /usr/sbin/policy-rc.d
trap 'rm -f /usr/sbin/policy-rc.d' EXIT

apt-get install -y -qq --no-install-recommends \
  ca-certificates curl gnupg git openssl sudo rsync iproute2 \
  postfix postfix-pgsql \
  dovecot-core dovecot-imapd dovecot-lmtpd dovecot-pgsql dovecot-sieve \
  rspamd redis-server postgresql nginx certbot ufw fail2ban rclone \
  python3 python3-venv python3-pip >/dev/null

rm -f /usr/sbin/policy-rc.d

node_major=0
command -v node >/dev/null && node_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
if [ "$node_major" -lt 20 ]; then
  info "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

# --------------------------------------------------------------------------- users & directories
step "Creating system users and directories"

getent group vmail >/dev/null || groupadd -g 5000 vmail 2>/dev/null || groupadd vmail
id vmail >/dev/null 2>&1 || useradd -u 5000 -g vmail -d "$MAIL_DIR" -s /usr/sbin/nologin vmail 2>/dev/null \
  || useradd -g vmail -d "$MAIL_DIR" -s /usr/sbin/nologin vmail
VMAIL_UID="$(id -u vmail)"
id mailsomadhan >/dev/null 2>&1 || useradd --system -d "$APP_DIR" -s /usr/sbin/nologin mailsomadhan
usermod -aG _rspamd mailsomadhan

install -d -o vmail -g vmail -m 770 "$MAIL_DIR"
install -d -o mailsomadhan -g mailsomadhan -m 755 "$STATE_DIR"
install -d -o _rspamd -g _rspamd -m 2770 "$DKIM_DIR"
install -d -m 755 "$TLS_DIR" "$ACME_ROOT"
chmod 755 "$ETC_DIR"   # certificates below are public; secrets have their own file modes
chmod 600 "$INSTALL_CONF"

# --------------------------------------------------------------------------- TLS (self-signed until Let's Encrypt succeeds)
PRIMARY_TLS="$TLS_DIR/$MAIL_HOSTNAME"
if [ ! -f "$PRIMARY_TLS/fullchain.pem" ]; then
  step "Generating a temporary self-signed certificate"
  install -d -m 755 "$PRIMARY_TLS"
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -subj "/CN=$MAIL_HOSTNAME" -addext "subjectAltName=DNS:$MAIL_HOSTNAME" \
    -keyout "$PRIMARY_TLS/privkey.pem" -out "$PRIMARY_TLS/fullchain.pem" 2>/dev/null
  chmod 600 "$PRIMARY_TLS/privkey.pem"
  chmod 644 "$PRIMARY_TLS/fullchain.pem"
fi

# --------------------------------------------------------------------------- database
step "Configuring PostgreSQL"
systemctl enable --now postgresql >/dev/null 2>&1 || true
for _ in $(seq 1 30); do
  (cd /tmp && sudo -u postgres psql -Atc 'select 1' >/dev/null 2>&1) && break
  sleep 1
done

pg() { (cd /tmp && sudo -u postgres psql -v ON_ERROR_STOP=1 -q "$@"); }

pg <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mailsomadhan') THEN
    CREATE ROLE mailsomadhan LOGIN PASSWORD '$DB_PASS';
  ELSE
    ALTER ROLE mailsomadhan LOGIN PASSWORD '$DB_PASS';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mailsomadhan_mta') THEN
    CREATE ROLE mailsomadhan_mta LOGIN PASSWORD '$MTA_DB_PASS';
  ELSE
    ALTER ROLE mailsomadhan_mta LOGIN PASSWORD '$MTA_DB_PASS';
  END IF;
END
\$\$;
SQL
if ! pg -Atc "SELECT 1 FROM pg_database WHERE datname = 'mailsomadhan'" | grep -q 1; then
  (cd /tmp && sudo -u postgres createdb -O mailsomadhan -E UTF8 mailsomadhan)
fi

# --------------------------------------------------------------------------- backend
step "Installing the API (Python)"
[ -x "$APP_DIR/venv/bin/python" ] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install -q --upgrade pip wheel
"$APP_DIR/venv/bin/pip" install -q -r "$SRC_DIR/backend/requirements.txt"

cat > "$ENV_FILE" <<EOF
MAILSOMADHAN_DATABASE_URL=postgresql+psycopg://mailsomadhan:$DB_PASS@127.0.0.1:5432/mailsomadhan
MAILSOMADHAN_SECRET_KEY=$SECRET_KEY
MAILSOMADHAN_COOKIE_SECURE=true
MAILSOMADHAN_PRIMARY_HOSTNAME=$MAIL_HOSTNAME
MAILSOMADHAN_WEB_PORT=$WEB_PORT
MAILSOMADHAN_IMAP_HOST=127.0.0.1
MAILSOMADHAN_IMAP_PORT=$IMAP_INTERNAL_PORT
MAILSOMADHAN_IMAP_MASTER_USER=msmaster
MAILSOMADHAN_IMAP_MASTER_PASSWORD=$MASTER_PASS
MAILSOMADHAN_SMTP_HOST=127.0.0.1
MAILSOMADHAN_SMTP_PORT=10025
MAILSOMADHAN_DKIM_DIR=$DKIM_DIR
MAILSOMADHAN_TLS_DIR=$TLS_DIR
MAILSOMADHAN_STATE_DIR=$STATE_DIR
MAILSOMADHAN_STATUS_DIR=/var/lib/mailsomadhan-status
MAILSOMADHAN_MAIL_DIR=$MAIL_DIR
MAILSOMADHAN_FEATURES_FILE=$ETC_DIR/features.conf
EOF
chown root:mailsomadhan "$ENV_FILE"
chmod 640 "$ENV_FILE"

cli() { (cd "$SRC_DIR/backend" && sudo -u mailsomadhan env MAILSOMADHAN_ENV_FILE="$ENV_FILE" "$APP_DIR/venv/bin/python" -m app.cli "$@"); }
if [ "$FIRST_INSTALL" -eq 1 ]; then
  cli init --hostname "$MAIL_HOSTNAME" --admin-password "$ADMIN_PASS"
else
  cli init --hostname "$MAIL_HOSTNAME"
fi

# The mail daemons get a read-only database role limited to the tables they need.
pg -d mailsomadhan <<SQL
GRANT CONNECT ON DATABASE mailsomadhan TO mailsomadhan_mta;
GRANT USAGE ON SCHEMA public TO mailsomadhan_mta;
GRANT SELECT ON domains, mailboxes, aliases, relays TO mailsomadhan_mta;
SQL

# --------------------------------------------------------------------------- frontend
step "Building the web panel (Next.js)"
(
  cd "$SRC_DIR/frontend"
  npm ci --no-audit --no-fund --loglevel=error
  NEXT_TELEMETRY_DISABLED=1 npm run build >/dev/null
  rm -rf .next/standalone/.next/static .next/standalone/public
  cp -r .next/static .next/standalone/.next/static
  if [ -d public ]; then cp -r public .next/standalone/public; fi
)

# --------------------------------------------------------------------------- Postfix
step "Configuring Postfix (SMTP)"
install -d -o root -g postfix -m 750 /etc/postfix/pgsql

pgsql_map() { # pgsql_map <name> <query>
  cat > "/etc/postfix/pgsql/$1.cf" <<EOF
hosts = 127.0.0.1
user = mailsomadhan_mta
password = $MTA_DB_PASS
dbname = mailsomadhan
query = $2
EOF
  chown root:postfix "/etc/postfix/pgsql/$1.cf"
  chmod 640 "/etc/postfix/pgsql/$1.cf"
}

pgsql_map domains "SELECT 1 FROM domains WHERE name = '%s' AND active"
pgsql_map mailboxes "SELECT 1 FROM mailboxes m JOIN domains d ON d.id = m.domain_id WHERE m.email = '%s' AND m.active AND d.active"
pgsql_map aliases "SELECT email FROM mailboxes WHERE email = '%s' AND active UNION SELECT destination FROM aliases WHERE source = '%s' AND active"
pgsql_map sender-login "SELECT email FROM mailboxes WHERE email = '%s' AND active UNION SELECT destination FROM aliases WHERE source = '%s' AND active"
# Outbound relay: a domain's own relay wins, otherwise the default relay (if any), otherwise direct delivery.
pgsql_map relay-domain "SELECT '[' || r.host || ']:' || r.port FROM relays r JOIN domains d ON d.relay_id = r.id WHERE d.name = '%d' AND r.active LIMIT 1"
pgsql_map relay-default "SELECT '[' || host || ']:' || port FROM relays WHERE is_default AND active AND '%s' <> '' LIMIT 1"
pgsql_map relay-auth-domain "SELECT r.username || ':' || r.password FROM relays r JOIN domains d ON d.relay_id = r.id WHERE d.name = '%d' AND r.active AND r.username <> '' LIMIT 1"
pgsql_map relay-auth-host "SELECT username || ':' || password FROM relays WHERE '[' || host || ']:' || port = '%s' AND active AND username <> '' ORDER BY is_default DESC LIMIT 1"

M=proxy:pgsql:/etc/postfix/pgsql
postconf -X smtpd_tls_cert_file smtpd_tls_key_file 2>/dev/null || true
postconf -e \
  "compatibility_level = 3.6" \
  "myhostname = $MAIL_HOSTNAME" \
  'myorigin = $myhostname' \
  'mydestination = localhost' \
  'mynetworks = 127.0.0.0/8 [::1]/128' \
  'inet_interfaces = all' \
  'inet_protocols = all' \
  'biff = no' \
  'append_dot_mydomain = no' \
  'recipient_delimiter = +' \
  'mailbox_size_limit = 0' \
  'smtpd_banner = $myhostname ESMTP' \
  'disable_vrfy_command = yes' \
  'smtpd_helo_required = yes' \
  'strict_rfc821_envelopes = yes' \
  "virtual_mailbox_domains = $M/domains.cf" \
  "virtual_mailbox_maps = $M/mailboxes.cf" \
  "virtual_alias_maps = $M/aliases.cf" \
  'virtual_transport = lmtp:unix:private/dovecot-lmtp' \
  "smtpd_sender_login_maps = $M/sender-login.cf" \
  "sender_dependent_relayhost_maps = $M/relay-domain.cf, $M/relay-default.cf" \
  'smtp_sender_dependent_authentication = yes' \
  'smtp_sasl_auth_enable = yes' \
  "smtp_sasl_password_maps = $M/relay-auth-domain.cf, $M/relay-auth-host.cf" \
  'smtp_sasl_security_options = noanonymous, noplaintext' \
  'smtp_sasl_tls_security_options = noanonymous' \
  'smtpd_sasl_type = dovecot' \
  'smtpd_sasl_path = private/auth' \
  'smtpd_sasl_auth_enable = no' \
  'smtpd_sasl_security_options = noanonymous' \
  'smtpd_sasl_authenticated_header = no' \
  "smtpd_tls_chain_files = $PRIMARY_TLS/privkey.pem, $PRIMARY_TLS/fullchain.pem" \
  'tls_server_sni_maps = hash:/etc/postfix/mailsomadhan_sni' \
  'smtpd_tls_security_level = may' \
  'smtpd_tls_auth_only = yes' \
  'smtpd_tls_protocols = >=TLSv1.2' \
  'smtpd_tls_mandatory_protocols = >=TLSv1.2' \
  'smtpd_tls_mandatory_ciphers = high' \
  'smtpd_tls_loglevel = 1' \
  'smtpd_tls_received_header = yes' \
  'smtpd_tls_session_cache_database = btree:${data_directory}/smtpd_scache' \
  'tls_preempt_cipherlist = yes' \
  'smtp_tls_security_level = may' \
  'smtp_tls_protocols = >=TLSv1.2' \
  'smtp_tls_CApath = /etc/ssl/certs' \
  'smtp_tls_loglevel = 1' \
  'smtp_tls_session_cache_database = btree:${data_directory}/smtp_scache' \
  'smtpd_helo_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_invalid_helo_hostname, reject_non_fqdn_helo_hostname' \
  'smtpd_sender_restrictions = permit_mynetworks, reject_non_fqdn_sender, reject_unknown_sender_domain' \
  'smtpd_relay_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_unauth_destination' \
  'smtpd_recipient_restrictions = permit_mynetworks, permit_sasl_authenticated, reject_non_fqdn_recipient, reject_unauth_destination, reject_unknown_recipient_domain' \
  'smtpd_data_restrictions = reject_unauth_pipelining' \
  'smtpd_client_connection_count_limit = 20' \
  'smtpd_client_connection_rate_limit = 60' \
  'smtpd_error_sleep_time = 5s' \
  'smtpd_soft_error_limit = 5' \
  'smtpd_hard_error_limit = 10' \
  'smtpd_milters = inet:127.0.0.1:11332' \
  'non_smtpd_milters = inet:127.0.0.1:11332' \
  'milter_protocol = 6' \
  'milter_default_action = accept' \
  'milter_mail_macros = i {mail_addr} {client_addr} {client_name} {auth_authen}'

if [ "$FIRST_INSTALL" -eq 1 ]; then
  postconf -e 'message_size_limit = 38797312'   # 25 MB of attachments after base64 encoding
fi

# Authenticated submission for mail clients: 587 (STARTTLS) and 465 (implicit TLS).
SUBMISSION_OPTS=(
  smtpd_sasl_auth_enable=yes
  smtpd_tls_auth_only=yes
  smtpd_reject_unlisted_recipient=no
  smtpd_client_restrictions=permit_sasl_authenticated,reject
  smtpd_helo_restrictions=
  smtpd_sender_restrictions=reject_sender_login_mismatch
  smtpd_relay_restrictions=permit_sasl_authenticated,reject
  smtpd_recipient_restrictions=reject_non_fqdn_recipient,reject_unknown_recipient_domain,permit_sasl_authenticated,reject
  milter_macro_daemon_name=ORIGINATING
  smtpd_milters=inet:127.0.0.1:11332
)
postconf -M "587/inet=587 inet n - y - - smtpd"
# Loopback listener for the webmail: always passes Rspamd (DKIM signing), even when the
# spam filter for incoming mail on port 25 is switched off.
postconf -M "127.0.0.1:10025/inet=127.0.0.1:10025 inet n - y - - smtpd"
for opt in syslog_name=postfix/webmail smtpd_milters=inet:127.0.0.1:11332            smtpd_client_restrictions=permit_mynetworks,reject            smtpd_relay_restrictions=permit_mynetworks,reject            smtpd_recipient_restrictions=permit_mynetworks,reject            smtpd_helo_restrictions= smtpd_sender_restrictions= milter_macro_daemon_name=ORIGINATING; do
  postconf -P "127.0.0.1:10025/inet/$opt"
done
postconf -M "465/inet=465 inet n - y - - smtpd"
for opt in "${SUBMISSION_OPTS[@]}"; do
  postconf -P "587/inet/$opt" "465/inet/$opt"
done
postconf -P "587/inet/syslog_name=postfix/submission" "587/inet/smtpd_tls_security_level=encrypt"
postconf -P "465/inet/syslog_name=postfix/smtps" "465/inet/smtpd_tls_wrappermode=yes"

touch /etc/postfix/mailsomadhan_sni
postmap -F hash:/etc/postfix/mailsomadhan_sni

# --------------------------------------------------------------------------- Dovecot
step "Configuring Dovecot (IMAP and mail storage)"
[ -f /etc/dovecot/dovecot.conf.mailsomadhan-orig ] || cp /etc/dovecot/dovecot.conf /etc/dovecot/dovecot.conf.mailsomadhan-orig

cat > /etc/dovecot/dovecot.conf <<EOF
# Generated by the MailSomadhan installer. Local changes are overwritten on update.
protocols = imap lmtp

mail_home = $MAIL_DIR/%d/%n
mail_location = maildir:~/Maildir
mail_uid = vmail
mail_gid = vmail
first_valid_uid = $VMAIL_UID
last_valid_uid = $VMAIL_UID
mail_plugins = quota
recipient_delimiter = +

auth_mechanisms = plain login
auth_username_format = %Lu
disable_plaintext_auth = yes
auth_master_user_separator = *
auth_failure_delay = 3 secs

# The webmail logs in on behalf of users with this master account; localhost only.
passdb {
  driver = passwd-file
  master = yes
  args = /etc/dovecot/mailsomadhan-master
  override_fields = allow_nets=127.0.0.1/32,::1/128
  pass = yes
}
passdb {
  driver = sql
  args = /etc/dovecot/mailsomadhan-sql.conf.ext
}
userdb {
  driver = sql
  args = /etc/dovecot/mailsomadhan-sql.conf.ext
}

ssl = required
ssl_cert = <$PRIMARY_TLS/fullchain.pem
ssl_key = <$PRIMARY_TLS/privkey.pem
ssl_min_protocol = TLSv1.2
ssl_prefer_server_ciphers = yes
!include_try /etc/dovecot/mailsomadhan-sni.conf

service imap-login {
  inet_listener imap {
    address = 127.0.0.1
    port = $IMAP_INTERNAL_PORT
  }
  inet_listener imaps {
    port = 993
    ssl = yes
  }
}
service lmtp {
  unix_listener /var/spool/postfix/private/dovecot-lmtp {
    mode = 0600
    user = postfix
    group = postfix
  }
}
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0660
    user = postfix
    group = postfix
  }
  unix_listener auth-userdb {
    mode = 0600
    user = vmail
    group = vmail
  }
}

protocol imap {
  mail_plugins = \$mail_plugins imap_quota
  mail_max_userip_connections = 30
}
protocol lmtp {
  mail_plugins = \$mail_plugins sieve
  postmaster_address = postmaster@$MAIL_HOSTNAME
}

plugin {
  quota = count:User quota
  quota_vsizes = yes
  quota_grace = 10%%
  sieve = file:~/sieve;active=~/.dovecot.sieve
  sieve_before = /etc/dovecot/sieve/spam-to-junk.sieve
}

namespace inbox {
  inbox = yes
  separator = /
  mailbox Drafts {
    special_use = \\Drafts
    auto = subscribe
  }
  mailbox Sent {
    special_use = \\Sent
    auto = subscribe
  }
  mailbox Junk {
    special_use = \\Junk
    auto = subscribe
    autoexpunge = 30d
  }
  mailbox Trash {
    special_use = \\Trash
    auto = subscribe
    autoexpunge = 30d
  }
  mailbox Archive {
    special_use = \\Archive
    auto = subscribe
  }
}
EOF

cat > /etc/dovecot/mailsomadhan-sql.conf.ext <<EOF
driver = pgsql
connect = host=127.0.0.1 dbname=mailsomadhan user=mailsomadhan_mta password=$MTA_DB_PASS
default_pass_scheme = BLF-CRYPT
password_query = SELECT m.password_hash AS password FROM mailboxes m JOIN domains d ON d.id = m.domain_id WHERE m.email = '%u' AND m.active AND d.active
user_query = SELECT '$MAIL_DIR/%d/%n' AS home, '*:storage=' || m.quota_mb || 'M' AS quota_rule FROM mailboxes m JOIN domains d ON d.id = m.domain_id WHERE m.email = '%u' AND m.active AND d.active
iterate_query = SELECT email AS username FROM mailboxes
EOF
chown root:dovecot /etc/dovecot/mailsomadhan-sql.conf.ext
chmod 640 /etc/dovecot/mailsomadhan-sql.conf.ext

echo "msmaster:$(doveadm pw -s SHA512-CRYPT -p "$MASTER_PASS")" > /etc/dovecot/mailsomadhan-master
chown root:dovecot /etc/dovecot/mailsomadhan-master
chmod 640 /etc/dovecot/mailsomadhan-master
[ -f /etc/dovecot/mailsomadhan-sni.conf ] || echo "# Generated by mailsomadhan-helper" > /etc/dovecot/mailsomadhan-sni.conf

install -d -m 755 /etc/dovecot/sieve
cat > /etc/dovecot/sieve/spam-to-junk.sieve <<'EOF'
require ["fileinto", "mailbox"];
if anyof (header :contains "X-Spam" "Yes", header :contains "X-Spam-Status" "Yes,") {
  fileinto :create "Junk";
  stop;
}
EOF
sievec /etc/dovecot/sieve/spam-to-junk.sieve

# --------------------------------------------------------------------------- Rspamd
step "Configuring Rspamd (spam filter and DKIM signing)"
install -d /etc/rspamd/local.d
# Rspamd's web controller listens on localhost only; replace the distribution's default password.
if [ -z "${RSPAMD_PASS:-}" ]; then
  RSPAMD_PASS="$(openssl rand -hex 24)"
  echo "RSPAMD_PASS='$RSPAMD_PASS'" >> "$INSTALL_CONF"
fi
RSPAMD_HASH="$(rspamadm pw -p "$RSPAMD_PASS" 2>/dev/null | tail -n1)"
cat > /etc/rspamd/local.d/worker-controller.inc <<EOF
bind_socket = "127.0.0.1:11334";
password = "$RSPAMD_HASH";
enable_password = "$RSPAMD_HASH";
# No password-free access for local processes either (the default trusts 127.0.0.1).
secure_ip = [];
EOF
chmod 640 /etc/rspamd/local.d/worker-controller.inc
chgrp _rspamd /etc/rspamd/local.d/worker-controller.inc

cat > /etc/rspamd/local.d/worker-proxy.inc <<'EOF'
bind_socket = "127.0.0.1:11332";
milter = yes;
timeout = 120s;
upstream "local" {
  default = yes;
  self_scan = yes;
}
EOF
# redis.conf, classifier-bayes.conf and actions.conf are written by
# "mailsomadhan-helper apply-features" (spam filter / Redis switches in the panel).
cat > /etc/rspamd/local.d/milter_headers.conf <<'EOF'
use = ["x-spamd-bar", "x-spam-level", "x-spam-status", "authentication-results"];
authenticated_headers = ["authentication-results"];
EOF
cat > /etc/rspamd/local.d/dkim_signing.conf <<EOF
# Keys and the selector map are managed by the MailSomadhan panel.
enabled = true;
path = "$DKIM_DIR/\$domain.\$selector.key";
selector_map = "$DKIM_DIR/selectors.map";
selector = "ms";
sign_local = true;
sign_authenticated = true;
allow_username_mismatch = true;
use_domain = "header";
use_esld = false;
try_fallback = false;
EOF
[ -f "$DKIM_DIR/selectors.map" ] || install -o mailsomadhan -g _rspamd -m 640 /dev/null "$DKIM_DIR/selectors.map"

# Admin mail filters (Mail filters page). The panel rewrites the map files; Rspamd reloads them.
install -d -o mailsomadhan -g mailsomadhan -m 755 "$STATE_DIR/maps"
for m in block_from block_from_domain allow_from allow_from_domain block_ip block_ext; do
  [ -f "$STATE_DIR/maps/$m.map" ] || install -o mailsomadhan -g mailsomadhan -m 644 /dev/null "$STATE_DIR/maps/$m.map"
done
cat > /etc/rspamd/local.d/multimap.conf <<EOF
# Managed by MailSomadhan. Rules are edited on the Mail filters page.
MS_ALLOW_FROM { type = "from"; filter = "email:addr"; map = "file://$STATE_DIR/maps/allow_from.map"; score = -50.0; description = "Sender allowed by administrator"; }
MS_ALLOW_FROM_DOMAIN { type = "from"; filter = "email:domain"; map = "file://$STATE_DIR/maps/allow_from_domain.map"; score = -50.0; description = "Sender domain allowed by administrator"; }
MS_BLOCK_FROM { type = "from"; filter = "email:addr"; map = "file://$STATE_DIR/maps/block_from.map"; action = "reject"; message = "Sender blocked by the recipient's administrator"; description = "Sender blocked by administrator"; }
MS_BLOCK_FROM_DOMAIN { type = "from"; filter = "email:domain"; map = "file://$STATE_DIR/maps/block_from_domain.map"; action = "reject"; message = "Sender domain blocked by the recipient's administrator"; description = "Sender domain blocked by administrator"; }
MS_BLOCK_HDR_FROM { type = "header"; header = "From"; filter = "email:addr"; map = "file://$STATE_DIR/maps/block_from.map"; action = "reject"; message = "Sender blocked by the recipient's administrator"; description = "Header sender blocked by administrator"; }
MS_BLOCK_HDR_DOMAIN { type = "header"; header = "From"; filter = "email:domain"; map = "file://$STATE_DIR/maps/block_from_domain.map"; action = "reject"; message = "Sender domain blocked by the recipient's administrator"; description = "Header sender domain blocked by administrator"; }
MS_BLOCK_IP { type = "ip"; map = "file://$STATE_DIR/maps/block_ip.map"; action = "reject"; message = "Your server is blocked by the recipient's administrator"; description = "Client IP blocked by administrator"; }
MS_BLOCK_EXT { type = "filename"; filter = "extension"; map = "file://$STATE_DIR/maps/block_ext.map"; action = "reject"; message = "Attachment type not allowed"; description = "Blocked attachment type"; }
EOF

# --------------------------------------------------------------------------- helper, services, nginx
step "Installing services"
install -m 755 "$SRC_DIR/installer/mailsomadhan-helper" /usr/local/sbin/mailsomadhan-helper
install -m 755 "$SRC_DIR/installer/mailsomadhan" /usr/local/bin/mailsomadhan
echo 'mailsomadhan ALL=(root) NOPASSWD: /usr/local/sbin/mailsomadhan-helper' > /etc/sudoers.d/mailsomadhan
chmod 440 /etc/sudoers.d/mailsomadhan
visudo -cf /etc/sudoers.d/mailsomadhan >/dev/null

cat > /etc/systemd/system/mailsomadhan-api.service <<EOF
[Unit]
Description=MailSomadhan API
After=network.target postgresql.service
Wants=postgresql.service

[Service]
User=mailsomadhan
Group=mailsomadhan
WorkingDirectory=$SRC_DIR/backend
Environment=MAILSOMADHAN_ENV_FILE=$ENV_FILE
Environment=PYTHONUNBUFFERED=1
ExecStart=$APP_DIR/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port $API_PORT --workers 2
Restart=always
RestartSec=3
PrivateTmp=yes
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF

# Mail log collector: turns Postfix/Rspamd logs into the analytics tables.
# Only the collector service gets log access (SupplementaryGroups in its unit); the internet-facing
# API runs without it. Older installs added these groups to the user itself: remove them.
gpasswd -d mailsomadhan adm >/dev/null 2>&1 || true
gpasswd -d mailsomadhan systemd-journal >/dev/null 2>&1 || true
cat > /etc/systemd/system/mailsomadhan-collector.service <<EOF
[Unit]
Description=MailSomadhan mail log collector
After=network.target postgresql.service postfix.service
Wants=postgresql.service

[Service]
User=mailsomadhan
Group=mailsomadhan
SupplementaryGroups=systemd-journal adm
WorkingDirectory=$SRC_DIR/backend
Environment=MAILSOMADHAN_ENV_FILE=$ENV_FILE
Environment=PYTHONUNBUFFERED=1
ExecStart=$APP_DIR/venv/bin/python -m app.collector
Restart=always
RestartSec=5
Nice=5
PrivateTmp=yes
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF

# Campaign worker: sends individually addressed campaign mail at the requested pace.
cat > /etc/systemd/system/mailsomadhan-campaigns.service <<EOF
[Unit]
Description=MailSomadhan campaign sender
After=network.target postgresql.service postfix.service
Wants=postgresql.service

[Service]
User=mailsomadhan
Group=mailsomadhan
WorkingDirectory=$SRC_DIR/backend
Environment=MAILSOMADHAN_ENV_FILE=$ENV_FILE
Environment=PYTHONUNBUFFERED=1
ExecStart=$APP_DIR/venv/bin/python -m app.campaign_worker
Restart=always
RestartSec=5
PrivateTmp=yes
ProtectHome=yes

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/mailsomadhan-web.service <<EOF
[Unit]
Description=MailSomadhan web panel
After=network.target

[Service]
User=mailsomadhan
Group=mailsomadhan
WorkingDirectory=$SRC_DIR/frontend/.next/standalone
Environment=NODE_ENV=production
Environment=PORT=$WEB_INTERNAL_PORT
Environment=HOSTNAME=127.0.0.1
Environment=NEXT_TELEMETRY_DISABLED=1
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
NoNewPrivileges=yes
PrivateTmp=yes
ProtectHome=yes
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/nginx/snippets/mailsomadhan-app.conf <<EOF
# Shared by every MailSomadhan virtual host.
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
ssl_session_cache shared:mailsomadhan:10m;
ssl_session_timeout 1d;
server_tokens off;
client_max_body_size 300m;

add_header Strict-Transport-Security "max-age=31536000" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Referrer-Policy "same-origin" always;

# Plain HTTP sent to the HTTPS port: redirect instead of showing an error page.
error_page 497 =301 https://\$host:\$server_port\$request_uri;

location /api/ {
    proxy_pass http://127.0.0.1:$API_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto https;
    proxy_request_buffering off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;
}

location / {
    proxy_pass http://127.0.0.1:$WEB_INTERNAL_PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$remote_addr;
    proxy_set_header X-Forwarded-Proto https;
}
EOF
rm -f /etc/nginx/sites-enabled/default

install -d /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/mailsomadhan <<'EOF'
#!/bin/sh
# Copy renewed certificates into place and reload nginx, Postfix and Dovecot.
/usr/local/sbin/mailsomadhan-helper tls-sync
EOF
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/mailsomadhan

# --------------------------------------------------------------------------- fail2ban
cat > /etc/fail2ban/filter.d/mailsomadhan-panel.conf <<'EOF'
[Definition]
failregex = mailsomadhan-auth: login failed ip=<HOST> user=
ignoreregex =
journalmatch = _SYSTEMD_UNIT=mailsomadhan-api.service
EOF
cat > /etc/fail2ban/jail.d/mailsomadhan.local <<EOF
[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
backend = systemd

[postfix]
enabled = true
mode = aggressive
backend = systemd
journalmatch = _SYSTEMD_UNIT=postfix@-.service + _SYSTEMD_UNIT=postfix.service

[dovecot]
enabled = true
backend = systemd

[mailsomadhan-panel]
enabled = true
backend = systemd
filter = mailsomadhan-panel
port = $WEB_PORT
maxretry = 8
EOF

# --------------------------------------------------------------------------- version info
STATUS_DIR=/var/lib/mailsomadhan-status
install -d -o root -g root -m 755 "$STATUS_DIR"
for f in version.json update-result.json backup-status.json backup-settings.json; do
  if [ -e "$STATE_DIR/$f" ] || [ -L "$STATE_DIR/$f" ]; then
    if [ ! -e "$STATUS_DIR/$f" ] && [ -f "$STATE_DIR/$f" ] && [ ! -L "$STATE_DIR/$f" ]; then
      install -m 644 "$STATE_DIR/$f" "$STATUS_DIR/$f"
    fi
    rm -f "$STATE_DIR/$f"
  fi
done
SRC_COMMIT="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || echo local)"
cat > "$STATUS_DIR/version.json" <<EOF
{"version": "$(tr -dc '0-9A-Za-z.+-' < "$SRC_DIR/VERSION" 2>/dev/null || echo unknown)", "commit": "$SRC_COMMIT", "installed_at": "$(date -Is)"}
EOF
chmod 644 "$STATUS_DIR/version.json"
[ -f /var/log/mailsomadhan-update.log ] || install -m 640 -g mailsomadhan /dev/null /var/log/mailsomadhan-update.log
[ -f /var/log/mailsomadhan-backup.log ] || install -m 640 -g mailsomadhan /dev/null /var/log/mailsomadhan-backup.log
# Keep the backup schedule in sync with the saved settings (no-op until backups are configured).
if [ -f "$ETC_DIR/backup.conf" ]; then /usr/local/sbin/mailsomadhan-helper backup-configure >/dev/null || true; fi

# --------------------------------------------------------------------------- start everything
step "Starting services"
systemctl daemon-reload
systemctl enable -q rspamd dovecot postfix nginx mailsomadhan-api mailsomadhan-web 2>/dev/null || true
# Spam filter / Redis switches (defaults on first install, the panel's choice afterwards).
/usr/local/sbin/mailsomadhan-helper apply-features >/dev/null
systemctl restart dovecot
systemctl restart postfix
systemctl restart mailsomadhan-api mailsomadhan-web
systemctl enable -q mailsomadhan-collector mailsomadhan-campaigns 2>/dev/null || true
systemctl restart mailsomadhan-collector mailsomadhan-campaigns
/usr/local/sbin/mailsomadhan-helper tls-sync >/dev/null
systemctl restart nginx
systemctl enable -q fail2ban 2>/dev/null || true
systemctl restart fail2ban || warn "fail2ban did not start; check 'journalctl -u fail2ban'"

# --------------------------------------------------------------------------- firewall
step "Configuring the firewall"
if grep -qi microsoft /proc/version 2>/dev/null; then
  # Under WSL, localhost traffic does not arrive on the loopback interface, so ufw's default
  # policy would cut the panel off from its own API. WSL is a test environment: skip it.
  warn "WSL detected: firewall not enabled (use a real server or VM for production)"
elif command -v ufw >/dev/null; then
  ssh_ports="$(sshd -T 2>/dev/null | awk '/^port / {print $2}' || true)"
  for p in ${ssh_ports:-22}; do ufw allow "$p/tcp" >/dev/null 2>&1 || true; done
  for p in 25 "$HTTP_PORT" 465 587 993 "$WEB_PORT"; do ufw allow "$p/tcp" >/dev/null 2>&1 || true; done
  if ufw --force enable >/dev/null 2>&1; then
    info "Open ports: ${ssh_ports:-22} (SSH), 25, $HTTP_PORT, 465, 587, 993, $WEB_PORT"
  else
    warn "could not enable ufw; make sure ports 25, $HTTP_PORT, 465, 587, 993 and $WEB_PORT are reachable"
  fi
fi

# --------------------------------------------------------------------------- Let's Encrypt
LE_OK=0
if [ -d "/etc/letsencrypt/live/$MAIL_HOSTNAME" ]; then
  LE_OK=1
elif [ "${MAILSOMADHAN_NO_LETSENCRYPT:-0}" != "1" ]; then
  step "Requesting a Let's Encrypt certificate for $MAIL_HOSTNAME"
  resolved="$(getent ahosts "$MAIL_HOSTNAME" 2>/dev/null | awk '{print $1}' | grep -vE '^(127\.|::1)' | head -n1 || true)"
  if [ -z "$resolved" ]; then
    warn "$MAIL_HOSTNAME does not resolve yet. Add its DNS A record, then use 'Hosts & TLS' in the panel."
  else
    info "By requesting a certificate you agree to the Let's Encrypt Subscriber Agreement."
    if /usr/local/sbin/mailsomadhan-helper tls-issue "$MAIL_HOSTNAME" >/dev/null 2>&1; then
      LE_OK=1
      info "Trusted certificate installed."
    else
      warn "The certificate request failed (DNS not pointing here yet, or port 80 blocked)."
      warn "A self-signed certificate is used for now; retry later under 'Hosts & TLS' in the panel."
    fi
  fi
fi

# --------------------------------------------------------------------------- health check
sleep 2
problems=""
check_svcs="postfix dovecot rspamd postgresql nginx mailsomadhan-api mailsomadhan-web mailsomadhan-collector mailsomadhan-campaigns"
if ! grep -q '^REDIS=0' "$ETC_DIR/features.conf" 2>/dev/null; then check_svcs="$check_svcs redis-server"; fi
for svc in $check_svcs; do
  systemctl is-active -q "$svc" || problems="$problems $svc"
done
if ! curl -fsS --max-time 10 "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1; then
  sleep 4
  curl -fsS --max-time 10 "http://127.0.0.1:$API_PORT/api/health" >/dev/null 2>&1 || problems="$problems api-not-responding"
fi

if [ "$FIRST_INSTALL" -eq 1 ]; then
  umask 077
  cat > "$CRED_FILE" <<EOF
MailSomadhan
Panel:    https://$MAIL_HOSTNAME:$WEB_PORT
Username: admin
Password: $ADMIN_PASS

Change this password after the first sign-in (Settings), then delete this file.
EOF
  umask 022
fi

echo
if [ -n "$problems" ]; then
  echo "${c_yellow}${c_bold}Installed, but these components are not healthy:${problems}${c_off}"
  echo "Inspect them with: journalctl -u <service> -n 50    (full install log: $LOG_FILE)"
else
  echo "${c_green}${c_bold}MailSomadhan is installed and running.${c_off}"
fi
echo
echo "  Web panel:   https://$MAIL_HOSTNAME:$WEB_PORT"
if [ "$FIRST_INSTALL" -eq 1 ]; then
  echo "  Username:    admin"
  echo "  Password:    $ADMIN_PASS"
  echo "               (also saved in $CRED_FILE)"
fi
if [ "$LE_OK" -ne 1 ]; then
  echo
  echo "  The panel currently uses a self-signed certificate, so your browser will show a warning."
  echo "  Point the DNS A record of $MAIL_HOSTNAME to this server, then issue a trusted"
  echo "  certificate in the panel under 'Hosts & TLS'."
fi
cat <<EOF

  Next steps in the panel:
    1. Domains    - add a domain and publish the DNS records it shows (MX, SPF, DKIM, DMARC)
    2. Mailboxes  - create users; they sign in at the same address with their email
    3. Optional   - SMTP relays, extra hosts, attachment limits and branding under Settings

  Also set the reverse DNS (PTR) of this server's IP address to $MAIL_HOSTNAME at your
  hosting provider, otherwise other mail servers may reject your mail.

  Manage the server with:  mailsomadhan status | restart | logs | reset-admin-password | update
EOF

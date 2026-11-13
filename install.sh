#!/usr/bin/env bash
#
# MailSomadhan - one-command installer for Ubuntu 22.04 / 24.04
#
#   curl -fsSL https://raw.githubusercontent.com/mdatiqmazumder/MailSomadhan/main/install.sh | sudo bash
#
# Optional environment variables (all can also be answered interactively):
#   MAILSOMADHAN_HOSTNAME   mail server hostname, e.g. mail.example.com
#   MAILSOMADHAN_PORT       HTTPS port of the web panel (default 8443)
#   MAILSOMADHAN_REPO       git repository to install from
#   MAILSOMADHAN_BRANCH     branch or tag to install (default main)
#   MAILSOMADHAN_NO_LETSENCRYPT=1   do not request a Let's Encrypt certificate during install
#
set -euo pipefail

REPO_URL="${MAILSOMADHAN_REPO:-https://github.com/mdatiqmazumder/MailSomadhan.git}"
BRANCH="${MAILSOMADHAN_BRANCH:-main}"
SRC_DIR=/opt/mailsomadhan/src

if [ "$(id -u)" -ne 0 ]; then
  echo "This installer must run as root. Try: curl -fsSL <url> | sudo bash" >&2
  exit 1
fi

if ! grep -qi '^ID=ubuntu' /etc/os-release 2>/dev/null; then
  echo "MailSomadhan supports Ubuntu 22.04 and 24.04 only." >&2
  exit 1
fi

# Running from a local checkout (bash install.sh)? Then install that copy.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

export DEBIAN_FRONTEND=noninteractive

if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/installer/setup.sh" ]; then
  if [ "$SELF_DIR" != "$SRC_DIR" ]; then
    echo "==> Copying local checkout to $SRC_DIR"
    command -v rsync >/dev/null || { apt-get update -qq && apt-get install -y -qq rsync >/dev/null; }
    mkdir -p "$SRC_DIR"
    # A local copy is not a git checkout of the release repository: the first update from the
    # panel replaces it with a clean clone. Files are owned by root like a normal install.
    rm -rf "$SRC_DIR/.git"
    rsync -a --delete --no-owner --no-group \
      --exclude .git --exclude node_modules --exclude .next --exclude .venv --exclude venv \
      --exclude __pycache__ --exclude devdata --exclude '*.db' --exclude .env --exclude .claude \
      "$SELF_DIR"/ "$SRC_DIR"/
    chown -R root:root "$SRC_DIR"
    chmod -R go-w "$SRC_DIR"
  fi
else
  echo "==> Downloading MailSomadhan ($BRANCH)"
  command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git ca-certificates >/dev/null; }
  if [ -d "$SRC_DIR/.git" ]; then
    git -C "$SRC_DIR" fetch --depth 1 origin "$BRANCH"
    git -C "$SRC_DIR" reset --hard FETCH_HEAD
  else
    mkdir -p "$(dirname "$SRC_DIR")"
    rm -rf "$SRC_DIR"
    git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$SRC_DIR"
  fi
fi

exec bash "$SRC_DIR/installer/setup.sh" "$@"

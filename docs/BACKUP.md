# Backups to Google Drive

MailSomadhan can back up the whole server to Google Drive on a schedule you choose in the admin panel (**Backups** page).

Each backup is **one encrypted file** containing:

| Part | Contents |
| --- | --- |
| Database | All domains, mailboxes, aliases, relays, filters, settings and mail analytics (`pg_dump`) |
| Configuration | `/etc/mailsomadhan` (secrets, TLS certificates), DKIM keys, Let's Encrypt certificates, filter maps |
| Mail (optional) | Every mailbox in `/var/vmail`. Turn this off if you only want the database |

The file is encrypted with AES-256 using a passphrase only you know, then streamed straight to Google Drive. Nothing is kept on the server's disk. Old backups are deleted automatically; you choose how many to keep.

> **Keep the passphrase somewhere safe, outside this server.** Without it a backup cannot be opened, and nobody (including us) can recover it.

---

## 1. Connect Google Drive

You need a credential (a "key") that lets the server write to your Google Drive. Choose **one** of the two methods.

### Method A — Any Google account (personal Gmail or Workspace)

This uses rclone's sign-in flow. You run one command **on your own computer** (any computer with a web browser, not the server).

1. Install rclone on your computer:
   - Windows: download from <https://rclone.org/downloads/>, unzip, open a terminal in that folder
   - macOS: `brew install rclone`
   - Linux: `sudo apt install rclone`
2. Run:

   ```bash
   rclone authorize "drive"
   ```

3. A browser window opens. Sign in with the Google account that should store the backups and click **Allow**.
4. Back in the terminal, rclone prints a block like this:

   ```
   Paste the following into your remote machine --->
   {"access_token":"ya29.a0...","token_type":"Bearer","refresh_token":"1//0g...","expiry":"2026-11-13T15:04:05Z"}
   <---End paste
   ```

5. Copy the JSON line (from `{` to `}`) and paste it into **Backups → Google Drive → Sign-in token** in the panel, then click **Connect**.

Optional, recommended for large organisations: rclone's shared client ID is rate-limited. Create your own OAuth client in Google Cloud Console (APIs & Services → Credentials → Create OAuth client ID → Desktop app, and enable the Google Drive API), then run:

```bash
rclone authorize "drive" "YOUR_CLIENT_ID" "YOUR_CLIENT_SECRET"
```

and enter the same client ID and secret in the panel together with the token.

### Method B — Service account + Shared drive (Google Workspace)

Best for organisations: no personal account involved, and access can be revoked centrally. Service accounts have no storage of their own, so a **Shared drive** is required.

1. In Google Cloud Console create a project, enable the **Google Drive API**, then go to *IAM & Admin → Service accounts → Create service account*.
2. Open the service account → *Keys → Add key → Create new key → JSON*. A `.json` file downloads.
3. In Google Drive create a **Shared drive** (for example "Mail backups"), open *Manage members*, and add the service account's email address (`...@...iam.gserviceaccount.com`) as **Content manager**.
4. Open the Shared drive in the browser. The ID is the last part of the address: `https://drive.google.com/drive/folders/`**`0AbCdEfGhIjKlMnOpQ`**
5. In the panel choose **Service account**, paste the whole contents of the JSON file, enter the Shared drive ID, and click **Connect**.

After connecting, the panel tests the connection and creates the backup folder (default `MailSomadhan-Backups`).

## 2. Set the encryption passphrase

On the Backups page enter a passphrase of at least 12 characters and save it. Store a copy in your password manager. You can change it later; older backups still need the passphrase they were made with.

## 3. Choose the schedule

| Setting | Meaning |
| --- | --- |
| Every | 1, 2, 3, 4, 6, 8 or 12 hours, daily, or weekly |
| At | Time of day for daily and weekly backups (server time) |
| Keep | How many backups to keep on Drive; older ones are deleted |
| Include mailboxes | Off = database and configuration only (small and fast) |

Turn on **Scheduled backups** and save. **Back up now** starts one immediately.

You can also manage backups from the server's command line:

```bash
sudo systemctl start mailsomadhan-backup.service      # back up now
sudo systemctl list-timers mailsomadhan-backup.timer  # next scheduled run
sudo tail -f /var/log/mailsomadhan-backup.log         # watch progress
```

---

## Restoring a backup

Restore onto a fresh Ubuntu server with MailSomadhan installed using the **same mail hostname**. All commands run as root (`sudo -i`).

1. Install rclone and connect it to the same Drive (`rclone config`, or copy `/etc/mailsomadhan/rclone.conf` from the panel's server if you still have it), then download the backup:

   ```bash
   rclone --config /etc/mailsomadhan/rclone.conf lsf gdrive:MailSomadhan-Backups
   rclone --config /etc/mailsomadhan/rclone.conf copy gdrive:MailSomadhan-Backups/FILE_NAME.tar.gz.enc /root/
   ```

   Alternatively download the file from drive.google.com in your browser and upload it to the server.

2. Decrypt and unpack it (you will be asked for the passphrase):

   ```bash
   mkdir /root/restore && cd /root/restore
   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in /root/FILE_NAME.tar.gz.enc | tar -xz
   ```

3. Stop the services, restore files and the database:

   ```bash
   systemctl stop mailsomadhan-api mailsomadhan-web mailsomadhan-collector postfix dovecot
   cp -a etc/mailsomadhan/. /etc/mailsomadhan/
   cp -a var/lib/rspamd/dkim/. /var/lib/rspamd/dkim/
   cp -a var/lib/mailsomadhan/. /var/lib/mailsomadhan/
   [ -d etc/letsencrypt ] && cp -a etc/letsencrypt/. /etc/letsencrypt/
   [ -d var/vmail ] && cp -a var/vmail/. /var/vmail/ && chown -R vmail:vmail /var/vmail
   runuser -u postgres -- pg_restore --clean --if-exists -d mailsomadhan database.dump
   ```

4. Re-apply the configuration (the installer keeps the restored secrets) and check:

   ```bash
   bash /opt/mailsomadhan/src/installer/setup.sh
   mailsomadhan status
   ```

Delete `/root/restore` and the downloaded file afterwards; they contain unencrypted data.

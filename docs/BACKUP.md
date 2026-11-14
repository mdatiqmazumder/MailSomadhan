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

### Method A — Sign in with Google (any Google account, recommended)

You create your own OAuth client in Google Cloud Console **once**. After that, connecting (or reconnecting) Drive is one click: **Connect Google Drive** opens Google's sign-in page, you click **Allow**, and Google sends you back to the panel, which finishes the setup by itself. No commands and no tokens to copy.

**One-time setup in Google Cloud Console** (<https://console.cloud.google.com>):

1. Create a project (or pick an existing one).
2. *APIs & Services → Library*: enable the **Google Drive API**.
3. *Google Auth Platform → Branding*: fill in the app name (for example "MailSomadhan backups") and your support email.
4. *Google Auth Platform → Audience*:
   - Google Workspace: choose **Internal**.
   - Personal Gmail: choose **External**, then click **Publish app** so the status is **In production**.
     While the app is in *Testing*, Google expires the connection after 7 days and backups stop.
     The panel only asks for the `drive.file` permission (it can see only the files it creates), which Google does not require verification for.
5. *Google Auth Platform → Clients → Create client*, type **Web application**. Under **Authorized redirect URIs** add the address the panel shows on the Backups page. It is your panel's address followed by `/admin/backups/google`, for example:

   ```
   https://mail.example.com:6568/admin/backups/google
   ```

   Open the panel at exactly this address when you connect; Google refuses any other.
6. Copy the **Client ID** and **Client secret**.

**In the panel:** *Backups → Google Drive → Google account*, paste the client ID and secret, click **Connect Google Drive**, sign in with the account that should store the backups, and click **Allow**. The panel shows **Connected · your@account** and tests the connection.

The client ID and secret are remembered, so **Reconnect** later is just the button.

> Because the panel uses the `drive.file` permission, it only sees backups it uploaded itself. To list them from another machine with rclone, use the same OAuth client; otherwise download them from drive.google.com in a browser.

<details>
<summary>Alternative: paste a token from <code>rclone authorize</code></summary>

If the panel cannot be opened under a fixed address (so no redirect address can be registered), click **Paste an rclone token instead**, then on your own computer (not the server) install rclone (<https://rclone.org/downloads/>) and run:

```bash
rclone authorize "drive"
```

Sign in, click **Allow**, and paste the JSON line it prints (from `{` to `}`) into the panel. With your own OAuth client of type *Desktop app* use `rclone authorize "drive" "CLIENT_ID" "CLIENT_SECRET"` and enter the same ID and secret in the panel.

</details>

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
   systemctl stop mailsomadhan-api mailsomadhan-web mailsomadhan-collector mailsomadhan-campaigns postfix dovecot
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

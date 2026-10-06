# Native Windows

Spindle can run directly on 64-bit Windows without Docker, WSL, or hardware virtualization.

The Windows release ZIP is self-contained: it includes Node.js, the built backend and frontend, and Windows-native production dependencies such as `better-sqlite3`.

## First run

1. Extract the ZIP to a permanent directory, for example `C:\Spindle`.
2. Run `start-spindle.cmd` once. It creates `.env` from `spindle.env.example` and exits.
3. Edit `.env`:
   - set `INGEST_SECRET`
   - set `NAVIDROME_DB_PATH` to the live `navidrome.db`
   - set `DEFAULT_USER`
   - optionally set Navidrome credentials for covers/player/share links
4. Run `start-spindle.cmd` again.
5. Open `http://127.0.0.1:3590`.

Use forward slashes in Windows paths inside `.env`, e.g.
`C:/ProgramData/Navidrome/navidrome.db`.

Spindle opens Navidrome's SQLite database read-only. Its own data is stored under `data\`.

## Password gate

Generate a password hash with:

```cmd
hash-password.cmd "your long passphrase"
```

Put the printed `scrypt:...` value in `SPINDLE_PASSWORD_HASH`, set a long random `SESSION_SECRET`, then restart Spindle.

For plain local HTTP, leave `AUTH_COOKIE_SECURE=false`. Set it to `true` when serving Spindle over HTTPS.

## Start automatically at boot

After `.env` is configured, open PowerShell **as Administrator** in the Spindle directory and run:

```powershell
.\install-startup-task.ps1
```

This installs a Windows Scheduled Task named `Spindle` that:

- starts at boot without an interactive login
- runs as the local SYSTEM account
- restarts after failures
- writes output to `data\spindle.log`

Remove the task without deleting Spindle data:

```powershell
.\uninstall-startup-task.ps1
```

If Navidrome stores its database on a network share, do not use the SYSTEM task as-is; run Spindle under an account that has access to that share.

## Navidrome Collector

Install the normal Spindle Collector `.ndp` in Navidrome and set its backend URL to the Windows host, for example:

`http://127.0.0.1:3590`

Use the same shared secret configured as `INGEST_SECRET`.

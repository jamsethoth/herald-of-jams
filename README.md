# Herald of Jams

Herald of Jams is a single-server Discord counting game with hidden sequence rules, durable seasonal scoring, reconnect reconciliation, ordered Discord output, and a private administration interface.

## Portable Windows quick start

1. Extract the Windows x64 ZIP to any folder.
2. Run `Herald of Jams.exe` and complete the setup form.
3. Use the tray icon to open administration, configure, restart, inspect data/logs, or exit.

Configuration, SQLite state, and logs persist under `%LOCALAPPDATA%\Herald of Jams`, so moving or replacing the extracted package does not delete them. The Discord token remains a sensitive credential even though the launcher persists it; do not copy `config.env` into chat, source control, or backups without appropriate protection. Node.js and .NET do not need to be installed to run the ZIP.

## Requirements

- Node.js 24.21.0 (see `.nvmrc` and `.node-version`)
- Corepack with pnpm 12.5.1
- A Discord application and dedicated test or production guild
- A private HTTPS reverse proxy for production administration
- .NET 10 SDK only when building the Windows launcher/package

## Install and build

```powershell
corepack.cmd pnpm install --frozen-lockfile
corepack.cmd pnpm test
corepack.cmd pnpm typecheck
corepack.cmd pnpm build
```

Generate an administrator password hash without storing the password:

```powershell
node scripts/hash-admin-password.mjs
```

For direct server mode, load `.env.example` values through your process supervisor, or pass an absolute file explicitly with `node build/app/main.js --config C:\absolute\config.env`. Environment-only startup remains supported. Do not use a source-relative database path operationally: another checkout or worktree can silently select a different SQLite file.

```powershell
corepack.cmd pnpm start
```

Build the checksummed portable ZIP with `corepack.cmd pnpm package:win`. The pipeline downloads the exact Node version in `.node-version`, verifies it against Node's official `SHASUMS256.txt`, publishes the self-contained launcher, scans the staged package, and runs an offline packaged smoke test before creating `artifacts/herald-of-jams-<version>-win-x64.zip`.

The administration interface defaults to `127.0.0.1:3000`. Do not expose it directly to the public internet. See [docs/operations.md](docs/operations.md) for Discord permissions, reverse-proxy requirements, backup, recovery, and shutdown procedures.

## Round and announcement configuration

Use **Announcement defaults** in the administration interface to edit the global round-start, bonus, reset, completion, and cancellation messages. A round template may override any of them; a blank override inherits the global value that exists when the round is activated. Activation freezes the effective wording, so later edits affect only future rounds. The resolved start announcement is queued atomically with activation.

Round-start and reset messages allow `{start}`. Bonus messages allow `{player}` and `{bonusPoints}`. Completion and cancellation messages do not allow placeholders. Every allowed placeholder is optional. Unknown placeholders and messages longer than 1,900 characters are rejected.

A template may set the target equal to the start for a one-submission smoke test. Cancelling any round discards its provisional rewards and removes every penalty belonging to that round.

## Architecture

- Pure TypeScript compiles rounds, parses numbers, evaluates submissions, and calculates exact scores.
- One SQLite connection commits domain state, ledger changes, audits, and ordered outbox work atomically.
- Discord work is delivered after commit in channel sequence order and reconciled by stable nonce after ambiguous responses.
- Reconnect history is replayed in Discord snowflake order. After the first penalty-causing message, later numerics in the captured window are invalidated and deleted before the reset announcement.
- The Fastify administration surface uses scrypt password verification, SQLite sessions, CSRF protection, persistent throttling, and scoped hardened cookies.

No real credentials, guild IDs, channel IDs, or private URLs belong in this repository.

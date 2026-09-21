# Herald of Jams

Herald of Jams is a single-server Discord counting game with hidden sequence rules, durable seasonal scoring, reconnect reconciliation, ordered Discord output, and a private administration interface.

## Requirements

- Node.js 24.21.0 (see `.nvmrc` and `.node-version`)
- Corepack with pnpm 12.5.1
- A Discord application and dedicated test or production guild
- A private HTTPS reverse proxy for production administration

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

Copy `.env.example` to `.env`, replace every placeholder, and load those variables through your process supervisor. The service does not load `.env` files itself.

```powershell
corepack.cmd pnpm start
```

The administration interface defaults to `127.0.0.1:3000`. Do not expose it directly to the public internet. See [docs/operations.md](docs/operations.md) for Discord permissions, reverse-proxy requirements, backup, recovery, and shutdown procedures.

## Round and announcement configuration

Use **Announcement defaults** in the administration interface to edit the global bonus, reset, completion, and cancellation messages. A round template may override any of them; a blank override inherits the global value that exists when the round is activated. Activation freezes the effective wording, so later edits affect only future rounds.

Bonus messages allow `{player}` and `{bonusPoints}`. Reset messages allow `{start}`. Completion and cancellation messages do not allow placeholders. Unknown placeholders and messages longer than 1,900 characters are rejected.

A template may set the target equal to the start for a one-submission smoke test. Cancelling any round discards its provisional rewards and removes every penalty belonging to that round.

## Architecture

- Pure TypeScript compiles rounds, parses numbers, evaluates submissions, and calculates exact scores.
- One SQLite connection commits domain state, ledger changes, audits, and ordered outbox work atomically.
- Discord work is delivered after commit in channel sequence order and reconciled by stable nonce after ambiguous responses.
- Reconnect history is replayed in Discord snowflake order. After the first penalty-causing message, later numerics in the captured window are invalidated and deleted before the reset announcement.
- The Fastify administration surface uses scrypt password verification, SQLite sessions, CSRF protection, persistent throttling, and scoped hardened cookies.

No real credentials, guild IDs, channel IDs, or private URLs belong in this repository.

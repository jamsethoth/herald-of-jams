# Herald of Jams operations

## Portable tray operation

The Windows ZIP is the normal desktop deployment. Extract it and run `Herald of Jams.exe`; first-run setup writes `config.env` under `%LOCALAPPDATA%\Herald of Jams`. The same directory owns `herald-of-jams.sqlite`, its WAL/SHM sidecars, and `logs`. Package replacement never migrates or deletes those files.

Tray states are **Starting**, **Running**, **Attention required**, **Stopping**, and **Stopped**. Commands are **Open administration**, **Configure**, **Open data folder**, **Open logs**, **Restart bot**, and **Exit**. Administration always opens `http://127.0.0.1:<validated-port>/admin` and is enabled only while running.

Logs rotate at 5 MiB and retain at most five files; known configured token/hash/session-secret values are redacted from both child streams. Reconfiguration stages a same-directory candidate, stops cleanly, activates it, and commits only after successful startup. Failed candidate startup restores the byte-identical prior file and attempts to restart it. Exit sends `shutdown`, waits up to 15 seconds for HTTP, Discord, queued work, and SQLite to drain, then forces termination only if necessary.

Unexpected exits retry after 1, 5, and 15 seconds. After three failed restarts the tray requires attention. The budget resets only after five continuous healthy minutes. Five minutes without reachable health also requires attention but does not start a second child or kill the first.

Before distributing a package, run `corepack.cmd pnpm package:win`. To verify an extracted package offline, run `Herald of Jams.exe --smoke-test --data-dir C:\absolute\temporary-folder`; it validates the immutable tree and bundled Node/native SQLite/assets without connecting to Discord.

For replacement, exit cleanly, back up `%LOCALAPPDATA%\Herald of Jams`, extract the new ZIP to a fresh folder, and run it. Never overlay or delete the local-data directory. For a filesystem SQLite backup, keep the database, `-wal`, and `-shm` together; a clean stop is preferred.

## Initial setup

Install Node.js 24.21.0, enable Corepack, and install the locked dependency graph:

```powershell
corepack.cmd enable
corepack.cmd pnpm install --frozen-lockfile
```

Generate the administrator password hash interactively:

```powershell
node scripts/hash-admin-password.mjs
```

The command prints only an encoded `scrypt$...` value. Put it in `ADMIN_PASSWORD_HASH`; do not store the plaintext password.

Configure every variable shown in `.env.example` through the service manager:

- `DISCORD_TOKEN`: use a placeholder such as `your-discord-token` in examples, never a live token in source control.
- `DISCORD_APPLICATION_ID` and `DISCORD_GUILD_ID`: the application and single permitted guild.
- `DATABASE_PATH`: writable SQLite database path. Its parent directory is created at startup.
- `ADMIN_HOST` and `ADMIN_PORT`: private administration listener.
- `ADMIN_PASSWORD_HASH`: output of the offline hash script.
- `SESSION_SECRET`: at least 32 random bytes, distinct from every other credential.
- `ADMIN_SECURE_COOKIE`: `false` only for loopback development; `true` in production.
- `TRUST_PROXY`: `true` in production. Only a loopback reverse proxy is trusted for forwarded HTTPS.

## Discord application

Enable the Message Content privileged intent. The service requests only the `Guilds`, `GuildMessages`, and `MessageContent` gateway intents.

In the game channel grant the bot:

- View Channel
- Read Message History
- Send Messages
- Manage Messages
- Use Application Commands

Activation is rejected when any required capability is missing. On startup the service registers the guild-scoped `/leaderboard` command before connecting the Gateway. Use a dedicated non-production guild for manual verification.

## Private HTTPS administration

Production configuration requires secure cookies and `TRUST_PROXY=true`. Terminate HTTPS at a reverse proxy on the same host and proxy only to the configured loopback listener. Forward the original protocol. Forwarded-protocol headers from non-loopback peers are ignored, and production administration requests that are not established as HTTPS receive `426 Upgrade Required`.

Do not bind the Fastify listener to a public interface or expose it without an additional network access boundary.

## Startup and shutdown

Startup performs the following gate before live Discord messages are accepted:

1. Open and migrate SQLite.
2. Reload the active round and pending work.
3. Register the guild command and connect Discord.
4. Reconcile missed channel history.
5. Dispatch currently deliverable outbox work.
6. Start HTTP and enable live Gateway intake.

`SIGINT` and `SIGTERM` stop HTTP intake, stop Gateway intake, wait for serialized work, and close SQLite. A fatal startup error sets a non-zero process exit code and reports only the error class, not secrets.

## SQLite backup

The database uses WAL mode. Prefer a SQLite-aware online backup command while the service is running. For a filesystem-level copy, stop the service cleanly first and copy the main database together with any `-wal` and `-shm` sidecars. Restore the set as a unit. Never copy only the main file while writes may still be in WAL.

Test restoration in an isolated location before relying on a backup.

## Discord outbox recovery

Every Discord effect is durable and ordered. The operations page shows operation type, referenced round/submission, sequence, predecessor, attempts, next retry, redacted error, and state.

- Definite failures enter retry wait and may be retried.
- An ambiguous create is reconciled by nonce before any resend.
- If ambiguity remains outside Discord's five-minute enforced-nonce window, the operation enters `needs_review`; never blindly retry it.
- Use **Mark delivered** only after finding the exact Discord message and supplying its message ID.
- Use **Abandon** only after confirming the effect should not be delivered. Supply a reason and type `ABANDON`.

Both review resolutions append private audit events. Delivering or explicitly abandoning the final terminal operation marks the round operationally settled.

## Reconnect behavior

Reconnect captures a high-water message ID and evaluates history chronologically through the same serialized `GameService` path as live traffic. Duplicate message IDs are harmless.

Normal evaluation stops at round completion or the first penalty-causing submission. After a break, every later numeric through the high-water mark is recorded as `invalidated_after_reconnect_break` and queued for deletion. Those messages receive no canonical output, contribution, bonus, or penalty. The reset announcement is ordered after all invalidation deletions. A final catch-up pass includes messages that arrived during reconciliation before live intake resumes.

## Season and activation guards

A new round or season reset is rejected while another round is active. A completed or cancelled round also blocks both actions until its required terminal Discord chain is delivered or explicitly abandoned. Reset requires the confirmation text `RESET`; cancellation requires `CANCEL`.

Cancellation removes both provisional rewards and every penalty owned by the cancelled round. It does not alter scoring from completed or active rounds.

## Announcement configuration and one-value test

Open **Announcement defaults** in the private administration interface to edit the five global messages. Template edit pages provide optional overrides. Blank overrides inherit the current global value at activation, and the resolved messages are stored in the active round snapshot. Activation atomically queues the resolved round-start announcement before player-generated output.

- Round start: optional `{start}`
- Bonus: `{player}` and `{bonusPoints}`
- Reset: optional `{start}`
- Completion and cancellation: no placeholders

To test completion with one Discord account, create a template whose start and target are the same safe integer, activate it, and submit that number once. The single accepted submission completes the round. This is intended for smoke testing; multi-value rounds still enforce that consecutive accepted submissions come from different players.

## Manual verification status

Manual testing has verified broken-count handling and offline reconciliation in the user's Discord server. The round-start announcement, one-value completion path, announcement overrides, cancellation penalty removal, permissions, Message Content intent, slash registration, pause/resume, bans, ambiguous outbox review, leaderboard publication, and private-network administration still require manual verification before production use. Record only results here—never identifiers, tokens, route secrets, or private URLs.

The portable package has automated offline coverage only. Live Discord connection, permissions, reconciliation, gameplay, and restart acceptance remain pending explicit authorization for the dedicated test server/channel.

# Herald of Jams Repository Instructions

## Product And Architecture

- Herald of Jams is a Discord hidden-rule counting game with a loopback-only administration site and durable SQLite state.
- The Node service owns Discord, HTTP, game rules, reconciliation, ordered outbox delivery, and SQLite behavior.
- The native Windows launcher owns setup, persisted desktop configuration, process supervision, tray interaction, logs, and opening the administration site. Keep Discord, game, and database logic out of the launcher.
- Package manifests, lockfiles, TypeScript/.NET project files, and the portable-packaging design are authoritative for implemented versions and scope.

## Context Routing

- Portable packaging design: `docs/superpowers/specs/2026-09-26-portable-windows-tray-packaging-design.md`.
- Portable packaging implementation plan: `docs/superpowers/plans/2026-09-26-portable-windows-tray-packaging.md`.
- Runtime and recovery guidance: `docs/operations.md`.
- Read only the context relevant to the requested area. Global instructions own GitHub authentication, workspace, approval, and delegation policy.

## Engineering Invariants

### TypeScript And Runtime

- Keep strict TypeScript, ESM, explicit `.js` relative imports, `import type` for type-only imports, and `node:` specifiers for built-ins.
- Keep runtime resources independent of `process.cwd()`; packaged migrations, views, and public files come from the immutable application tree.
- Keep explicit `--config` files authoritative. Desktop configuration must remain loopback-only and must not inherit conflicting process environment values.
- Never put Discord tokens, password hashes, session secrets, administration credentials, or private route values in arguments, logs, diagnostics, snapshots, documentation examples, or artifacts.

### Persistence And Discord

- Access SQLite through the existing database/application boundaries. Preserve foreign keys, migrations, transactionality, and WAL companion-file backup behavior.
- Preserve startup reconciliation, ordered outbox processing, settlement, scoring, and graceful shutdown ordering.
- Keep live Discord tests behind explicit authorization for the dedicated test server and channel.

### Windows Launcher And Packaging

- Keep mutable configuration, database, and logs under `%LOCALAPPDATA%\Herald of Jams`; never write runtime data beside the extracted package.
- Keep the launcher self-contained, single-instance, and free of Discord/game/SQLite behavior.
- Candidate configuration changes must remain transactional: stop, activate, verify readiness, commit, or restore and restart the previous configuration.
- The portable ZIP must contain the launcher, pinned verified Node runtime, production application, LICENSE, and VERSION while excluding credentials, mutable state, tests, and source maps.

### Verification

- Vitest does not replace typechecking or the .NET launcher suite.
- Before publishing runtime changes, run `corepack.cmd pnpm test`, `corepack.cmd pnpm typecheck`, and `corepack.cmd pnpm build`.
- Before publishing launcher changes, run `dotnet test launcher/HeraldOfJams.Launcher.slnx --configuration Release`.
- Before publishing packaging or release changes, run `corepack.cmd pnpm package:win` and verify the produced ZIP manifest and checksum.
- Do not weaken, skip, or delete tests to make validation pass. Report live Discord checks as pending unless they were explicitly authorized and recorded.

## Slice Workflow

- Keep changes independently reviewable and scoped to the requested behavior.
- Before implementation, confirm the branch/worktree and current remote state.
- Include positive, negative, edge, and failure coverage proportional to the change.
- Before PR creation or update, reconcile requirements against code and tests, run the relevant gates, and keep generated artifacts out of Git.

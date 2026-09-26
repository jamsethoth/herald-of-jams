# Portable Windows Tray Packaging Design

**Date:** 2026-09-26

**Status:** Approved design

## Purpose

Herald of Jams currently assumes a developer checkout with Node.js, pnpm, a compiled `dist` tree, process environment variables, and runtime assets resolved from the source working directory. That makes ordinary restarts tedious and allowed operational data to live inside a disposable Git worktree.

The first packaged release will provide a configure-once Windows experience:

- Unzip a portable Windows x64 package.
- Launch one executable without installing Node.js or .NET.
- Complete a simple first-run setup.
- Run the bot quietly under a Windows tray icon.
- Open the existing administration interface in the default browser.
- Reuse configuration and SQLite state across restarts and package replacements.

The persistent runtime directory will be `%LOCALAPPDATA%\Herald of Jams`, outside both the package and any source checkout.

## Scope

This change includes:

- A self-contained .NET 10 Windows Forms tray launcher for Windows x64.
- A pinned Node.js runtime bundled beside the launcher.
- A production-only Node application deployment with runtime dependencies and assets.
- First-run and subsequent configuration UI.
- File-backed configuration and stable local application data.
- Tray lifecycle management, health reporting, logging, restart, reconfiguration, and clean exit.
- One reproducible command that produces a portable ZIP.
- Automated package-level smoke verification.

This change does not include:

- An installer.
- A Windows service.
- Windows automatic-start registration.
- Automatic update discovery or installation.
- Code signing.
- Windows ARM64 output.
- An embedded administration browser window.
- An Electron launcher.
- Changes to game rules, scoring, Discord output semantics, or administration features.

## Package Layout

The release artifact will be `artifacts/herald-of-jams-<version>-win-x64.zip`. Its extracted layout will be:

```text
Herald of Jams\
  Herald of Jams.exe
  runtime\
    node.exe
    ...pinned Node runtime files...
  app\
    ...compiled application...
    ...production node_modules...
    ...migrations, views, and static assets...
  LICENSE
  VERSION
```

The package will never contain live configuration, tokens, password material, session secrets, SQLite files, SQLite sidecars, or logs.

The initial package target is `win-x64`. Other architectures require separate artifacts and validation rather than runtime architecture guessing.

## Component Boundaries

### Tray launcher

`Herald of Jams.exe` will be a self-contained, single-file .NET 10 Windows Forms application. It owns only desktop-host concerns:

- Per-user single-instance enforcement.
- First-run and subsequent setup UI.
- Persistent-path selection.
- Starting and supervising the bundled Node process.
- Tray state, menu commands, and notifications.
- Opening fixed local paths and the fixed loopback administration URL through Windows.
- Capturing and rotating child-process logs.
- Bounded crash restart and clean shutdown.

The launcher will not implement game rules, use Discord directly, render the administration application, or read and write the game database.

### Node application

The Node application continues to own:

- Configuration parsing and semantic validation.
- SQLite schema migration and persistence.
- Discord command registration, Gateway operation, reconciliation, and outbox delivery.
- The loopback Fastify administration server.
- Application health state.
- Graceful shutdown of HTTP, Discord, serialized work, and SQLite.

The packaged process contract is:

```text
runtime\node.exe app\main.js --config <absolute-config-path> --desktop
```

The launcher's standard input remains connected to the child. A `shutdown` line requests the existing graceful application shutdown sequence. Standard output and standard error are diagnostic streams captured by the launcher.

This boundary deliberately permits a future Electron launcher to replace the .NET host without changing game services, persistent data, configuration format, or the child-process contract.

## Persistent Files

The tray-managed runtime directory is:

```text
%LOCALAPPDATA%\Herald of Jams\
  config.env
  herald-of-jams.sqlite
  herald-of-jams.sqlite-wal
  herald-of-jams.sqlite-shm
  logs\
```

The launcher creates the directory before setup. The package location and current working directory never determine the tray-managed database location.

When an explicit configuration file is supplied, the default database path is `herald-of-jams.sqlite` beside that file. An advanced absolute database-path override remains supported for standalone server deployments but is not exposed in the tray setup UI.

The application will not automatically discover, copy, or merge SQLite databases from source checkouts. Migration of an existing database is an explicit operator action because selecting the wrong database can silently restore unrelated state.

## Configuration Model

### First-run input

When `config.env` is missing or invalid, the launcher displays a setup form requesting:

- Discord bot token.
- Discord application ID.
- Discord guild ID.
- Administrator password.
- Optional administrator port, defaulting to `3000`.

The launcher generates:

- The existing scrypt administrator-password representation.
- A cryptographically random session secret containing at least 32 bytes.

The plaintext administrator password is retained only long enough to derive its hash and is never written to disk or logs.

### File semantics

The launcher writes `config.env` atomically within the current user's local application-data directory. It contains the Discord token, identifiers, password hash, session secret, loopback administration settings, and desktop runtime mode.

Because the file contains credentials, every component must treat it as sensitive:

- Never include its contents in logs, exceptions, process arguments, release artifacts, or telemetry.
- Mask secrets when reopening the configuration UI.
- Apply replacements only after structural and semantic validation succeeds.
- Use a protected temporary file for candidate configuration and remove it after commit or rollback.
- Rely on the current user's Windows profile permissions and do not broaden the file ACL.

An explicit `--config` file is authoritative. Process environment variables do not silently override values in that file. Running the Node application without `--config` retains the existing environment-variable configuration model for development and server deployment.

### Desktop security profile

Tray-managed desktop mode always binds administration to loopback, disables proxy trust, and uses an HTTP-only, same-site cookie suitable for loopback HTTP. The tray setup UI cannot configure a LAN listener.

Existing private-LAN deployment remains a standalone/server mode that requires HTTPS, secure cookies, and the explicitly trusted loopback reverse-proxy rules from the approved application design.

## Runtime Assets

Runtime migrations, Eta views, CSS, and other static files will no longer be resolved through `process.cwd()` and `src`. A focused resource resolver will locate immutable packaged assets relative to the deployed application entrypoint. Tests may inject a fixture resource root.

The production TypeScript build will include runtime source only. Tests and Vitest configuration will not be emitted into the package.

## Launcher Lifecycle

### Startup

1. Acquire a per-user single-instance lock.
2. Resolve and create `%LOCALAPPDATA%\Herald of Jams`.
3. Validate `config.env` or present first-run setup.
4. Start the bundled Node executable without a console window.
5. Capture stdout and stderr into bounded rotating logs.
6. Poll the loopback health endpoint until the child becomes ready, fails, or reaches the startup deadline.
7. Update the tray state and available commands.

Startup readiness includes application initialization, Discord connection, reconciliation, currently deliverable outbox work, and administration-server listening according to the existing startup contract.

### Tray states and commands

The tray displays:

- **Starting:** The process is launching, connecting, or reconciling.
- **Running:** The child is alive and its loopback health endpoint reports ready.
- **Attention required:** Configuration is invalid, startup failed, the health check is degraded, or the child exited.

The tray menu contains:

- **Open administration**
- **Configure**
- **Open data folder**
- **Open logs**
- **Restart bot**
- **Exit**

`Open administration` uses the fixed `http://127.0.0.1:<configured-port>/admin` URL only after the local application is ready. No child-provided or externally supplied URL is passed to the operating system.

### Single instance

A second launcher invocation does not create another child process. It signals the existing per-user launcher to open administration and then exits. If setup or startup requires attention, the existing launcher surfaces that state instead.

### Restart and exit

Restart and exit send `shutdown` over the child's standard input and wait for the existing orderly shutdown sequence. If the child does not exit within the defined shutdown deadline, the launcher records the timeout and may force termination. Forced termination is an exceptional fallback and must be visible in the log.

### Unexpected exit

An unexpected child exit triggers a small bounded number of restart attempts with backoff. Invalid configuration and other deterministic startup failures do not enter a restart loop. Exhausted attempts leave the tray in **Attention required** until the operator chooses restart or configure.

## Reconfiguration

The **Configure** action loads non-secret values and masked secret state into the setup form. Leaving a secret field unchanged preserves its existing value.

Applying configuration is transactional:

1. Build a candidate file in the protected data directory.
2. Validate its syntax and application configuration without revealing values.
3. Request clean child shutdown.
4. Atomically replace the active file.
5. Start the bot with the new file.
6. If startup fails, restore the previous file, restart the last known valid configuration, and report the candidate failure.
7. Remove temporary and rollback files after success or completed recovery.

Changing configuration does not rewrite or replace the SQLite database.

## Health and Diagnostics

The Node application exposes a loopback-only health endpoint for the launcher. It returns only an operational state such as `starting`, `reconciling`, `ready`, or `degraded`. It must not return tokens, identifiers not needed by the launcher, hidden rules, expected values, database records, message content, or stack traces.

Configuration failures identify invalid field names and safe validation reasons without printing field values. Packaged startup failures preserve useful safe details instead of reducing every failure to the error class name.

Logs are stored under `%LOCALAPPDATA%\Herald of Jams\logs`, rotate within a defined size/count limit, and redact known credential fields and values. Logging must never serialize the complete configuration object or child environment.

## Packaging Pipeline

The repository provides:

```powershell
corepack.cmd pnpm package:win
```

The command performs these stages in order:

1. Run the required automated tests, TypeScript typecheck, and production build.
2. Produce a runtime-only Node deployment.
3. Use `pnpm --prod deploy` and the lockfile to create an isolated production dependency tree.
4. Copy the explicitly enumerated runtime assets.
5. Obtain the exact Node.js Windows x64 ZIP pinned by the repository and verify it against Node's published SHA-256 manifest before extraction. A verified local download cache may be reused.
6. Publish the .NET 10 launcher as a self-contained single-file `win-x64` executable.
7. Assemble the staging directory and write package version metadata.
8. Run package-content checks and the packaged smoke test.
9. Create `artifacts/herald-of-jams-<version>-win-x64.zip`.

The pipeline fails closed on checksum mismatch, missing assets, native-module load failure, secret-like runtime files, or smoke-test failure.

## Verification

### Node application tests

Automated tests cover:

- Config-file parsing and validation.
- File-authoritative configuration behavior.
- Existing environment-only startup behavior.
- Stable database defaults beside the explicit configuration file.
- Desktop-mode loopback and cookie constraints.
- Resource resolution independent of the current working directory.
- Safe startup errors.
- Health-state responses and information boundaries.
- Standard-input shutdown and existing graceful-shutdown ordering.

### Launcher tests

Automated tests cover:

- First-run configuration generation.
- Administrator-password hashing and session-secret generation.
- Atomic configuration replacement and rollback.
- Command construction without secrets in arguments.
- Single-instance signaling.
- Tray lifecycle state transitions.
- Readiness polling.
- Bounded restart and backoff.
- Graceful-shutdown timeout behavior.
- Log rotation and redaction.
- Safe fixed-URL browser launch.

UI-independent launcher behavior will live behind testable interfaces. The thin Windows Forms layer will not contain lifecycle or configuration business logic.

### Packaged smoke test

The packaged launcher provides a non-interactive `--smoke-test` mode that uses an isolated temporary data directory and does not connect to Discord. It verifies:

- The packaged Node runtime starts.
- The packaged entrypoint and production dependencies load.
- The native `better-sqlite3` module loads.
- Migrations apply to a temporary database.
- Views and static assets resolve from packaged locations.
- The local server can start and stop.
- The child exits cleanly through the launcher control channel.
- No files are written beside the extracted package.

### Manual Windows acceptance

Before declaring the package ready for ordinary use:

1. Unzip and launch on Windows without relying on installed Node.js or .NET.
2. Complete first-run setup.
3. Confirm tray state and default-browser administration.
4. Relaunch and confirm configuration and database reuse.
5. Replace or relocate the package and confirm local application data survives.
6. Exercise restart, reconfiguration rollback, unexpected-exit recovery, and clean exit.
7. Confirm no console window remains visible during ordinary operation.
8. Perform Discord and gameplay checks only in the dedicated test server after explicit authorization.

## Security Invariants

- No production token, password, password hash, session secret, private URL, or Discord identifier is committed or packaged.
- Secrets never appear in command-line arguments.
- The plaintext administrator password is never persisted.
- Desktop administration is loopback-only.
- Server/LAN administration retains the existing HTTPS and trusted-proxy requirements.
- Browser launch uses a locally constructed fixed HTTP URL, not untrusted input.
- The launcher never accesses game tables or mutates SQLite directly.
- Package replacement never deletes, resets, migrates from, or overwrites local application data.

## Future Electron Pivot

An Electron host may later replace the .NET tray launcher. That pivot must preserve:

- `%LOCALAPPDATA%\Herald of Jams` and its configuration format.
- The packaged Node child contract.
- The standard-input shutdown command.
- The health endpoint contract.
- Tray lifecycle states and commands.
- Browser-based administration.

Electron-specific native-module rebuilding, package layout, and release validation are intentionally deferred until that pivot is chosen.

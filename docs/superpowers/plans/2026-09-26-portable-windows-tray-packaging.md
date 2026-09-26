# Portable Windows Tray Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a portable Windows x64 ZIP whose tray launcher configures, starts, supervises, and reuses Herald of Jams without requiring installed Node.js, .NET, or repeatedly entered environment variables.

**Architecture:** Keep the existing Node service as the sole owner of Discord, HTTP, and SQLite behavior. Add an explicit config/resource/control contract around it, then host it as a hidden child of a self-contained .NET 10 Windows Forms tray launcher. Store mutable state under `%LOCALAPPDATA%\Herald of Jams` and assemble the launcher, pinned Node runtime, production dependencies, and immutable assets through one verified packaging command.

**Tech Stack:** Node.js 24.21.0, TypeScript 7.0.2, pnpm 12.5.1, Vitest 5.0.1, .NET 10 Windows Forms, xUnit, PowerShell packaging, SQLite/better-sqlite3.

**Spec:** `docs/superpowers/specs/2026-09-26-portable-windows-tray-packaging-design.md`

## Global Constraints

- Target Windows x64 only; emit `artifacts/herald-of-jams-<version>-win-x64.zip`.
- Pin the bundled Node runtime to the exact version in `.node-version` and verify the official SHA-256 manifest before extraction.
- Publish the Windows Forms launcher for .NET 10 as self-contained and single-file; the target machine must not need .NET installed.
- Keep all mutable state under `%LOCALAPPDATA%\Herald of Jams`; never write runtime data beside the extracted package.
- Keep the tray launcher free of Discord, game, and SQLite behavior.
- Preserve environment-only startup for development/server use; an explicit `--config` file is authoritative and is not overlaid by inherited environment variables.
- Desktop mode is loopback-only and may use non-Secure HTTP-only same-site cookies; server production mode retains HTTPS, secure-cookie, and trusted-loopback-proxy requirements.
- Never place credentials in process arguments, logs, error dialogs, release artifacts, Git, or test snapshots.
- Preserve the approved Discord startup, reconciliation, ordered-outbox, settlement, scoring, and shutdown semantics.
- Do not add installer, service, auto-start, automatic updates, code signing, ARM64, or Electron work.

## Review Focus

- Config values containing CR, LF, NUL, quotes, or delimiter-like characters must not corrupt `config.env`; the setup validator rejects unsafe text and tests prove the active file remains unchanged.
- A package extracted under a read-only path containing spaces and non-ASCII characters must start from its bundled resources and write only to the supplied local-data directory.
- An occupied administration port must produce **Attention required**, preserve configuration/database state, and avoid a crash-restart loop.
- A candidate configuration whose bot startup fails must restore the previous file and restart the last known valid configuration without retaining secret-bearing temporary files.
- Slow reconciliation or health unavailability must leave exactly one child in **Starting**; it must not trigger a duplicate process or destructive timeout.

---

## File Structure

### Node runtime

- `src/runtime/launch-options.ts` — parse `--config`, `--desktop`, and smoke-test arguments.
- `src/runtime/resources.ts` — derive immutable migration/view/public paths from the compiled application root.
- `src/runtime/control-channel.ts` — convert a `shutdown` line on standard input into one idempotent shutdown request.
- `src/runtime/health.ts` — own safe operational-state values and the health response contract.
- `src/runtime/startup-error.ts` — format field-level configuration failures without exposing values.
- `src/runtime/setup-credentials.ts` — stdin-only credential generation used by the launcher.
- `src/runtime/package-smoke.ts` — offline packaged-runtime verification with no Discord connection.
- `src/config.ts` — validate environment-only and explicit-file configuration, including desktop mode.
- `src/db/database.ts` — load migrations from an injected immutable directory.
- `src/web/server.ts` — use injected view/public paths and expose the safe health endpoint.
- `src/main.ts` — compose the app from launch options, resources, config, health, and control channel.
- `tsconfig.build.json` — compile runtime source only into `build/app`.
- `scripts/copy-runtime-assets.mjs` — copy migrations, views, and public files to `build/app/assets`.

### Windows launcher

- `launcher/HeraldOfJams.Launcher.slnx` — launcher/test solution.
- `launcher/src/HeraldOfJams.Launcher/HeraldOfJams.Launcher.csproj` — .NET 10 WinForms executable.
- `launcher/src/HeraldOfJams.Launcher/Program.cs` — normal and `--smoke-test` entrypoints.
- `launcher/src/HeraldOfJams.Launcher/Configuration/*` — paths, setup validation, env serialization, atomic activation/rollback, credential generation.
- `launcher/src/HeraldOfJams.Launcher/Runtime/*` — process, health, lifecycle state machine, logs, and single-instance signaling.
- `launcher/src/HeraldOfJams.Launcher/UI/*` — setup form and tray application context only.
- `launcher/src/HeraldOfJams.Launcher/Assets/herald.ico` — neutral H-monogram application/tray icon, replaceable without changing behavior.
- `launcher/test/HeraldOfJams.Launcher.Tests/*` — xUnit coverage for non-visual launcher behavior.

### Packaging and documentation

- `scripts/package-windows.ps1` — clean staging, verified Node download, launcher publish, smoke test, exclusion checks, and ZIP creation.
- `package.json` — production build, launcher test, and `package:win` commands plus deploy file allowlist.
- `.gitignore` — package staging/cache/artifact exclusions.
- `README.md` — portable-user quick start and developer commands.
- `docs/operations.md` — data paths, logs, reconfiguration, backup, package replacement, and recovery.

### Task 1: Runtime-only build and packaged resource paths

**Files:**
- Create: `src/runtime/resources.ts`
- Create: `test/runtime-resources.test.ts`
- Create: `tsconfig.build.json`
- Create: `scripts/copy-runtime-assets.mjs`
- Modify: `src/db/database.ts`
- Modify: `src/web/server.ts`
- Modify: `src/main.ts`
- Modify: `test/database.test.ts`
- Modify: `test/web-security.test.ts`
- Modify: `test/fixtures.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `RuntimeResources { migrationsDirectory: string; viewsDirectory: string; publicDirectory: string }`.
- Produces: `resolveRuntimeResources(applicationRoot: string): RuntimeResources`.
- Produces: `migrate(database: Database.Database, migrationsDirectory: string): void`.
- Produces: `AdminServerDependencies.resources: Pick<RuntimeResources, "viewsDirectory" | "publicDirectory">`.
- Produces: `corepack.cmd pnpm build` output rooted at `build/app`, with assets under `build/app/assets`.

- [ ] **Step 1: Write failing resource-path and injected-asset tests**

Add `resolveRuntimeResources()` assertions for an application root containing spaces and Unicode. Extend database tests to change the current working directory and migrate successfully from an explicitly supplied fixture directory. Extend web tests to render `/admin/login` and serve `/admin/static/admin.css` from injected directories rather than `process.cwd()`.

- [ ] **Step 2: Run the focused tests and confirm the current working-directory coupling fails**

Run: `corepack.cmd pnpm test -- test/runtime-resources.test.ts test/database.test.ts test/web-security.test.ts`

Expected: FAIL because the resolver and injected resource arguments do not exist and existing code reads `process.cwd()\src`.

- [ ] **Step 3: Implement the resource interfaces and injection points**

Add the exact interfaces above. Require `migrate()` and `buildAdminServer()` callers to supply immutable resource paths. Derive the application root from the compiled entrypoint in `main.ts`; do not fall back to `process.cwd()` in packaged code.

- [ ] **Step 4: Add the production-only compiler and asset copier**

Make `tsconfig.build.json` extend the strict base config, set `rootDir` to `src`, `outDir` to `build/app`, include only `src/**/*.ts`, and exclude tests. Make the asset copier recreate `build/app/assets` and copy only `src/db/migrations`, `src/web/views`, and `src/web/public`. Set `package.json.files` to `build/app/**` and `LICENSE` so the later production deploy cannot copy source, tests, local data, or documentation by accident.

- [ ] **Step 5: Verify focused behavior and the production tree**

Run: `corepack.cmd pnpm test -- test/runtime-resources.test.ts test/database.test.ts test/web-security.test.ts`

Expected: PASS.

Run: `corepack.cmd pnpm build`

Expected: exit 0; `build/app/main.js`, migrations, Eta files, and CSS exist; `build/app/test` and `build/app/vitest.config.js` do not exist.

- [ ] **Step 6: Commit the runtime-resource slice**

```powershell
git add src/runtime/resources.ts src/db/database.ts src/web/server.ts src/main.ts test/runtime-resources.test.ts test/database.test.ts test/web-security.test.ts test/fixtures.ts tsconfig.build.json scripts/copy-runtime-assets.mjs package.json .gitignore
git commit -m "build: add packaged runtime asset layout"
```

### Task 2: File-backed configuration and setup credentials

**Files:**
- Create: `src/runtime/launch-options.ts`
- Create: `src/runtime/setup-credentials.ts`
- Create: `test/launch-options.test.ts`
- Create: `test/setup-credentials.test.ts`
- Modify: `src/config.ts`
- Modify: `src/main.ts`
- Modify: `src/web/server.ts`
- Modify: `src/web/auth.ts`
- Modify: `test/config.test.ts`
- Modify: `test/web-security.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `LaunchOptions { configPath?: string; desktop: boolean; smokeTest: boolean; smokeDataDirectory?: string }`.
- Produces: `parseLaunchOptions(args: readonly string[]): LaunchOptions`.
- Produces: `resolveConfig(options: LaunchOptions, env: NodeJS.ProcessEnv): AppConfig`.
- Preserves: `loadConfig(env: NodeJS.ProcessEnv): AppConfig` for environment-only callers/tests.
- Extends: `AppConfig.runtime` to `{ production: boolean; desktop: boolean }`.
- Produces executable: `build/app/runtime/setup-credentials.js`, reading one UTF-8 password from stdin and returning `{ passwordHash, sessionSecret }` JSON on stdout.

- [ ] **Step 1: Write failing launch-option and config-source tests**

Cover `--config <absolute path>`, `--desktop`, missing option values, unknown arguments, and duplicate arguments. In `test/config.test.ts`, prove an explicit file is authoritative even when conflicting process variables exist, omitted `DATABASE_PATH` defaults beside the config file, and environment-only configuration remains unchanged.

- [ ] **Step 2: Add Review Focus configuration corruption cases**

Assert explicit-file loading rejects NUL and malformed lines without echoing values. Add desktop tests proving non-decimal application/guild IDs, non-loopback host, `TRUST_PROXY=true`, or `ADMIN_SECURE_COOKIE=true` fail by field name. Add a server-production regression proving HTTPS/trusted-proxy requirements remain intact.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `corepack.cmd pnpm test -- test/launch-options.test.ts test/config.test.ts test/web-security.test.ts test/setup-credentials.test.ts`

Expected: FAIL because file-backed config, desktop mode, and credential CLI do not exist.

- [ ] **Step 4: Implement argument parsing and authoritative file loading**

Use Node's native env-file parser on the explicitly named file. Do not merge process variables into explicit-file values. In desktop mode require `NODE_ENV=production`, loopback host, port 1–65535, `ADMIN_SECURE_COOKIE=false`, and `TRUST_PROXY=false`. Default the database to `<config-directory>\herald-of-jams.sqlite` only when the explicit file omits `DATABASE_PATH`.

- [ ] **Step 5: Implement the stdin-only credential helper**

Export the existing `hashPassword(password: string): Promise<string>` contract from `src/web/auth.ts`. The helper reads the password from stdin, generates a 32-byte random session secret, writes only JSON containing the hash and Base64 secret, clears its local password reference, and returns nonzero on empty input. It never accepts a password argument.

- [ ] **Step 6: Verify config and credential behavior**

Run: `corepack.cmd pnpm test -- test/launch-options.test.ts test/config.test.ts test/web-security.test.ts test/setup-credentials.test.ts`

Expected: PASS with no secret value in captured errors or snapshots.

Run: `corepack.cmd pnpm build`

Expected: the runtime credential helper is emitted and accepts a password only through stdin.

- [ ] **Step 7: Commit file-backed configuration**

```powershell
git add src/config.ts src/runtime/launch-options.ts src/runtime/setup-credentials.ts src/main.ts src/web/server.ts src/web/auth.ts test/launch-options.test.ts test/config.test.ts test/web-security.test.ts test/setup-credentials.test.ts package.json
git commit -m "feat: load persistent desktop configuration"
```

### Task 3: Health, safe startup diagnostics, and control channel

**Files:**
- Create: `src/runtime/health.ts`
- Create: `src/runtime/control-channel.ts`
- Create: `src/runtime/startup-error.ts`
- Create: `test/runtime-control.test.ts`
- Modify: `src/main.ts`
- Modify: `src/web/server.ts`
- Modify: `test/application-integration.test.ts`
- Modify: `test/web-security.test.ts`

**Interfaces:**
- Produces: `OperationalState = "starting" | "reconciling" | "ready" | "degraded"`.
- Produces: `RuntimeHealth.set(state: OperationalState): void` and `RuntimeHealth.snapshot(): { status: OperationalState }`.
- Produces: `installControlChannel(input: NodeJS.ReadableStream, requestShutdown: () => Promise<void>): () => void`.
- Produces: `formatStartupError(error: unknown): string` that exposes approved configuration validation messages and otherwise only an error class/code.
- Extends: `AdminServerDependencies.health: () => { status: OperationalState }`.

- [ ] **Step 1: Write failing health and control tests**

Use a `PassThrough` stream to assert that fragmented input forming `shutdown\r\n` requests shutdown exactly once, unknown lines are ignored, EOF does not shut down, and repeated shutdown requests remain idempotent. Assert `/health` returns only `{ status }` for each state and contains no config/Discord/database fields.

- [ ] **Step 2: Add lifecycle and safe-error tests**

Extend `ApplicationRuntime` tests to assert state transitions `starting -> reconciling -> ready`, `degraded` when the critical-failure callback becomes true, and unchanged startup/shutdown ordering. Assert config failures include invalid field names but not values, while arbitrary exceptions expose no message or stack.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `corepack.cmd pnpm test -- test/runtime-control.test.ts test/application-integration.test.ts test/web-security.test.ts test/config.test.ts`

Expected: FAIL because the health/control/error contracts are absent.

- [ ] **Step 4: Implement health, control, and error boundaries**

Keep the existing HTTP-start gate after Discord reconciliation. Before the endpoint is reachable, the launcher interprets connection refusal as **Starting**; once listening, `/health` returns the current safe snapshot. Wire stdin shutdown only for `--desktop`, while retaining SIGINT/SIGTERM in every mode.

- [ ] **Step 5: Verify runtime control behavior**

Run: `corepack.cmd pnpm test -- test/runtime-control.test.ts test/application-integration.test.ts test/web-security.test.ts test/config.test.ts`

Expected: PASS; shutdown ordering remains HTTP, Discord, drain, database.

- [ ] **Step 6: Commit the desktop runtime control contract**

```powershell
git add src/runtime/health.ts src/runtime/control-channel.ts src/runtime/startup-error.ts src/main.ts src/web/server.ts test/runtime-control.test.ts test/application-integration.test.ts test/web-security.test.ts test/config.test.ts
git commit -m "feat: expose desktop runtime controls"
```

### Task 4: Offline packaged-runtime smoke entrypoint

**Files:**
- Create: `src/runtime/package-smoke.ts`
- Create: `test/package-smoke.test.ts`
- Modify: `src/runtime/launch-options.ts`
- Modify: `src/main.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `runPackageSmokeTest(options: { dataDirectory: string; resources: RuntimeResources }): Promise<void>`.
- Produces CLI: `node app/main.js --smoke-test --data-dir <absolute-temporary-directory>`.
- Guarantees: no Discord client creation, command registration, Gateway connection, or network dependency.

- [ ] **Step 1: Write the failing offline smoke test**

In a temporary directory, assert the smoke runner loads `better-sqlite3`, migrates a new database, renders `/admin/login`, serves `admin.css`, closes the server/database, removes SQLite sidecars, and writes nothing under the immutable application root.

- [ ] **Step 2: Add read-only Unicode package-path coverage**

Copy the built application/assets into a path containing spaces and non-ASCII characters, remove write permission where the test platform supports it, and assert smoke output is confined to the supplied data directory. This pins the second Review Focus item.

- [ ] **Step 3: Run focused tests and confirm failure**

Run: `corepack.cmd pnpm test -- test/package-smoke.test.ts test/runtime-resources.test.ts`

Expected: FAIL because the smoke entrypoint does not exist.

- [ ] **Step 4: Implement the offline smoke path**

Branch before `composeApplication()` creates Discord objects. Use a fixed fake desktop config containing no live identifiers, Fastify injection rather than a public listener, and an isolated SQLite file. Emit one short success line and no paths containing user names or secrets.

- [ ] **Step 5: Verify the packaged-runtime smoke contract**

Run: `corepack.cmd pnpm build`

Run: `node build/app/main.js --smoke-test --data-dir "$env:TEMP\herald-package-smoke"`

Expected: exit 0 with the success line; no Discord request; no write under `build/app`.

- [ ] **Step 6: Commit the smoke entrypoint**

```powershell
git add src/runtime/package-smoke.ts src/runtime/launch-options.ts src/main.ts test/package-smoke.test.ts package.json
git commit -m "test: add offline package smoke entrypoint"
```

### Task 5: Launcher configuration core

**Files:**
- Create: `launcher/HeraldOfJams.Launcher.slnx`
- Create: `launcher/src/HeraldOfJams.Launcher/HeraldOfJams.Launcher.csproj`
- Create: `launcher/src/HeraldOfJams.Launcher/Configuration/LauncherPaths.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Configuration/SetupInput.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Configuration/SetupValidator.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Configuration/EnvFileSerializer.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Configuration/EnvFileReader.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Configuration/AtomicConfigurationStore.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Configuration/CredentialGenerator.cs`
- Create: `launcher/test/HeraldOfJams.Launcher.Tests/HeraldOfJams.Launcher.Tests.csproj`
- Create: `launcher/test/HeraldOfJams.Launcher.Tests/ConfigurationTests.cs`

**Interfaces:**
- Produces: `LauncherPaths.ForLocalApplicationData(string localApplicationData): LauncherPaths`.
- Produces: `SetupInput(string DiscordToken, string ApplicationId, string GuildId, string AdminPassword, int AdminPort)`.
- Produces: `SetupValidator.Validate(SetupInput): IReadOnlyList<ValidationIssue>`.
- Produces: `EnvFileSerializer.Serialize(ValidatedSetup, GeneratedCredentials): string` with fixed desktop fields.
- Produces: `EnvFileReader.Read(string path): StoredConfiguration`, exposing non-secret edit values while keeping token/hash/session secret in an internal preservation object that UI controls never receive.
- Produces: `AtomicConfigurationStore.StageAsync(string): Task<ConfigurationCandidate>`; candidate supports `Activate()`, `Commit()`, and `Rollback()`.
- Produces: `ICredentialGenerator.GenerateAsync(string password, CancellationToken): Task<GeneratedCredentials>`; implementation invokes bundled Node helper with password on stdin only.

- [ ] **Step 1: Scaffold the .NET 10 solution and failing configuration tests**

Create a WinForms `WinExe` project targeting `net10.0-windows` and an xUnit test project. Tests assert the exact `%LOCALAPPDATA%\Herald of Jams` paths and fixed filenames from the spec.

- [ ] **Step 2: Add setup-validation and env-safety tests**

Assert empty token/password, non-decimal IDs, ports outside 1–65535, and any CR, LF, NUL, or quote in serialized input are rejected. Assert `$` in the generated scrypt hash and Base64 padding round-trip through Node's config loader. Assert the reader returns editable IDs/port but never exposes secret values to the setup view model. Assert validation errors contain field names and never rejected values.

- [ ] **Step 3: Add atomic-file and rollback tests**

Using a temporary directory, prove candidate staging leaves the active file unchanged, activation preserves one rollback copy, commit removes temporary/rollback files, and rollback restores byte-identical prior content. Simulate replacement failure and assert the active file survives.

- [ ] **Step 4: Run tests and confirm failure**

Run: `dotnet test launcher/HeraldOfJams.Launcher.slnx --configuration Release`

Expected: FAIL because the configuration classes are not implemented.

- [ ] **Step 5: Implement the minimal configuration core**

Write fixed desktop output: `NODE_ENV=production`, loopback host, selected port, `ADMIN_SECURE_COOKIE=false`, and `TRUST_PROXY=false`; omit `DATABASE_PATH` so the Node file loader applies the stable sibling default. Parse only the fixed known keys when reopening configuration, and keep preserved secrets outside the UI model. Use same-directory temporary files and atomic replacement. Never retain the plaintext password in a stored configuration model.

- [ ] **Step 6: Implement the Node credential-process adapter**

Start the exact bundled `runtime\node.exe` and `app\runtime\setup-credentials.js`; redirect stdin/stdout/stderr; send the password through stdin; parse the bounded JSON response; reject extra output; do not include the password in `ProcessStartInfo`, exceptions, or logs.

- [ ] **Step 7: Verify launcher configuration tests**

Run: `dotnet test launcher/HeraldOfJams.Launcher.slnx --configuration Release`

Expected: PASS.

- [ ] **Step 8: Commit the launcher configuration core**

```powershell
git add launcher
git commit -m "feat: add tray configuration core"
```

### Task 6: Launcher process supervision, health, logs, and rollback

**Files:**
- Create: `launcher/src/HeraldOfJams.Launcher/Runtime/BotProcess.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Runtime/BotHealthProbe.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Runtime/BotSupervisor.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Runtime/LauncherState.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Runtime/RotatingLogWriter.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Runtime/ReconfigurationCoordinator.cs`
- Create: `launcher/test/HeraldOfJams.Launcher.Tests/BotSupervisorTests.cs`
- Create: `launcher/test/HeraldOfJams.Launcher.Tests/RotatingLogWriterTests.cs`
- Create: `launcher/test/HeraldOfJams.Launcher.Tests/ReconfigurationTests.cs`

**Interfaces:**
- Produces: `LauncherState = Stopped | Starting | Running | AttentionRequired | Stopping`.
- Produces: `BotProcess.Start(BotStartOptions): IBotProcess`, with redirected stdio, hidden window, package working directory, and arguments containing only config path/mode.
- Produces: `BotSupervisor.StartAsync()`, `RestartAsync()`, `StopAsync()`, `StateChanged`, and `CurrentState`.
- Produces: `ReconfigurationCoordinator.ApplyAsync(SetupInput, CancellationToken): Task<ReconfigurationResult>`.
- Produces: `RotatingLogWriter` capped at five 5 MiB files.

- [ ] **Step 1: Write the failing lifecycle state-machine tests**

With fake process/health/clock implementations, assert connection refusal keeps one child in **Starting**, `ready` transitions to **Running**, a normal requested exit becomes **Stopped**, and an occupied port/config exit becomes **AttentionRequired** without retries.

- [ ] **Step 2: Add bounded-crash and slow-start Review Focus tests**

Assert unexpected exits retry after 1, 5, then 15 seconds, stop after three failed restarts, and reset the budget only after five continuous healthy minutes. Assert five minutes of unavailable health does not start a second child or kill the first; it changes the visible state to **AttentionRequired** while continuing to observe that child.

- [ ] **Step 3: Add shutdown and log tests**

Assert stop writes exactly `shutdown\n`, waits up to 15 seconds, logs before forced termination, and never forces a process that exits in time. Assert log rollover at 5 MiB keeps at most five files and redacts configured token/hash/secret values from both streams.

- [ ] **Step 4: Add transactional reconfiguration tests**

Assert valid candidate -> clean stop -> activate -> successful start -> commit. Assert candidate startup failure -> stop candidate -> rollback -> successful old start, with no candidate/rollback file left. Assert rollback restart failure reports both safe failure classes without deleting the restored config or database.

- [ ] **Step 5: Run tests and confirm failure**

Run: `dotnet test launcher/HeraldOfJams.Launcher.slnx --configuration Release`

Expected: FAIL because supervision classes do not exist.

- [ ] **Step 6: Implement hidden child-process and health adapters**

Launch only `<package>\runtime\node.exe <package>\app\main.js --config <local config> --desktop`, with `UseShellExecute=false`, `CreateNoWindow=true`, redirected stdio, and package `app` as working directory. Poll `http://127.0.0.1:<port>/health` every 500 ms with a short request timeout and accept only the exact health schema.

- [ ] **Step 7: Implement supervisor, rotating logs, and reconfiguration coordinator**

Keep policy in `BotSupervisor`; keep `BotProcess` as an adapter. Classify deterministic startup/config/port failures as non-retryable from safe child exit metadata rather than matching secret-bearing raw logs. Implement the exact retry, healthy-reset, log, and shutdown values pinned above.

- [ ] **Step 8: Verify launcher runtime tests**

Run: `dotnet test launcher/HeraldOfJams.Launcher.slnx --configuration Release`

Expected: PASS, including the occupied-port, candidate-rollback, and slow-start Review Focus cases owned by this task.

- [ ] **Step 9: Commit process supervision**

```powershell
git add launcher/src/HeraldOfJams.Launcher/Runtime launcher/test/HeraldOfJams.Launcher.Tests
git commit -m "feat: supervise packaged bot runtime"
```

### Task 7: Single-instance Windows tray and setup UI

**Files:**
- Create: `launcher/src/HeraldOfJams.Launcher/Program.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Runtime/SingleInstanceCoordinator.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/UI/SetupForm.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/UI/TrayApplicationContext.cs`
- Create: `launcher/src/HeraldOfJams.Launcher/Assets/herald.ico`
- Create: `launcher/test/HeraldOfJams.Launcher.Tests/SingleInstanceTests.cs`
- Create: `launcher/test/HeraldOfJams.Launcher.Tests/BrowserLaunchTests.cs`
- Modify: `launcher/src/HeraldOfJams.Launcher/HeraldOfJams.Launcher.csproj`

**Interfaces:**
- Produces: `SingleInstanceCoordinator.TryBecomePrimary()` and `SignalOpenAdministrationAsync()` over a per-user mutex/named pipe.
- Produces: `SetupForm` returning `SetupInput` while preserving unchanged masked secrets during edit.
- Produces: `TrayApplicationContext` binding launcher state to icon/tooltip/menu availability.
- Produces menu commands: Open administration, Configure, Open data folder, Open logs, Restart bot, Exit.

- [ ] **Step 1: Write failing single-instance and browser-boundary tests**

Assert a second coordinator cannot become primary, its signal reaches exactly one primary handler, and abandoned ownership recovers. Assert browser launch constructs only `http://127.0.0.1:<validated-port>/admin`; reject host/path overrides and disable the action before ready.

- [ ] **Step 2: Run tests and confirm failure**

Run: `dotnet test launcher/HeraldOfJams.Launcher.slnx --configuration Release`

Expected: FAIL because the Windows host classes do not exist.

- [ ] **Step 3: Implement the first-run/edit setup form**

Use masked token/password controls. In edit mode, blank secret fields mean preserve the existing value; never prefill a secret into a control. Show field-level validation without values. Cancel leaves active configuration and running process unchanged.

- [ ] **Step 4: Implement tray application context and icon states**

Use the embedded neutral H icon for this release, with tooltip text distinguishing Starting, Running, and Attention required. Bind exact menu availability to supervisor state. `Exit` awaits shutdown before disposing the tray icon and message loop.

- [ ] **Step 5: Implement normal/secondary entrypoints**

Primary invocation starts the WinForms message loop and setup/startup flow. Secondary invocation signals Open administration and exits. Unhandled UI exceptions move to **Attention required**, log safe details, and keep the tray available when recovery is possible.

- [ ] **Step 6: Verify launcher tests and publishability**

Run: `dotnet test launcher/HeraldOfJams.Launcher.slnx --configuration Release`

Run: `dotnet publish launcher/src/HeraldOfJams.Launcher/HeraldOfJams.Launcher.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true`

Expected: tests PASS and publish emits `Herald of Jams.exe` without requiring an installed target runtime.

- [ ] **Step 7: Commit the Windows tray shell**

```powershell
git add launcher
git commit -m "feat: add Windows tray launcher"
```

### Task 8: Reproducible Windows ZIP pipeline and launcher smoke mode

**Files:**
- Create: `scripts/package-windows.ps1`
- Create: `launcher/src/HeraldOfJams.Launcher/Runtime/PackageSmokeRunner.cs`
- Create: `launcher/test/HeraldOfJams.Launcher.Tests/PackageSmokeRunnerTests.cs`
- Modify: `launcher/src/HeraldOfJams.Launcher/Program.cs`
- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `.gitignore`

**Interfaces:**
- Produces command: `corepack.cmd pnpm package:win`.
- Produces launcher command: `Herald of Jams.exe --smoke-test --data-dir <absolute temporary directory>`.
- Produces artifact: `artifacts/herald-of-jams-<package.json version>-win-x64.zip`.

- [ ] **Step 1: Write failing launcher smoke-runner tests**

Assert the runner validates required package files, invokes bundled Node's offline smoke path, forwards only a temporary data directory, fails on extra/missing files or nonzero child exit, and detects any package-tree mutation by comparing before/after manifests.

- [ ] **Step 2: Run tests and confirm failure**

Run: `dotnet test launcher/HeraldOfJams.Launcher.slnx --configuration Release`

Expected: FAIL because package smoke mode does not exist.

- [ ] **Step 3: Implement launcher `--smoke-test` mode**

Run without WinForms or tray creation. Emit one bounded success/failure line, propagate a nonzero exit code, clean the temporary data directory, and never read `%LOCALAPPDATA%` or connect to Discord.

- [ ] **Step 4: Implement clean staging and locked production deploy**

Have `package-windows.ps1` resolve the repository root, use a fresh repository-local ignored staging directory, run tests/typecheck/build, and execute `corepack.cmd pnpm --filter herald-of-jams --prod deploy <deploy-dir>`. Copy only the deployed runtime tree/assets into final `app`.

- [ ] **Step 5: Implement verified Node and launcher assembly**

Read the exact version from `.node-version`; download `node-v<version>-win-x64.zip` plus `SHASUMS256.txt` from that version's official Node release directory; compare `Get-FileHash -Algorithm SHA256`; fail before extraction on mismatch. Publish the launcher self-contained/single-file and copy LICENSE plus a VERSION file containing app, Node, .NET target, and commit identifiers.

- [ ] **Step 6: Add package exclusions and fail-closed scans**

Fail if staging includes `.env`, `config.env`, SQLite/database sidecars, logs, test directories, source maps, live-looking Discord token assignments, or files outside the declared package manifest. Do not print matching secret-like content.

- [ ] **Step 7: Run smoke test and create ZIP**

Run the staged `Herald of Jams.exe --smoke-test` against a fresh temporary directory. Only after success, create `artifacts/herald-of-jams-<version>-win-x64.zip` and print its path, size, and SHA-256.

- [ ] **Step 8: Verify the full package command**

Run: `corepack.cmd pnpm package:win`

Expected: exit 0; exactly one versioned ZIP; smoke test passes; extracted package contains launcher/runtime/app/LICENSE/VERSION and no mutable or secret files.

- [ ] **Step 9: Commit the package pipeline**

```powershell
git add scripts/package-windows.ps1 launcher/src/HeraldOfJams.Launcher/Runtime/PackageSmokeRunner.cs launcher/test/HeraldOfJams.Launcher.Tests/PackageSmokeRunnerTests.cs launcher/src/HeraldOfJams.Launcher/Program.cs package.json pnpm-workspace.yaml .gitignore
git commit -m "build: package portable Windows tray app"
```

### Task 9: Operator documentation and complete verification

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `.env.example`
- Test: all Node, launcher, package, and manual checks below

**Interfaces:**
- Consumes: every prior task's stable commands and paths.
- Produces: end-user portable quick start and operator recovery instructions.

- [ ] **Step 1: Update portable quick-start documentation**

Document unzip -> run `Herald of Jams.exe` -> complete setup -> use tray. State that configuration/database/logs live under `%LOCALAPPDATA%\Herald of Jams` and package replacement cannot migrate/delete them. Explain that the token remains sensitive even though setup persists it.

- [ ] **Step 2: Update developer and server-mode documentation**

Document `pnpm build`, direct environment-only startup, explicit `--config`, `package:win`, required .NET 10 SDK for builders, pinned Node download/checksum behavior, and why source-relative database paths must not be used operationally.

- [ ] **Step 3: Update operations and recovery documentation**

Document tray states/commands, log paths/rotation, transactional reconfiguration and rollback, clean exit, crash retry budget, package smoke mode, stable SQLite backup with WAL/SHM, and safe package replacement. Preserve the existing dedicated-test-server authorization boundary.

- [ ] **Step 4: Run all automated verification**

Run: `corepack.cmd pnpm test`

Expected: all Vitest files/tests pass.

Run: `corepack.cmd pnpm typecheck`

Expected: exit 0.

Run: `corepack.cmd pnpm build`

Expected: exit 0 with runtime-only output and copied assets.

Run: `dotnet test launcher/HeraldOfJams.Launcher.slnx --configuration Release`

Expected: all launcher tests pass.

Run: `corepack.cmd pnpm package:win`

Expected: exit 0 and a smoke-tested, checksummed ZIP.

Run: `git diff --check`

Expected: no output.

- [ ] **Step 5: Perform offline manual Windows acceptance**

Extract the ZIP to a path with spaces, launch without a developer terminal, complete setup using non-production placeholder credentials only where startup is expected to fail safely, inspect tray state/log links, restart/reconfigure/exit, and verify no console window or package-local mutable file appears. Replace the extracted package and confirm local configuration remains.

- [ ] **Step 6: Record the live-validation boundary**

Do not perform live Discord testing without explicit authorization for the dedicated test server/channel. Record unexecuted Discord connection, permission, reconciliation, gameplay, and restart checks as pending rather than passing.

- [ ] **Step 7: Commit documentation and verification record**

```powershell
git add README.md docs/operations.md .env.example
git commit -m "docs: explain portable tray operation"
```

## Final Acceptance Checklist

- [ ] `Herald of Jams.exe` runs from the extracted ZIP without installed Node.js or .NET.
- [ ] First-run setup persists configuration under `%LOCALAPPDATA%\Herald of Jams` without persisting the plaintext administrator password.
- [ ] Relaunch reuses configuration and SQLite state without PowerShell environment setup.
- [ ] The package can move or be replaced without losing local application data.
- [ ] The tray remains single-instance and exposes the approved commands/states.
- [ ] Administration opens only the fixed loopback URL in the default browser.
- [ ] Graceful shutdown drains the existing Node runtime before launcher exit.
- [ ] Candidate startup failure rolls back configuration and restores the last valid runtime when possible.
- [ ] Logs rotate, remain bounded, and contain no configured secrets.
- [ ] The production package excludes tests, source-only files, mutable state, and credentials.
- [ ] The packaged smoke test proves Node, better-sqlite3, migrations, views, CSS, and clean shutdown offline.
- [ ] All automated checks pass from a clean checkout.
- [ ] Live Discord checks are either authorized and recorded or explicitly left pending.

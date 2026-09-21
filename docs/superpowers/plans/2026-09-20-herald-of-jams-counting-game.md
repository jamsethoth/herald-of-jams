# Herald of Jams Counting Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single-server Discord counting game, durable scoring system, reconnect reconciliation, and private administration interface defined by the approved design.

**Architecture:** Keep parsing, compilation, scoring, and the game state machine as pure TypeScript. A synchronous SQLite repository owns all durable state transitions and ordered outbox creation, while thin Discord and Fastify adapters translate external events into application commands. One serialized executor linearizes live messages, reconciliation, and administrative round commands for the configured channel.

**Tech Stack:** Node.js 24.21.0 LTS, TypeScript 7.0.2, pnpm 12.5.1, discord.js 14.27.0, Fastify 5.12.5 with Eta 4.6.0, better-sqlite3 13.0.3, Zod 4.6.5, and Vitest 5.0.1.

**Spec:** `docs/superpowers/specs/2026-09-20-herald-of-jams-counting-game-design.md`

> **Revision:** Announcement configuration, one-value rounds, and cancellation penalty semantics in this original plan are superseded by `docs/superpowers/plans/2026-09-21-configurable-announcements-and-cancellation.md`. Completed task history remains unchanged.

## Global Constraints

- One Discord server, one configured game channel, and at most one active round.
- Use Node.js `24.21.0`, declared in `.nvmrc`, `.node-version`, and `package.json#engines`.
- Pin every dependency exactly; do not use `^`, `~`, `latest`, or floating workspace ranges.
- Use ASCII decimal input (`^[0-9]+$`) and never coerce an unchecked digit string through `Number` before safe-range validation.
- Keep all Discord message IDs and user IDs as strings; compare message order with `BigInt(id)` only.
- Keep domain modules independent of Fastify, discord.js, and SQLite.
- Use one SQLite connection with `foreign_keys = ON`, WAL mode, and `busy_timeout = 5000`.
- Never hold a SQLite transaction open across a Discord or HTTP call.
- Never log, persist, or return the Discord token, administrator password material, or session secret.
- Production administration is HTTPS-only through an explicitly trusted proxy; insecure cookies are loopback-development-only.
- Do not create a Discord application, invite a bot, expose the administration interface publicly, or add real credentials.
- Use `corepack.cmd pnpm` commands on Windows.

## Review Focus

- A digit string with hundreds of thousands of characters must be rejected as out of range without high CPU use, precision loss, or process failure; Task 2 pins this with a bounded-length parser test.
- The same Discord message arriving through history reconciliation and the live Gateway must affect state and score once; Tasks 5 and 8 pin this with duplicate-ID integration tests.
- A Discord create request accepted remotely but followed by a lost response must not be blindly duplicated; Task 6 pins nonce reconciliation and the manual-review boundary.
- Completion followed by Discord downtime must block both season reset and new-round activation until terminal work is delivered or explicitly abandoned; Tasks 5 and 11 pin both guards.
- A forged forwarded-protocol header from an untrusted peer must not produce a production session cookie; Task 9 pins trusted-proxy and `Secure` cookie behavior.

---

## File Structure

```text
src/
  config.ts                         environment parsing and runtime policy
  main.ts                           process composition and shutdown
  domain/
    types.ts                        shared domain values and result unions
    numeric-submission.ts           strict digit parsing
    predicates.ts                   safe structured predicate evaluation
    round-compiler.ts               immutable finite sequence compilation
    scoring.ts                      participation and penalty calculations
    game-engine.ts                  pure round/attempt state machine
  db/
    database.ts                     SQLite opening, pragmas, and migration runner
    game-repository.ts              transactional game, score, and season state
    outbox-repository.ts            ordered outbound operation persistence
    admin-repository.ts             templates, sessions, audits, and query views
    migrations/001-initial.sql      complete relational schema
  application/
    contracts.ts                    adapter-facing command and transport interfaces
    serial-executor.ts              channel command linearization
    game-service.ts                 transactional orchestration
    outbox-dispatcher.ts            ordered, recoverable Discord effects
    reconciliation-service.ts       history catch-up and invalidation
  discord/
    discord-transport.ts            discord.js implementation of transport contract
    discord-adapter.ts              Gateway and slash-command wiring
    permissions.ts                  activation capability validation
  web/
    server.ts                       Fastify construction and security plugins
    auth.ts                         scrypt verification, login, sessions, throttling
    routes/
      dashboard.ts                  status overview
      templates.ts                  template CRUD and preview
      rounds.ts                     activate, pause, resume, cancel
      moderation.ts                 round bans
      leaderboard.ts                current/archive/reset views
      operations.ts                 audit and outbox recovery views
    views/                           Eta layouts and pages
    public/admin.css                 private interface styling
scripts/hash-admin-password.mjs      offline password-hash generator
test/
  fixtures.ts                        deterministic builders and clocks
  fake-discord-transport.ts          controllable Discord test double
  *.test.ts                          unit and integration suites by component
```

### Task 1: Project foundation and validated configuration

**Files:**
- Create: `package.json`
- Create: `pnpm-lock.yaml`
- Create: `.nvmrc`
- Create: `.node-version`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/config.ts`
- Create: `test/config.test.ts`

**Interfaces:**
- Produces: `loadConfig(env: NodeJS.ProcessEnv): AppConfig`
- Produces: `AppConfig` with `discord`, `database`, `admin`, and `runtime` sections.

- [ ] **Step 1: Add the pinned package manifest and compiler configuration**

Use these exact dependency versions:

```json
{
  "name": "herald-of-jams",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@12.5.1",
  "engines": { "node": "24.21.0" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run",
    "start": "node dist/main.js"
  },
  "dependencies": {
    "@fastify/cookie": "11.1.2",
    "@fastify/csrf-protection": "8.0.1",
    "@fastify/formbody": "9.0.0",
    "@fastify/helmet": "13.1.1",
    "@fastify/rate-limit": "11.2.0",
    "@fastify/session": "11.1.3",
    "@fastify/static": "10.1.4",
    "@fastify/view": "12.0.0",
    "better-sqlite3": "13.0.3",
    "discord.js": "14.27.0",
    "eta": "4.6.0",
    "fastify": "5.12.5",
    "zod": "4.6.5"
  },
  "devDependencies": {
    "@types/better-sqlite3": "9.6.0",
    "@types/node": "24.13.6",
    "typescript": "7.0.2",
    "vitest": "5.0.1"
  }
}
```

Set TypeScript to `module`/`moduleResolution: "NodeNext"`, `target: "ES2024"`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `rootDir: "."`, and `outDir: "dist"`. Ignore `node_modules/`, `dist/`, `.env`, `data/`, and SQLite sidecar files.

- [ ] **Step 2: Install and verify the empty project**

Run: `corepack.cmd pnpm install --frozen-lockfile=false`

Expected: dependencies install and `pnpm-lock.yaml` is created with exact direct versions.

Run: `corepack.cmd pnpm typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Write failing configuration tests**

```ts
it("rejects production without trusted proxy and HTTPS cookie policy", () => {
  expect(() => loadConfig(validEnv({ NODE_ENV: "production", TRUST_PROXY: "false" })))
    .toThrow(/TRUST_PROXY/);
});

it("does not include secret values in validation errors", () => {
  const secret = "do-not-echo-this-secret";
  expect(captureError(() => loadConfig(validEnv({ SESSION_SECRET: secret, ADMIN_PORT: "bad" }))))
    .not.toContain(secret);
});
```

- [ ] **Step 4: Implement `loadConfig` with Zod**

```ts
export interface AppConfig {
  discord: { token: string; applicationId: string; guildId: string };
  database: { path: string };
  admin: {
    host: string; port: number; passwordHash: string; sessionSecret: string;
    secureCookie: boolean; trustProxy: boolean;
  };
  runtime: { production: boolean };
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig;
```

Require `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `DATABASE_PATH`, `ADMIN_PASSWORD_HASH`, and a session secret of at least 32 bytes. Permit `ADMIN_SECURE_COOKIE=false` only when `ADMIN_HOST` is `127.0.0.1`, `::1`, or `localhost` and production is false.

- [ ] **Step 5: Run foundation verification**

Run: `corepack.cmd pnpm test -- test/config.test.ts`

Expected: PASS.

Run: `corepack.cmd pnpm typecheck`

Expected: PASS.

- [ ] **Step 6: Commit the foundation**

```powershell
git add package.json pnpm-lock.yaml .nvmrc .node-version tsconfig.json vitest.config.ts .gitignore .env.example src/config.ts test/config.test.ts
git commit -m "chore: scaffold counting game service"
```

### Task 2: Numeric parsing, predicates, and round compilation

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/numeric-submission.ts`
- Create: `src/domain/predicates.ts`
- Create: `src/domain/round-compiler.ts`
- Create: `test/numeric-submission.test.ts`
- Create: `test/round-compiler.test.ts`

**Interfaces:**
- Produces: `parseNumericSubmission(content: string): NumericParseResult`
- Produces: `matchesPredicate(value: number, predicate: RulePredicate): boolean`
- Produces: `compileRound(input: RoundTemplateInput): CompiledRound`

- [ ] **Step 1: Define domain input and output types**

```ts
export type NumericParseResult =
  | { kind: "conversation" }
  | { kind: "safe_integer"; digits: string; value: number }
  | { kind: "out_of_range"; digits: string };

export type RulePredicate =
  | { kind: "prime" }
  | { kind: "divisible_by"; divisor: number }
  | { kind: "one_of"; values: readonly number[] }
  | { kind: "range"; minimum: number; maximum: number };

export interface RoundTemplateInput {
  name: string; notes?: string; channelId: string;
  start: number; target: number; step: number;
  skipRules: readonly RulePredicate[];
  bonusRules: readonly { id: string; predicate: RulePredicate }[];
}

export interface CompiledRound {
  input: Readonly<RoundTemplateInput>;
  entries: readonly { position: number; value: number; bonusRuleIds: readonly string[] }[];
}
```

- [ ] **Step 2: Write failing parser and predicate tests**

Cover empty text, whitespace, signs, decimals, exponent notation, Unicode digits, leading zeroes, `Number.MAX_SAFE_INTEGER`, one greater than it, and a 200,000-character digit string. The long input must return `out_of_range` without calling `Number` on the full string.

```ts
expect(parseNumericSubmission("001")).toEqual({ kind: "safe_integer", digits: "001", value: 1 });
expect(parseNumericSubmission("9007199254740992")).toEqual({ kind: "out_of_range", digits: "9007199254740992" });
expect(parseNumericSubmission("１２")).toEqual({ kind: "conversation" });
```

- [ ] **Step 3: Implement bounded numeric parsing and predicates**

Reject non-ASCII content first. Strip leading zeroes to one zero, compare normalized length and lexicographic value against `"9007199254740991"`, and only then call `Number`. Implement primality with trial division through `Math.floor(Math.sqrt(value))`, rejecting values below two.

- [ ] **Step 4: Write failing compiler tests**

Test OR-combined skips, stacked bonuses, start inclusion even when it matches a skip, skipped target, unreachable target, unsafe inputs, invalid predicates, duplicate bonus IDs, more than 100,000 included entries, and more than 1,000,000 candidate entries.

```ts
expect(compileRound(template({ start: 1, target: 9, step: 2 })).entries.map(e => e.value))
  .toEqual([1, 3, 5, 7, 9]);
expect(() => compileRound(template({ start: 0, target: 1_000_001, step: 1 })))
  .toThrow(/1,000,000 candidate/);
```

- [ ] **Step 5: Implement compilation with explicit safety limits**

Validate reachability using `(target - start) % step === 0` before iteration. Set `MAX_INCLUDED_ENTRIES = 100_000` and `MAX_CANDIDATE_ENTRIES = 1_000_000`. Freeze copied rule arrays and compiled entries so template mutation cannot alter the result.

- [ ] **Step 6: Verify and commit the compiler slice**

Run: `corepack.cmd pnpm test -- test/numeric-submission.test.ts test/round-compiler.test.ts`

Expected: PASS.

Run: `corepack.cmd pnpm typecheck`

Expected: PASS.

```powershell
git add src/domain test/numeric-submission.test.ts test/round-compiler.test.ts
git commit -m "feat: compile safe immutable rounds"
```

### Task 3: Pure game engine and scoring

**Files:**
- Create: `src/domain/scoring.ts`
- Create: `src/domain/game-engine.ts`
- Create: `test/scoring.test.ts`
- Create: `test/game-engine.test.ts`

**Interfaces:**
- Consumes: `CompiledRound`, `NumericParseResult`
- Produces: `participationAwards(counts: ReadonlyMap<string, number>): ReadonlyMap<string, number>`
- Produces: `penaltySeverity(accepted: number, required: number): -2 | -3 | -4 | -5`
- Produces: `evaluateSubmission(state: EngineState, input: EngineInput): EngineDecision`

- [ ] **Step 1: Define state-machine contracts**

```ts
export type RoundState = "waiting_for_start" | "counting" | "paused" | "completed" | "cancelled";

export interface EngineState {
  roundState: RoundState;
  pausedFrom?: "waiting_for_start" | "counting";
  nextPosition: number;
  previousAcceptedPlayerId?: string;
  acceptedCount: number;
  bannedPlayerIds: ReadonlySet<string>;
}

export interface EngineInput {
  playerId: string;
  parsed: NumericParseResult;
  compiled: CompiledRound;
}

export type EngineDecision =
  | { kind: "conversation" }
  | { kind: "delete_without_effect"; reason: "waiting" | "paused" | "banned" }
  | { kind: "accepted"; position: number; bonusRuleIds: readonly string[]; completesRound: boolean }
  | { kind: "broken"; reason: "unexpected" | "same_player" | "out_of_range"; severity: -2 | -3 | -4 | -5 };
```

- [ ] **Step 2: Write failing exact-arithmetic scoring tests**

Exercise ratios immediately below, on, and above 75%, 110%, and 150% without floating-point arithmetic. Exercise penalty boundaries with cross multiplication: `accepted * 4 <= required`, `* 2 <=`, and `* 4 <= required * 3`. Verify worst-penalty deltas `0 -> -2`, `-2 -> -5` gives `-3`, and `-5 -> -3` gives `0`.

- [ ] **Step 3: Implement scoring functions**

```ts
export function participationAwards(counts: ReadonlyMap<string, number>): ReadonlyMap<string, 2 | 3 | 4 | 5>;
export function penaltySeverity(accepted: number, required: number): -2 | -3 | -4 | -5;
export function additionalPenalty(previous: 0 | -2 | -3 | -4 | -5, next: -2 | -3 | -4 | -5): 0 | -1 | -2 | -3 | -4 | -5;
```

- [ ] **Step 4: Write failing transition tests**

Cover start acceptance, wrong start deletion, normal acceptance, stacked bonus IDs, same-player break despite conversation, wrong/duplicate/skipped/out-of-range breaks, banned submission, paused deletion, target completion, pause/resume preservation, and terminal cancellation.

- [ ] **Step 5: Implement the pure state machine**

Return decisions without mutating inputs. Keep pause, resume, and cancellation as separate exported transition functions that reject illegal transitions with `DomainStateError`.

- [ ] **Step 6: Verify and commit domain behavior**

Run: `corepack.cmd pnpm test -- test/scoring.test.ts test/game-engine.test.ts`

Expected: PASS.

```powershell
git add src/domain/scoring.ts src/domain/game-engine.ts test/scoring.test.ts test/game-engine.test.ts
git commit -m "feat: add counting state machine and scoring"
```

### Task 4: SQLite schema and migration runner

**Files:**
- Create: `src/db/migrations/001-initial.sql`
- Create: `src/db/database.ts`
- Create: `test/database.test.ts`

**Interfaces:**
- Produces: `openDatabase(path: string): Database.Database`
- Produces: `migrate(database: Database.Database): void`

- [ ] **Step 1: Write failing migration tests**

Open a temporary database, run migrations twice, assert `PRAGMA foreign_keys = 1`, assert every required table and index exists, and prove duplicate Discord message IDs and duplicate `(channel_id, sequence_number)` pairs fail.

- [ ] **Step 2: Create the complete initial schema**

The migration must create these tables with foreign keys and checks:

```sql
schema_migrations(version PRIMARY KEY, applied_at NOT NULL);
seasons(id PRIMARY KEY, started_at NOT NULL, ended_at);
players(discord_user_id PRIMARY KEY, latest_display_name NOT NULL, updated_at NOT NULL);
round_templates(id PRIMARY KEY, private_name NOT NULL, notes, channel_id NOT NULL,
  start_value NOT NULL, target_value NOT NULL, step_value NOT NULL, rules_json NOT NULL,
  created_at NOT NULL, updated_at NOT NULL);
rounds(id PRIMARY KEY, template_id REFERENCES round_templates(id), season_id REFERENCES seasons(id),
  channel_id NOT NULL, state NOT NULL, paused_from_state, compiled_config_json NOT NULL,
  activated_at NOT NULL, completed_at, cancelled_at, operationally_settled_at);
compiled_entries(round_id REFERENCES rounds(id), position NOT NULL, value NOT NULL,
  bonus_rule_ids_json NOT NULL, PRIMARY KEY(round_id, position), UNIQUE(round_id, value));
attempts(id PRIMARY KEY, round_id REFERENCES rounds(id), state NOT NULL,
  started_at NOT NULL, ended_at, broken_by_submission_id);
submissions(message_id PRIMARY KEY, round_id REFERENCES rounds(id), attempt_id REFERENCES attempts(id),
  author_id NOT NULL, original_digits NOT NULL, normalized_value, decision NOT NULL, received_at NOT NULL);
attempt_contributions(attempt_id REFERENCES attempts(id), player_id REFERENCES players(discord_user_id),
  accepted_count NOT NULL, bonus_points NOT NULL, PRIMARY KEY(attempt_id, player_id));
round_player_penalties(round_id REFERENCES rounds(id), player_id REFERENCES players(discord_user_id),
  worst_severity NOT NULL, PRIMARY KEY(round_id, player_id));
round_bans(round_id REFERENCES rounds(id), player_id REFERENCES players(discord_user_id),
  banned_at NOT NULL, PRIMARY KEY(round_id, player_id));
score_ledger(id PRIMARY KEY, season_id REFERENCES seasons(id), round_id REFERENCES rounds(id),
  attempt_id REFERENCES attempts(id), player_id REFERENCES players(discord_user_id),
  entry_type NOT NULL, delta NOT NULL, source_key NOT NULL UNIQUE, created_at NOT NULL);
discord_outbox(id PRIMARY KEY, channel_id NOT NULL, sequence_number NOT NULL,
  predecessor_id REFERENCES discord_outbox(id), operation_type NOT NULL, payload_json NOT NULL,
  nonce NOT NULL UNIQUE, status NOT NULL, attempt_count NOT NULL DEFAULT 0, next_attempt_at,
  last_error, discord_message_id, created_at NOT NULL, resolved_at,
  UNIQUE(channel_id, sequence_number));
channel_checkpoints(channel_id PRIMARY KEY, last_examined_message_id NOT NULL, updated_at NOT NULL);
audit_events(id PRIMARY KEY, event_type NOT NULL, round_id REFERENCES rounds(id),
  actor_id, details_json NOT NULL, created_at NOT NULL);
admin_sessions(session_id PRIMARY KEY, data_json NOT NULL, expires_at NOT NULL);
login_attempts(key PRIMARY KEY, window_started_at NOT NULL, attempt_count NOT NULL, blocked_until);
```

Use `STRICT` tables, explicit allowed-value `CHECK` constraints for states/types, safe-integer checks, non-positive penalty checks, and indexes for active round, pending outbox, audit time, season totals, and session expiry.

- [ ] **Step 3: Implement database opening and transactional migrations**

Resolve migration files from `src/db/migrations` relative to `process.cwd()`. Apply each unapplied migration and its `schema_migrations` row in one transaction. Refuse unknown future schema versions.

- [ ] **Step 4: Verify and commit persistence foundation**

Run: `corepack.cmd pnpm test -- test/database.test.ts`

Expected: PASS.

```powershell
git add src/db/migrations/001-initial.sql src/db/database.ts test/database.test.ts
git commit -m "feat: add durable game schema"
```

### Task 5: Transactional game and season repository

**Files:**
- Create: `src/application/contracts.ts`
- Create: `src/db/game-repository.ts`
- Create: `src/db/admin-repository.ts`
- Create: `src/application/game-service.ts`
- Create: `test/fixtures.ts`
- Create: `test/game-service.test.ts`

**Interfaces:**
- Consumes: compiler, engine, scoring, open SQLite database.
- Produces: `GameService.processMessage(message: InboundDiscordMessage): Promise<MessageDisposition>`
- Produces: `activateRound`, `pauseRound`, `resumeRound`, `cancelRound`, `banPlayer`, `unbanPlayer`, and `resetSeason` methods.

- [ ] **Step 1: Define adapter-facing contracts**

```ts
export interface InboundDiscordMessage {
  id: string; channelId: string; authorId: string; displayName: string;
  content: string; createdAt: string;
}

export type MessageDisposition =
  | { kind: "conversation" }
  | { kind: "duplicate" }
  | { kind: "recorded"; decision: string; outboxOperationIds: readonly string[] };

export interface Clock { now(): Date }
export interface IdGenerator { next(): string }
```

- [ ] **Step 2: Write failing transaction tests**

Use a real temporary SQLite database. Test start acceptance creates attempt, submission, contribution, audit, and ordered canonical/delete outbox rows in one commit. Force an insert failure and prove none persist. Replay the same message ID and prove no state, ledger, or outbox duplication.

- [ ] **Step 3: Implement template, activation, and message transactions**

Use `database.transaction(...).immediate()` for every command. Persist the full compiled snapshot and entries on activation. In `processMessage`, load the active round and attempt, call the pure engine, then write submission/state/contribution/penalty/ledger/audit/outbox changes before commit.

- [ ] **Step 4: Write failing lifecycle and scoring integration tests**

Test pause/resume preservation, cancellation discarding provisional data and removing that round's penalties, completion appending participation and bonus ledger entries, bans, worst-penalty deltas, one active round, and season reset rejection while a round is active.

Also test both guards:

```ts
await expect(service.resetSeason()).rejects.toThrow(/terminal Discord work/);
await expect(service.activateRound(nextTemplateId)).rejects.toThrow(/terminal Discord work/);
```

- [ ] **Step 5: Implement administrative transactions and read models**

Make terminal completion/cancellation payloads immutable JSON in outbox rows. Mark a round operationally settled only when the required terminal chain is delivered or explicitly abandoned. Derive leaderboard totals with `SUM(score_ledger.delta)` grouped by Discord user ID.

- [ ] **Step 6: Verify and commit transactional behavior**

Run: `corepack.cmd pnpm test -- test/game-service.test.ts`

Expected: PASS.

```powershell
git add src/application/contracts.ts src/application/game-service.ts src/db/game-repository.ts src/db/admin-repository.ts test/fixtures.ts test/game-service.test.ts
git commit -m "feat: persist atomic game decisions"
```

### Task 6: Ordered Discord outbox dispatcher

**Files:**
- Create: `src/db/outbox-repository.ts`
- Create: `src/application/outbox-dispatcher.ts`
- Create: `test/fake-discord-transport.ts`
- Create: `test/outbox-dispatcher.test.ts`

**Interfaces:**
- Produces: `DiscordTransport`
- Produces: `OutboxDispatcher.dispatchNext(channelId: string): Promise<DispatchResult>`

- [ ] **Step 1: Define the transport contract and fake**

```ts
export interface DiscordTransport {
  sendMessage(input: {
    channelId: string; content: string; nonce: string;
    enforceNonce: true; suppressNotifications: boolean;
  }): Promise<{ id: string; nonce?: string }>;
  deleteMessage(channelId: string, messageId: string): Promise<"deleted" | "already_absent">;
  findOwnMessageByNonce(channelId: string, nonce: string, createdAfter: string): Promise<{ id: string } | null>;
  listMessagesAfter(channelId: string, afterMessageId: string | null): AsyncIterable<InboundDiscordMessage>;
  getLatestMessageId(channelId: string): Promise<string | null>;
}
```

The fake must script successes, definite failures, ambiguous failures after remote acceptance, message absence, and history pages.

- [ ] **Step 2: Write failing ordering and recovery tests**

Prove operation N+1 cannot run before N succeeds, restart resumes the first unresolved row, already-absent deletion succeeds, and a definite failure schedules bounded exponential retry with deterministic test clock values.

- [ ] **Step 3: Implement repository claiming and dispatcher ordering**

Claim only the lowest unresolved sequence whose predecessor is resolved. Store statuses `pending`, `delivering`, `delivered`, `retry_wait`, `needs_review`, `abandoned`. Reset stale `delivering` rows to reconciliation on startup; never send them blindly.

- [ ] **Step 4: Write the ambiguous-delivery regression test**

```ts
transport.acceptThenLoseResponse(operation.nonce);
await dispatcher.dispatchNext(channelId);
expect(transport.sentCount(operation.nonce)).toBe(1);
await dispatcher.dispatchNext(channelId);
expect(transport.sentCount(operation.nonce)).toBe(1);
expect(outbox.status(operation.id)).toBe("delivered");
```

Also test that no matching nonce outside Discord's enforceable uniqueness interval becomes `needs_review` rather than being resent.

- [ ] **Step 5: Implement nonce reconciliation and administrative resolution**

Use the stable outbox nonce for every create request. On an ambiguous result, search history by nonce. Automatically retry only inside a configurable five-minute uniqueness interval; otherwise require `markDelivered(discordMessageId)` or `abandon(reason, adminActor)` and create an audit event.

- [ ] **Step 6: Verify and commit the dispatcher**

Run: `corepack.cmd pnpm test -- test/outbox-dispatcher.test.ts`

Expected: PASS.

```powershell
git add src/db/outbox-repository.ts src/application/outbox-dispatcher.ts test/fake-discord-transport.ts test/outbox-dispatcher.test.ts
git commit -m "feat: deliver ordered Discord outbox work"
```

### Task 7: Live Discord adapter, permissions, and leaderboard command

**Files:**
- Create: `src/application/serial-executor.ts`
- Create: `src/discord/permissions.ts`
- Create: `src/discord/discord-transport.ts`
- Create: `src/discord/discord-adapter.ts`
- Create: `test/serial-executor.test.ts`
- Create: `test/permissions.test.ts`
- Create: `test/discord-adapter.test.ts`

**Interfaces:**
- Consumes: `GameService`, `OutboxDispatcher`, `DiscordTransport`.
- Produces: `SerialExecutor.run<T>(key: string, work: () => Promise<T>): Promise<T>`
- Produces: `validateActivationPermissions(channel): PermissionReport`
- Produces: `DiscordAdapter.start(): Promise<void>` and `stop(): Promise<void>`.

- [ ] **Step 1: Write failing serialization and permission tests**

Prove commands for one channel complete in enqueue order even when promises resolve out of order, while different keys may run concurrently. Verify missing View Channel, Read Message History, Send Messages, Manage Messages, application-command use, or Message Content intent blocks activation with a specific report.

- [ ] **Step 2: Implement the keyed executor and permission report**

Keep the executor generic and delete idle key tails to avoid memory growth. Make permission validation pure over a small capability input so tests do not require discord.js objects.

- [ ] **Step 3: Write failing adapter tests with a mocked discord.js client boundary**

Test wrong guild/channel, bot, and webhook messages are ignored; eligible player messages enter the serialized executor; duplicates return harmlessly; and adapter errors become audit/operational failures without leaking message content or secrets. Assert canonical, bonus, reset, completion, and leaderboard payloads contain no expected value, compiled sequence, or predicate data.

Store every delivered bot message ID on its outbox row. Emit a `messageDelete` test event for a stored canonical message ID and assert one private `canonical_message_deleted` audit event; deletions of unrelated messages must not create that event.

- [ ] **Step 4: Implement the Discord transport and Gateway wiring**

Request only `Guilds`, `GuildMessages`, and `MessageContent` intents. Convert Discord objects to `InboundDiscordMessage`, pass them through the shared executor, and wake the outbox dispatcher after committed work. Handle `messageDelete` by looking up the stored outbound Discord message ID and appending the canonical-deletion audit event without changing game history. Set `allowedMentions` to users only and set `SUPPRESS_NOTIFICATIONS` on canonical messages to avoid notification spam.

- [ ] **Step 5: Register and test `/leaderboard`**

Register one guild command at startup using the configured application and guild IDs. Render the current season from the repository, escape display text, paginate within Discord's 2,000-character limit, and return a friendly empty-season response.

- [ ] **Step 6: Verify and commit live Discord behavior**

Run: `corepack.cmd pnpm test -- test/serial-executor.test.ts test/permissions.test.ts test/discord-adapter.test.ts`

Expected: PASS.

```powershell
git add src/application/serial-executor.ts src/discord test/serial-executor.test.ts test/permissions.test.ts test/discord-adapter.test.ts
git commit -m "feat: connect live Discord gameplay"
```

### Task 8: Disconnect and startup reconciliation

**Files:**
- Create: `src/application/reconciliation-service.ts`
- Create: `test/reconciliation-service.test.ts`

**Interfaces:**
- Consumes: `DiscordTransport`, `GameService`, `SerialExecutor`, durable channel checkpoint.
- Produces: `ReconciliationService.reconcile(channelId: string): Promise<ReconciliationResult>`

- [ ] **Step 1: Write failing chronological catch-up tests**

Seed paginated history in reverse API order and prove the service evaluates by increasing `BigInt(message.id)`. Verify accepted historical messages create canonical/delete work and the checkpoint advances only after disposition and required outbox rows commit.

- [ ] **Step 2: Implement high-water reconciliation**

Inside the channel executor, read the durable checkpoint, capture the latest message ID as the high-water mark, page messages after the checkpoint, sort each collected page range chronologically, and call the same `GameService.processMessage` used for live traffic.

- [ ] **Step 3: Write the break-and-invalidate regression test**

```ts
const result = await reconciler.reconcile(channelId);
expect(result.breakingMessageId).toBe("103");
expect(repository.submission("104")?.decision).toBe("invalidated_after_reconnect_break");
expect(repository.submission("105")?.decision).toBe("invalidated_after_reconnect_break");
expect(repository.activeRoundState()).toBe("waiting_for_start");
```

Assert 104 and 105 get ordered deletion work, no canonical messages, penalties, contributions, or score entries, and the reset announcement follows their deletions.

- [ ] **Step 4: Implement completion, invalidation, and live overlap handling**

After a break, record every later numeric message through the captured high-water mark as invalidated. Dedupe any same ID later delivered by the Gateway. Keep new live work queued behind reconciliation and perform a final catch-up pass before declaring the adapter live.

- [ ] **Step 5: Test restart at every reconciliation boundary**

Restart after history fetch, after accepted-state commit, after canonical delivery, after breaking-state commit, and during invalidation cleanup. Each restart must converge to the same state and output set.

- [ ] **Step 6: Verify and commit reconciliation**

Run: `corepack.cmd pnpm test -- test/reconciliation-service.test.ts`

Expected: PASS.

```powershell
git add src/application/reconciliation-service.ts test/reconciliation-service.test.ts
git commit -m "feat: reconcile missed Discord submissions"
```

### Task 9: Secure administration server and authentication

**Files:**
- Create: `src/web/server.ts`
- Create: `src/web/auth.ts`
- Create: `src/web/views/layout.eta`
- Create: `src/web/views/login.eta`
- Create: `src/web/public/admin.css`
- Create: `scripts/hash-admin-password.mjs`
- Create: `test/auth.test.ts`
- Create: `test/web-security.test.ts`

**Interfaces:**
- Consumes: `AppConfig`, `admin_sessions`, `login_attempts`.
- Produces: `buildAdminServer(dependencies): FastifyInstance`
- Produces: `hashPassword(password: string): Promise<string>` and `verifyPassword(password, encoded): Promise<boolean>`.

- [ ] **Step 1: Write failing password and session-store tests**

Use Node `crypto.scrypt` with random 16-byte salt, constant-time comparison, and encoded format `scrypt$N$r$p$saltBase64$hashBase64`. Test correct/incorrect passwords, malformed hashes, session expiry, regeneration on login, and destruction on logout.

- [ ] **Step 2: Implement password tooling and SQLite session store**

The script prompts without echo if the terminal supports it or reads one password from stdin, prints only the encoded hash, and never writes it to disk. Implement the `@fastify/session` callback store over `admin_sessions` with periodic expiry cleanup.

- [ ] **Step 3: Write failing HTTP security tests with `fastify.inject`**

Test unauthenticated redirects, CSRF rejection, successful login/logout, five failed logins causing a 15-minute block, generic login errors, `HttpOnly`, `SameSite=Strict`, `Path=/admin`, expiration, and `Secure` in production.

Test an untrusted `X-Forwarded-Proto: https` does not bypass production transport policy; only a configured trusted proxy may establish HTTPS for secure-cookie handling.

- [ ] **Step 4: Build the Fastify security shell**

Register helmet, formbody, static assets, Eta views, cookie, SQLite-backed session, CSRF protection, and route-scoped rate limiting. Set `saveUninitialized: false`, regenerate after authentication, use a 12-hour absolute session expiry, and redact password/session/token fields from logs.

- [ ] **Step 5: Verify and commit authentication**

Run: `corepack.cmd pnpm test -- test/auth.test.ts test/web-security.test.ts`

Expected: PASS.

```powershell
git add src/web scripts/hash-admin-password.mjs test/auth.test.ts test/web-security.test.ts
git commit -m "feat: secure private administration"
```

### Task 10: Template editing, preview, and round lifecycle UI

**Files:**
- Create: `src/web/routes/dashboard.ts`
- Create: `src/web/routes/templates.ts`
- Create: `src/web/routes/rounds.ts`
- Create: `src/web/views/dashboard.eta`
- Create: `src/web/views/templates-list.eta`
- Create: `src/web/views/template-edit.eta`
- Create: `src/web/views/template-preview.eta`
- Create: `src/web/views/round.eta`
- Create: `test/admin-round-routes.test.ts`

**Interfaces:**
- Consumes: compiler, `GameService`, permission report, authenticated Fastify shell.
- Produces: authenticated `/admin`, `/admin/templates/*`, and `/admin/rounds/*` routes.

- [ ] **Step 1: Write failing template route tests**

Test create/edit/list, structured rule validation, invalid preview without persistence, complete preview with sequence/bonus counts/penalty thresholds, immutable activation snapshot, and CSRF on every mutation.

- [ ] **Step 2: Implement template forms and preview**

Represent predicates as repeatable form rows with explicit type and fields. Parse through Zod, call `compileRound`, and re-render validation errors beside their inputs. Escape all names, notes, IDs, and rule values through Eta's escaped interpolation.

- [ ] **Step 3: Write failing lifecycle route tests**

Test activation permission failures, one-active-round guard, pause from waiting/counting, resume to preserved state, cancellation confirmation, discarded provisional rewards, removal of cancelled-round penalties, ban expiry, and terminal operational-settlement blocking.

- [ ] **Step 4: Implement dashboard and lifecycle routes**

Show Discord status, permission report, active round/attempt, expected position only to the administrator, unresolved outbox count, and critical failures. Require explicit confirmation text for cancellation and submit every action through the shared channel executor.

- [ ] **Step 5: Verify and commit round administration**

Run: `corepack.cmd pnpm test -- test/admin-round-routes.test.ts`

Expected: PASS.

```powershell
git add src/web/routes/dashboard.ts src/web/routes/templates.ts src/web/routes/rounds.ts src/web/views test/admin-round-routes.test.ts
git commit -m "feat: administer round templates and lifecycle"
```

### Task 11: Moderation, leaderboard, audit, and operation recovery UI

**Files:**
- Create: `src/web/routes/moderation.ts`
- Create: `src/web/routes/leaderboard.ts`
- Create: `src/web/routes/operations.ts`
- Create: `src/web/views/moderation.eta`
- Create: `src/web/views/leaderboard.eta`
- Create: `src/web/views/season.eta`
- Create: `src/web/views/operations.eta`
- Create: `src/web/views/audit.eta`
- Create: `test/admin-operations-routes.test.ts`

**Interfaces:**
- Consumes: game/admin/outbox repositories and shared executor.
- Produces: authenticated moderation, season, audit-search, retry, mark-delivered, and abandon routes.

- [ ] **Step 1: Write failing moderation and leaderboard tests**

Test ban/unban audit records, banned numeric deletion without evaluation, current totals from ledger entries, archived round breakdowns, season reset only with no active round, and display-name changes without identity changes.

- [ ] **Step 2: Implement moderation and season pages**

Key every action by Discord user ID. Require reset confirmation text. Archive the current season and create its successor in one transaction, rejecting active or operationally unsettled rounds.

- [ ] **Step 3: Write failing operation-recovery tests**

Test searchable audit filters, retry of definite failures, prohibition on blind retry for `needs_review`, mark-delivered requiring a Discord message ID, and abandonment requiring a reason plus confirmation. Confirm abandoning the final terminal chain settles the round and unblocks activation/reset.

- [ ] **Step 4: Implement operational recovery pages**

Show operation type, round/submission reference, sequence, predecessor, attempts, next retry, redacted error, and status. Route every resolution through repository methods that append an audit event; never permit accepted sequence-history edits.

- [ ] **Step 5: Verify and commit remaining administration**

Run: `corepack.cmd pnpm test -- test/admin-operations-routes.test.ts`

Expected: PASS.

```powershell
git add src/web/routes/moderation.ts src/web/routes/leaderboard.ts src/web/routes/operations.ts src/web/views test/admin-operations-routes.test.ts
git commit -m "feat: add moderation and operations views"
```

### Task 12: Process composition, full recovery tests, and operator documentation

**Files:**
- Create: `src/main.ts`
- Create: `test/application-integration.test.ts`
- Create: `README.md`
- Create: `docs/operations.md`
- Modify: `.env.example`

**Interfaces:**
- Consumes: all application, Discord, database, and web modules.
- Produces: one deployable service with orderly startup and shutdown.

- [ ] **Step 1: Write failing application composition tests**

Inject fake clock, IDs, Discord transport, and temporary SQLite path. Verify startup order is migrate -> load active state -> register command -> connect -> reconcile -> dispatch pending work -> accept live play. Verify SIGINT/SIGTERM stop HTTP intake, stop Gateway intake, finish the current SQLite transaction, and close resources.

- [ ] **Step 2: Implement `main.ts` composition**

Load config once, open/migrate SQLite, construct repositories and services, start the admin server on its configured private address, start Discord, reconcile before declaring ready, and run the dispatcher until shutdown. Set a non-zero exit code on fatal startup or unrecoverable database errors.

- [ ] **Step 3: Add crash/restart end-to-end tests**

For each outbox stage—before send, ambiguous send, after send before acknowledgement, after deletion, before reset announcement, and before leaderboard publication—restart from the same database and assert one domain decision, correct ordering, and either one Discord effect or explicit `needs_review`.

- [ ] **Step 4: Write setup and operations documentation**

Document Node/Corepack setup, `corepack.cmd pnpm install --frozen-lockfile`, password-hash generation, environment variables, Discord application/intents/permissions, guild command registration, private reverse-proxy HTTPS requirements, database backup while using WAL, startup/shutdown, outbox review resolution, reconciliation behavior, and season reset guards. Use placeholders such as `your-discord-token` only; include no live IDs, URLs, or secrets.

- [ ] **Step 5: Run the complete automated verification**

Run: `corepack.cmd pnpm test`

Expected: all Vitest files pass with zero failures.

Run: `corepack.cmd pnpm typecheck`

Expected: PASS with zero TypeScript errors.

Run: `corepack.cmd pnpm build`

Expected: PASS and `dist/src/main.js` exists.

- [ ] **Step 6: Perform authorized manual verification**

Only after the user supplies a dedicated Discord test server/channel and explicitly authorizes using them: verify permissions, Message Content intent, slash registration, canonical order, bonuses, breaks, pause/resume, cancellation, bans, reconnect reconciliation, ambiguous outbox review, leaderboard publication, and private-network administration. Record results in `docs/operations.md`; do not place identifiers or secrets in the repository.

- [ ] **Step 7: Commit the integrated service**

```powershell
git add src/main.ts test/application-integration.test.ts README.md docs/operations.md .env.example
git commit -m "feat: compose Herald of Jams service"
```

## Final Verification Gate

- [ ] Confirm every design section maps to at least one completed task and test.
- [ ] Run `corepack.cmd pnpm test`, `corepack.cmd pnpm typecheck`, and `corepack.cmd pnpm build` from a clean checkout.
- [ ] Inspect `git diff --check` and `git status --short`.
- [ ] Confirm `.env`, SQLite databases, WAL/SHM files, and real Discord identifiers are untracked.
- [ ] Confirm no production network action or Discord configuration occurred without explicit authorization.
- [ ] Request one whole-branch review focused on state transitions, transaction boundaries, outbox ordering, reconnect convergence, and web authentication before publishing a pull request.

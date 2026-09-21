# Configurable Announcements and Cancellation Semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add editable global announcement defaults with per-template overrides, support one-value rounds, and make round cancellation remove all penalties owned by that round.

**Architecture:** A focused domain module owns typed announcement defaults, placeholder validation, inheritance, and rendering. SQLite stores one typed global-default row plus nullable typed template overrides; activation resolves them into the immutable compiled-round JSON. A versioned migration rebuilds the template constraint for `target >= start` and cleans penalties from already-cancelled rounds, while `GameService` uses snapshotted announcements and removes current-round penalties atomically on cancellation.

**Tech Stack:** TypeScript 7, Node.js 24.21.0, SQLite via better-sqlite3, Fastify/Eta, Vitest, pnpm 12.5.1

**Spec:** `docs/superpowers/specs/2026-09-20-herald-of-jams-counting-game-design.md`

## Global Constraints

- The service remains single-guild, single-game-channel, and one-active-round.
- Announcement configuration covers only bonus, reset, completion, and cancellation messages; canonical number posts and leaderboards remain system-controlled.
- Allowed placeholders are bonus `{player}` and `{bonusPoints}`, reset `{start}`, and none for completion or cancellation.
- Unknown or context-inappropriate placeholders are rejected; announcement text never executes code or arbitrary expressions.
- Blank per-template values inherit global defaults; global defaults are non-empty.
- Activation snapshots effective announcements so later global or template edits affect only future rounds.
- Every rendered Discord message must be at most 2,000 characters; stored templates are capped at 1,900 characters.
- `target === start` produces exactly one required submission; `target < start` remains invalid.
- Break penalties remain during active and paused rounds, but cancellation removes every penalty ledger entry and worst-severity row for that round.
- Existing active compiled rounds without announcement snapshots use built-in defaults.
- Existing cancelled rounds lose their historical penalty charges during migration; active and completed rounds are unchanged.
- All mutations remain CSRF-protected, channel-serialized where applicable, audited where specified, and atomic with their required outbox work.

## Review Focus

- Malformed braces or a placeholder valid for another announcement kind must be rejected before persistence; Task 1 adds an allowlist test for both cases.
- A blank override must follow the current global default at activation, while an already-active round must retain its prior snapshot; Tasks 2 and 3 add inheritance and immutability tests.
- A pre-revision active round whose compiled JSON lacks announcements must still emit built-in text without crashing; Task 3 adds a compatibility test.
- Migration must preserve all foreign keys and non-cancelled scoring while cleaning only cancelled-round penalties; Task 2 seeds all three round states and runs `foreign_key_check`.
- Placeholder substitution near the storage limit must never produce a Discord payload over 2,000 characters; Task 1 tests maximum player and numeric substitutions.

---

### Task 1: Announcement Domain Model and Single-Value Compilation

**Files:**
- Create: `src/domain/announcement-templates.ts`
- Modify: `src/domain/types.ts`
- Modify: `src/domain/round-compiler.ts`
- Create: `test/announcement-templates.test.ts`
- Modify: `test/round-compiler.test.ts`

**Interfaces:**
- Produces: `AnnouncementKind`, `AnnouncementTemplates`, `AnnouncementOverrides`, `DEFAULT_ANNOUNCEMENTS`, `resolveAnnouncements(defaults, overrides)`, and `renderAnnouncement(kind, template, values)`.
- Produces: `compileRound(input, defaults?)` returning `CompiledRound` with immutable `announcements: AnnouncementTemplates`.
- Consumes: no new application or persistence interfaces.

- [ ] **Step 1: Write failing announcement validation and rendering tests**

Create `test/announcement-templates.test.ts` with real domain calls:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANNOUNCEMENTS,
  renderAnnouncement,
  resolveAnnouncements,
} from "../src/domain/announcement-templates.js";

describe("announcement templates", () => {
  it("inherits blanks and applies typed overrides", () => {
    expect(resolveAnnouncements(DEFAULT_ANNOUNCEMENTS, {
      bonus: "Bonus: {player} +{bonusPoints}",
      reset: "",
    })).toMatchObject({
      bonus: "Bonus: {player} +{bonusPoints}",
      reset: DEFAULT_ANNOUNCEMENTS.reset,
    });
  });

  it.each([
    ["bonus", "Bad {start}"],
    ["reset", "Bad {player}"],
    ["completion", "Bad {player}"],
    ["cancellation", "Bad {unknown}"],
    ["bonus", "Bad {player"],
  ] as const)("rejects invalid %s placeholders", (kind, text) => {
    expect(() => resolveAnnouncements(DEFAULT_ANNOUNCEMENTS, { [kind]: text }))
      .toThrow(/placeholder|brace/i);
  });

  it("renders allowed placeholders within Discord's limit", () => {
    const rendered = renderAnnouncement(
      "bonus",
      `${"x".repeat(1_850)} {player} {bonusPoints}`,
      { player: "p".repeat(32), bonusPoints: 100_000 },
    );
    expect(rendered.length).toBeLessThanOrEqual(2_000);
  });
});
```

- [ ] **Step 2: Run the announcement test and verify RED**

Run: `corepack.cmd pnpm exec vitest run test/announcement-templates.test.ts`

Expected: FAIL because `src/domain/announcement-templates.ts` does not exist.

- [ ] **Step 3: Add typed defaults, validation, inheritance, and rendering**

In `src/domain/types.ts`, add:

```ts
export type AnnouncementKind = "bonus" | "reset" | "completion" | "cancellation";

export interface AnnouncementTemplates {
  bonus: string;
  reset: string;
  completion: string;
  cancellation: string;
}

export type AnnouncementOverrides = Partial<AnnouncementTemplates>;
```

Add `announcements?: AnnouncementOverrides` to `RoundTemplateInput` and `announcements: Readonly<AnnouncementTemplates>` to `CompiledRound`.

In `src/domain/announcement-templates.ts`, define these exact built-in defaults:

```ts
export const DEFAULT_ANNOUNCEMENTS = Object.freeze({
  bonus: "{player} earned {bonusPoints} provisional bonus points.",
  reset: "The attempt was reset. Provisional rewards were discarded; penalties remain. Start again at {start}.",
  completion: "The round is complete. Final rewards have been recorded.",
  cancellation: "The round was cancelled. All provisional rewards and round penalties were discarded.",
});
```

Implement a 1,900-character storage limit, reject empty global values, normalize empty overrides to inheritance, scan every `{...}` token and unmatched brace, enforce the per-kind allowlist, freeze the resolved result, and perform literal replacement. `renderAnnouncement` must throw if the result exceeds 2,000 characters.

- [ ] **Step 4: Add failing single-value compiler tests**

In `test/round-compiler.test.ts`, remove `equal bounds` from the rejection table and add:

```ts
it("compiles equal start and target as one immutable entry", () => {
  const compiled = compileRound(template({
    start: 2,
    target: 2,
    step: 1,
    skipRules: [{ kind: "prime" }],
    announcements: { completion: "Done" },
  }));
  expect(compiled.entries.map(({ value }) => value)).toEqual([2]);
  expect(compiled.announcements.completion).toBe("Done");
  expect(Object.isFrozen(compiled.announcements)).toBe(true);
});
```

Run: `corepack.cmd pnpm exec vitest run test/round-compiler.test.ts`

Expected: FAIL with `target must be greater than start`.

- [ ] **Step 5: Resolve announcements during compilation and allow equality**

Change the compiler signature to:

```ts
export function compileRound(
  input: RoundTemplateInput,
  defaults: AnnouncementTemplates = DEFAULT_ANNOUNCEMENTS,
): CompiledRound
```

Reject only `input.target < input.start`, skip the target-removal check when `target === start`, deep-copy optional overrides, call `resolveAnnouncements(defaults, input.announcements)`, and return the frozen announcement snapshot with the entries.

- [ ] **Step 6: Run focused tests and commit**

Run: `corepack.cmd pnpm exec vitest run test/announcement-templates.test.ts test/round-compiler.test.ts`

Expected: both files PASS.

```powershell
git add src/domain/announcement-templates.ts src/domain/types.ts src/domain/round-compiler.ts test/announcement-templates.test.ts test/round-compiler.test.ts
git commit -m "feat: model configurable announcements"
```

---

### Task 2: Announcement Persistence and Safe Schema Migration

**Files:**
- Create: `src/db/migrations/002-announcements-and-single-value-rounds.sql`
- Modify: `src/db/database.ts`
- Modify: `src/db/admin-repository.ts`
- Modify: `test/database.test.ts`
- Modify: `test/fixtures.ts`

**Interfaces:**
- Consumes: `AnnouncementTemplates`, `AnnouncementOverrides`, `DEFAULT_ANNOUNCEMENTS`, and `compileRound(input, defaults?)` from Task 1.
- Produces: `AdminRepository.getAnnouncementDefaults(): AnnouncementTemplates`.
- Produces: `AdminRepository.updateAnnouncementDefaults(input: AnnouncementTemplates, actorId: string): void`.
- Produces: template create/get/update round-tripping nullable `announcements` overrides.

- [ ] **Step 1: Write a failing version-1 upgrade test**

In `test/database.test.ts`, add a fixture that executes only `001-initial.sql`, records migration version 1, and seeds:

- one cancelled round with a penalty ledger row and `round_player_penalties` row;
- one completed round with a penalty row;
- one active round with a penalty row;
- a child `rounds.template_id` foreign key for each template.

Then call `migrate(database)` and assert:

```ts
expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
  .toEqual([{ version: 1 }, { version: 2 }]);
expect(database.pragma("foreign_key_check")).toEqual([]);
expect(database.prepare("SELECT COUNT(*) AS count FROM score_ledger WHERE round_id = 'cancelled'").get())
  .toEqual({ count: 0 });
expect(database.prepare("SELECT COUNT(*) AS count FROM round_player_penalties WHERE round_id = 'cancelled'").get())
  .toEqual({ count: 0 });
expect(database.prepare("SELECT round_id FROM score_ledger ORDER BY round_id").all())
  .toEqual([{ round_id: "active" }, { round_id: "completed" }]);
expect(() => database.prepare(
  `INSERT INTO round_templates
    (id, private_name, channel_id, start_value, target_value, step_value, rules_json,
     created_at, updated_at)
   VALUES ('equal', 'Equal', 'channel', 7, 7, 1, '{}', 'now', 'now')`,
).run()).not.toThrow();
```

Also assert the singleton global row contains `DEFAULT_ANNOUNCEMENTS` and migrated templates have null overrides.

- [ ] **Step 2: Run the migration test and verify RED**

Run: `corepack.cmd pnpm exec vitest run test/database.test.ts`

Expected: FAIL because migration version 2 and the new tables/columns do not exist.

- [ ] **Step 3: Add foreign-key-off migration support**

Extend the internal migration shape in `src/db/database.ts` with `requiresForeignKeysOff: boolean`, set it when SQL starts with `-- requires-foreign-keys-off`, and execute that migration using this sequence:

```ts
database.pragma("foreign_keys = OFF");
try {
  database.transaction(() => {
    database.exec(migration.sql);
    const violations = database.pragma("foreign_key_check") as unknown[];
    if (violations.length > 0) throw new Error("migration violates foreign keys");
    recordVersion(database, migration.version);
  }).immediate();
} finally {
  database.pragma("foreign_keys = ON");
}
```

Keep ordinary migrations on the existing transaction path. Extract only the small `recordVersion` helper needed to avoid duplication.

- [ ] **Step 4: Implement migration 002**

Create a strict singleton `announcement_settings` table with `id = 1`, four non-empty text columns capped at 1,900 characters, and `updated_at`. Seed the exact Task 1 defaults.

Rebuild `round_templates` as `round_templates_new` with `CHECK (target_value >= start_value)` and these nullable columns, each checked at 1–1,900 characters when non-null:

```sql
bonus_announcement_override TEXT,
reset_announcement_override TEXT,
completion_announcement_override TEXT,
cancellation_announcement_override TEXT
```

Copy every existing row with null overrides, drop the old table, and rename the new table. Then execute:

```sql
DELETE FROM score_ledger
WHERE entry_type = 'penalty'
  AND round_id IN (SELECT id FROM rounds WHERE state = 'cancelled');

DELETE FROM round_player_penalties
WHERE round_id IN (SELECT id FROM rounds WHERE state = 'cancelled');
```

- [ ] **Step 5: Write failing repository inheritance and audit tests**

In `test/database.test.ts` or a focused `test/admin-repository.test.ts`, create a template with only a completion override. Assert `getTemplate` returns only that override, and `getAnnouncementDefaults` returns all four defaults. Update global defaults and assert one `announcement_defaults_updated` audit event whose details contain changed field names but not message bodies.

Run the focused test and confirm it fails because the repository methods and columns are not wired.

- [ ] **Step 6: Implement typed repository persistence**

Update `AdminRepository` to select/write the four nullable override columns, omitting nulls from the returned `announcements` object. `createTemplate` and `updateTemplate` must validate with current global defaults. Implement `getAnnouncementDefaults` and `updateAnnouncementDefaults`; validate through `resolveAnnouncements(input, {})`, update the singleton row transactionally, and audit only `{ fields: ["bonus", ...] }` using the repository ID generator and clock.

- [ ] **Step 7: Run database/repository tests and commit**

Run: `corepack.cmd pnpm exec vitest run test/database.test.ts test/round-compiler.test.ts`

Expected: PASS, including an empty `foreign_key_check` result.

```powershell
git add src/db/migrations/002-announcements-and-single-value-rounds.sql src/db/database.ts src/db/admin-repository.ts test/database.test.ts test/fixtures.ts
git commit -m "feat: persist announcement settings"
```

---

### Task 3: Snapshotted Game Output and Cancellation Penalty Removal

**Files:**
- Modify: `src/application/game-service.ts`
- Modify: `test/game-service.test.ts`
- Modify: `test/application-integration.test.ts`

**Interfaces:**
- Consumes: compiled `announcements`, `renderAnnouncement`, and `AdminRepository.getAnnouncementDefaults()` from Tasks 1–2.
- Produces: immutable configured bonus/reset/completion/cancellation outbox payloads and penalty-free cancelled rounds.

- [ ] **Step 1: Write failing single-value completion and snapshot tests**

In `test/game-service.test.ts`, add a test that creates a `start: 2, target: 2` template with custom bonus and completion overrides, activates it, changes the global defaults, submits `2`, and asserts:

```ts
const templateId = context.adminRepository.createTemplate(roundTemplate({
  start: 2,
  target: 2,
  bonusRules: [{ id: "prime", predicate: { kind: "prime" } }],
  announcements: {
    bonus: "Custom {player} +{bonusPoints}",
    completion: "Custom complete",
  },
}));
await service.activateRound(templateId);
context.adminRepository.updateAnnouncementDefaults({
  ...DEFAULT_ANNOUNCEMENTS,
  completion: "Changed after activation",
}, "admin");
await service.processMessage(message("100", "alice", "2"));

expect(context.database.prepare("SELECT state FROM rounds").get()).toEqual({ state: "completed" });
expect(outboxContents("bonus_announcement")).toEqual(["Custom alice +1"]);
expect(outboxContents("completion_announcement")).toEqual(["Custom complete"]);
```

This proves one submission completes and post-activation default edits do not alter the snapshot.

- [ ] **Step 2: Add a compatibility-fallback characterization test**

Seed or update an active round's `compiled_config_json` to remove its `announcements` property, process a breaking submission, and assert the reset outbox payload equals `DEFAULT_ANNOUNCEMENTS.reset` rendered with the starting number. Run the characterization before production changes and confirm it passes, then keep it green while Step 4 replaces hard-coded output.

- [ ] **Step 3: Write a failing cancellation cleanup test**

Change the existing cancellation test to expect an empty leaderboard and add exact persistence assertions:

```ts
function outboxContents(operationType: string): string[] {
  return (context.database
    .prepare("SELECT payload_json FROM discord_outbox WHERE operation_type = ? ORDER BY sequence_number")
    .all(operationType) as { payload_json: string }[])
    .map(({ payload_json }) => (JSON.parse(payload_json) as { content: string }).content);
}

await service.cancelRound("admin");
expect(context.repository.leaderboard()).toEqual([]);
expect(scalar(context, "SELECT COUNT(*) AS value FROM score_ledger WHERE entry_type = 'penalty'"))
  .toBe(0);
expect(scalar(context, "SELECT COUNT(*) AS value FROM round_player_penalties")).toBe(0);
expect(outboxContents("cancellation_announcement"))
  .toEqual(["The round was cancelled. All provisional rewards and round penalties were discarded."]);
const cancellationAudit = context.database
  .prepare("SELECT details_json FROM audit_events WHERE event_type = 'round_cancelled'")
  .get() as { details_json: string };
expect(JSON.parse(cancellationAudit.details_json)).toMatchObject({
  discardedPenaltyEntries: 1,
  discardedPenaltyPoints: 2,
});
```

Run: `corepack.cmd pnpm exec vitest run test/game-service.test.ts`

Expected: FAIL because penalties remain and output is hard-coded.

- [ ] **Step 4: Render every announcement from the compiled snapshot**

Add a compatibility helper:

```ts
function announcements(compiled: CompiledRound): AnnouncementTemplates {
  return compiled.announcements ?? DEFAULT_ANNOUNCEMENTS;
}
```

At activation call `compileRound(input, this.adminRepository.getAnnouncementDefaults())`. Replace hard-coded bonus, both reset paths, completion, and cancellation content with `renderAnnouncement` using the correct context values. Keep the already-snapshotted rendered outbox payload immutable across retry.

- [ ] **Step 5: Remove current-round penalties inside cancellation**

Before changing the round to `cancelled`, query `COUNT(*)` and `COALESCE(SUM(delta), 0)` for its penalty entries, delete only `score_ledger` rows with the active `round.id` and `entry_type = 'penalty'`, then delete its `round_player_penalties`. Include positive `discardedPenaltyPoints = -sum` and the entry count in the private cancellation audit. Perform all work inside the existing immediate transaction before enqueueing the configured cancellation announcement.

- [ ] **Step 6: Verify service and restart behavior, then commit**

Run: `corepack.cmd pnpm exec vitest run test/game-service.test.ts test/application-integration.test.ts test/reconciliation-service.test.ts`

Expected: PASS; ordinary breaks still retain penalties until cancellation.

```powershell
git add src/application/game-service.ts test/game-service.test.ts test/application-integration.test.ts
git commit -m "feat: apply configured round announcements"
```

---

### Task 4: Global Defaults and Template Overrides in Administration

**Files:**
- Create: `src/web/routes/announcements.ts`
- Create: `src/web/views/announcement-settings.eta`
- Modify: `src/web/routes/templates.ts`
- Modify: `src/web/views/template-edit.eta`
- Modify: `src/web/views/template-preview.eta`
- Modify: `src/web/views/layout.eta`
- Modify: `src/web/server.ts`
- Modify: `test/admin-round-routes.test.ts`
- Modify: `test/web-security.test.ts`

**Interfaces:**
- Consumes: `AdminRepository.getAnnouncementDefaults`, `updateAnnouncementDefaults`, optional template `announcements`, and `compileRound(input, defaults)`.
- Produces: authenticated GET/POST `/admin/settings/announcements` and four optional announcement override fields in template create/edit/preview.

- [ ] **Step 1: Write failing global-default route tests**

In `test/admin-round-routes.test.ts`, authenticate and assert GET `/admin/settings/announcements` renders all four escaped defaults and placeholder help. POST custom values with a valid CSRF token and assert persistence plus redirect. Add POST cases for missing CSRF, an unknown placeholder, blank global text, and a 1,901-character value; expect 403 or 400 without persistence.

```ts
const page = await app.inject({
  method: "GET",
  url: "/admin/settings/announcements",
  headers: { cookie },
});
expect(page.body).toContain("{player}");
const saved = await app.inject({
  method: "POST",
  url: "/admin/settings/announcements",
  headers: { cookie },
  payload: {
    _csrf: token(page.body),
    bonus: "Bonus {player}: {bonusPoints}",
    reset: "Reset to {start}",
    completion: "Complete",
    cancellation: "Cancelled without penalties",
  },
});
expect(saved.statusCode).toBe(302);
expect(context.adminRepository.getAnnouncementDefaults().completion).toBe("Complete");
```

Run: `corepack.cmd pnpm exec vitest run test/admin-round-routes.test.ts`

Expected: FAIL with route not found.

- [ ] **Step 2: Add the focused announcement settings route and view**

Implement:

```ts
export function registerAnnouncementRoutes(
  app: FastifyInstance,
  repository: AdminRepository,
  requireAuthenticated: preHandlerHookHandler,
  csrfHook: preHandlerHookHandler,
): void
```

GET renders four named textareas and allowed-placeholder help. POST parses four required strings, calls `updateAnnouncementDefaults(values, "admin")`, returns validation messages as plain text with status 400, and redirects to the same page on success. Register it in `server.ts` and add an **Announcement defaults** navigation link.

- [ ] **Step 3: Write failing template override and preview tests**

Extend the template route test to submit only `completionAnnouncement: "Template complete"`, assert the other overrides are omitted, and assert preview displays the resolved custom completion plus inherited current global bonus/reset/cancellation messages. Edit the global completion after activation and assert the active compiled JSON still contains `Template complete`.

Also submit `bonusAnnouncement: "Bad {start}"` and expect 400 without changing the stored template.

```ts
const preview = await app.inject({
  method: "POST",
  url: "/admin/templates/preview",
  headers: { cookie },
  payload: {
    ...roundTemplate({ start: 1, target: 1 }),
    completionAnnouncement: "Template complete",
    _csrf: csrf,
  },
});
expect(preview.body).toContain("Template complete");
expect(preview.body).toContain(context.adminRepository.getAnnouncementDefaults().reset);
```

- [ ] **Step 4: Add override fields and resolved preview**

Extend the Zod form schema with optional strings:

```ts
bonusAnnouncement
resetAnnouncement
completionAnnouncement
cancellationAnnouncement
```

Normalize blank strings to absent overrides, map them to `RoundTemplateInput.announcements`, and rely on domain validation for placeholders and length. Add four textareas to `template-edit.eta`, labeling each as optional and showing allowed placeholders. In the preview route call `compileRound(parsed, repository.getAnnouncementDefaults())` and pass `compiled.announcements` to `template-preview.eta` for escaped display.

- [ ] **Step 5: Verify rendered navigation and security, then commit**

Run: `corepack.cmd pnpm exec vitest run test/admin-round-routes.test.ts test/web-security.test.ts`

Expected: PASS, including CSRF and escaping assertions.

```powershell
git add src/web/routes/announcements.ts src/web/views/announcement-settings.eta src/web/routes/templates.ts src/web/views/template-edit.eta src/web/views/template-preview.eta src/web/views/layout.eta src/web/server.ts test/admin-round-routes.test.ts test/web-security.test.ts
git commit -m "feat: administer announcement wording"
```

---

### Task 5: Documentation, Full Verification, and PR Update

**Files:**
- Modify: `README.md`
- Modify: `docs/operations.md`
- Modify: `docs/superpowers/plans/2026-09-20-herald-of-jams-counting-game.md`
- Modify: `docs/superpowers/specs/2026-09-20-herald-of-jams-counting-game-design.md`

**Interfaces:**
- Consumes: all behavior completed in Tasks 1–4.
- Produces: operator instructions and final evidence for PR #1.

- [ ] **Step 1: Update documentation to the implemented behavior**

Document the global-default page, supported placeholders, blank override inheritance, activation snapshot semantics, one-value smoke-test template, and cancellation penalty removal. In the original implementation plan, replace obsolete retained-cancellation-penalty wording and mark the revision as superseded by this plan rather than rewriting completed task history. Change the design status to implemented after verification.

- [ ] **Step 2: Run the complete automated verification**

Run:

```powershell
corepack.cmd pnpm test
corepack.cmd pnpm typecheck
corepack.cmd pnpm build
git diff --check
```

Expected: every Vitest file passes, typecheck exits 0, build exits 0, and `git diff --check` has no output.

- [ ] **Step 3: Inspect migration and secret boundaries**

Run:

```powershell
rg -n --hidden --glob '!node_modules/**' --glob '!dist/**' "DISCORD_TOKEN=.+|SESSION_SECRET=.+|scrypt\$" .
git status --short
```

Expected: only documented placeholder names or test fixtures appear; no live token, secret, password, guild ID, or channel ID is present. Status contains only the intended documentation changes.

- [ ] **Step 4: Commit the documentation and verification state**

```powershell
git add README.md docs/operations.md docs/superpowers/plans/2026-09-20-herald-of-jams-counting-game.md docs/superpowers/specs/2026-09-20-herald-of-jams-counting-game-design.md
git commit -m "docs: explain announcement configuration"
```

- [ ] **Step 5: Push and update PR #1**

Push `codex/counting-game-implementation`, update PR #1's summary and per-file list to include migration 002, announcement configuration, single-value rounds, and cancellation penalty cleanup, and report the final test/typecheck/build counts. Do not merge.

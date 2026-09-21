import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrate, openDatabase } from "../src/db/database.js";
import { DEFAULT_ANNOUNCEMENTS } from "../src/domain/announcement-templates.js";

const temporaryDirectories: string[] = [];

function temporaryDatabase(): { database: Database.Database; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), "herald-of-jams-"));
  temporaryDirectories.push(directory);
  return { database: openDatabase(join(directory, "game.sqlite")), directory };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database migrations", () => {
  it("opens SQLite with the required connection pragmas", () => {
    const { database } = temporaryDatabase();

    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("busy_timeout", { simple: true })).toBe(5000);

    database.close();
  });

  it("creates every table and required operational index idempotently", () => {
    const { database } = temporaryDatabase();

    migrate(database);
    migrate(database);

    const objects = database
      .prepare(
        "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { type: "table" | "index"; name: string }[];
    const tables = objects.filter(({ type }) => type === "table").map(({ name }) => name);
    const indexes = objects.filter(({ type }) => type === "index").map(({ name }) => name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "schema_migrations",
        "seasons",
        "players",
        "round_templates",
        "rounds",
        "compiled_entries",
        "attempts",
        "submissions",
        "attempt_contributions",
        "round_player_penalties",
        "round_bans",
        "score_ledger",
        "discord_outbox",
        "channel_checkpoints",
        "audit_events",
        "admin_sessions",
        "login_attempts",
      ]),
    );
    expect(indexes).toEqual(
      expect.arrayContaining([
        "rounds_one_active",
        "discord_outbox_pending",
        "audit_events_created_at",
        "score_ledger_season_player",
        "admin_sessions_expires_at",
      ]),
    );
    expect(database.prepare("SELECT version FROM schema_migrations").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
    ]);

    database.close();
  });

  it("enforces unique Discord message IDs and channel sequence numbers", () => {
    const { database } = temporaryDatabase();
    migrate(database);

    database
      .prepare("INSERT INTO seasons (id, started_at) VALUES (?, ?)")
      .run("season-1", "2026-09-21T00:00:00.000Z");
    database
      .prepare(
        `INSERT INTO round_templates
          (id, private_name, channel_id, start_value, target_value, step_value, rules_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("template-1", "Test", "channel-1", 1, 5, 1, "{}", "now", "now");
    database
      .prepare(
        `INSERT INTO rounds
          (id, template_id, season_id, channel_id, state, compiled_config_json, activated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "round-1",
        "template-1",
        "season-1",
        "channel-1",
        "counting",
        "{}",
        "now",
      );
    database
      .prepare("INSERT INTO attempts (id, round_id, state, started_at) VALUES (?, ?, ?, ?)")
      .run("attempt-1", "round-1", "active", "now");

    const insertSubmission = database.prepare(
      `INSERT INTO submissions
        (message_id, round_id, attempt_id, author_id, original_digits, normalized_value, decision, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertSubmission.run("message-1", "round-1", "attempt-1", "alice", "1", 1, "accepted", "now");
    expect(() =>
      insertSubmission.run(
        "message-1",
        "round-1",
        "attempt-1",
        "alice",
        "1",
        1,
        "accepted",
        "now",
      ),
    ).toThrow(/UNIQUE constraint failed: submissions.message_id/);

    const insertOutbox = database.prepare(
      `INSERT INTO discord_outbox
        (id, channel_id, sequence_number, operation_type, payload_json, nonce, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertOutbox.run(
      "operation-1",
      "channel-1",
      1,
      "delete_original",
      "{}",
      "nonce-1",
      "pending",
      "now",
    );
    expect(() =>
      insertOutbox.run(
        "operation-2",
        "channel-1",
        1,
        "delete_original",
        "{}",
        "nonce-2",
        "pending",
        "now",
      ),
    ).toThrow(/UNIQUE constraint failed: discord_outbox.channel_id, discord_outbox.sequence_number/);

    database.close();
  });

  it("refuses a database created by an unknown future schema version", () => {
    const { database } = temporaryDatabase();
    migrate(database);
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
      .run(999, "future");

    expect(() => migrate(database)).toThrow(/future schema version 999/i);
    database.close();
  });

  it("upgrades version 1 while preserving foreign keys and non-cancelled penalties", () => {
    const { database } = temporaryDatabase();
    const initialSql = readFileSync(
      resolve(process.cwd(), "src", "db", "migrations", "001-initial.sql"),
      "utf8",
    );
    database.exec(initialSql);
    database
      .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, 'now')")
      .run();
    database.prepare("INSERT INTO seasons (id, started_at) VALUES ('season', 'now')").run();
    database
      .prepare(
        "INSERT INTO players (discord_user_id, latest_display_name, updated_at) VALUES ('player', 'Player', 'now')",
      )
      .run();
    database
      .prepare(
        `INSERT INTO round_templates
          (id, private_name, channel_id, start_value, target_value, step_value, rules_json,
           created_at, updated_at)
         VALUES ('template', 'Template', 'channel', 1, 2, 1, '{}', 'now', 'now')`,
      )
      .run();

    const insertRound = database.prepare(
      `INSERT INTO rounds
        (id, template_id, season_id, channel_id, state, compiled_config_json, activated_at,
         completed_at, cancelled_at)
       VALUES (?, 'template', 'season', 'channel', ?, '{}', 'now', ?, ?)`,
    );
    insertRound.run("active", "counting", null, null);
    insertRound.run("completed", "completed", "now", null);
    insertRound.run("cancelled", "cancelled", null, "now");

    const insertPenalty = database.prepare(
      `INSERT INTO score_ledger
        (id, season_id, round_id, player_id, entry_type, delta, source_key, created_at)
       VALUES (?, 'season', ?, 'player', 'penalty', -2, ?, 'now')`,
    );
    for (const roundId of ["active", "completed", "cancelled"]) {
      insertPenalty.run(`ledger-${roundId}`, roundId, `penalty-${roundId}`);
    }
    database
      .prepare(
        `INSERT INTO round_player_penalties (round_id, player_id, worst_severity)
         VALUES ('cancelled', 'player', -2)`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO discord_outbox
          (id, channel_id, sequence_number, operation_type, payload_json, nonce, status, created_at)
         VALUES ('existing-1', 'existing-channel', 1, 'canonical_message', '{}', 'nonce-1', 'pending', 'now')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO discord_outbox
          (id, channel_id, sequence_number, predecessor_id, operation_type, payload_json, nonce,
           status, created_at)
         VALUES ('existing-2', 'existing-channel', 2, 'existing-1', 'delete_original', '{}',
                 'nonce-2', 'pending', 'now')`,
      )
      .run();

    migrate(database);

    expect(database.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
    ]);
    expect(database.pragma("foreign_key_check")).toEqual([]);
    expect(
      database
        .prepare(
          `SELECT id, predecessor_id, operation_type FROM discord_outbox
           WHERE channel_id = 'existing-channel' ORDER BY sequence_number`,
        )
        .all(),
    ).toEqual([
      { id: "existing-1", predecessor_id: null, operation_type: "canonical_message" },
      { id: "existing-2", predecessor_id: "existing-1", operation_type: "delete_original" },
    ]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM score_ledger WHERE round_id = 'cancelled'").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM round_player_penalties WHERE round_id = 'cancelled'")
        .get(),
    ).toEqual({ count: 0 });
    expect(database.prepare("SELECT round_id FROM score_ledger ORDER BY round_id").all()).toEqual([
      { round_id: "active" },
      { round_id: "completed" },
    ]);
    expect(() =>
      database
        .prepare(
          `INSERT INTO round_templates
            (id, private_name, channel_id, start_value, target_value, step_value, rules_json,
             created_at, updated_at)
           VALUES ('equal', 'Equal', 'channel', 7, 7, 1, '{}', 'now', 'now')`,
        )
        .run(),
    ).not.toThrow();
    expect(
      database
        .prepare(
          `SELECT start_announcement, bonus_announcement, reset_announcement, completion_announcement,
                  cancellation_announcement
           FROM announcement_settings WHERE id = 1`,
        )
        .get(),
    ).toEqual({
      start_announcement: DEFAULT_ANNOUNCEMENTS.start,
      bonus_announcement: DEFAULT_ANNOUNCEMENTS.bonus,
      reset_announcement: DEFAULT_ANNOUNCEMENTS.reset,
      completion_announcement: DEFAULT_ANNOUNCEMENTS.completion,
      cancellation_announcement: DEFAULT_ANNOUNCEMENTS.cancellation,
    });
    expect(
      database
        .prepare(
          `SELECT start_announcement_override, bonus_announcement_override, reset_announcement_override,
                  completion_announcement_override, cancellation_announcement_override
           FROM round_templates WHERE id = 'template'`,
        )
        .get(),
    ).toEqual({
      start_announcement_override: null,
      bonus_announcement_override: null,
      reset_announcement_override: null,
      completion_announcement_override: null,
      cancellation_announcement_override: null,
    });
    expect(() =>
      database
        .prepare(
          `INSERT INTO discord_outbox
            (id, channel_id, sequence_number, operation_type, payload_json, nonce, status, created_at)
           VALUES ('start-op', 'channel', 1, 'start_announcement', '{}', 'start-nonce', 'pending', 'now')`,
        )
        .run(),
    ).not.toThrow();

    database.close();
  });
});

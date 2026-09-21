import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GameService } from "../src/application/game-service.js";
import {
  createTestDatabase,
  message,
  roundTemplate,
  type TestDatabaseContext,
} from "./fixtures.js";

function scalar(context: TestDatabaseContext, sql: string): number {
  const row = context.database.prepare(sql).get() as { value: number };
  return row.value;
}

describe("GameService", () => {
  let context: TestDatabaseContext;
  let service: GameService;

  beforeEach(() => {
    context = createTestDatabase();
    service = new GameService(context.repository, context.adminRepository, context.clock, context.ids);
  });

  afterEach(() => context.close());

  async function activate(overrides = {}) {
    const templateId = context.adminRepository.createTemplate(roundTemplate(overrides));
    return service.activateRound(templateId);
  }

  it("commits starting acceptance, attempt state, contribution, audit, and ordered output atomically", async () => {
    const roundId = await activate();

    const disposition = await service.processMessage(message("100", "alice", "01"));

    expect(disposition).toMatchObject({
      kind: "recorded",
      decision: "accepted",
      outboxOperationIds: expect.any(Array),
    });
    expect(disposition.kind === "recorded" && disposition.outboxOperationIds).toHaveLength(2);
    expect(
      context.database.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId),
    ).toEqual({ state: "counting" });
    expect(scalar(context, "SELECT COUNT(*) AS value FROM attempts")).toBe(1);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM submissions")).toBe(1);
    expect(
      context.database.prepare("SELECT accepted_count FROM attempt_contributions").get(),
    ).toEqual({ accepted_count: 1 });
    expect(
      context.database
        .prepare("SELECT event_type FROM audit_events WHERE event_type = 'submission_accepted'")
        .get(),
    ).toEqual({ event_type: "submission_accepted" });
    expect(
      context.database
        .prepare(
          "SELECT operation_type, sequence_number, predecessor_id FROM discord_outbox ORDER BY sequence_number",
        )
        .all(),
    ).toEqual([
      { operation_type: "canonical_message", sequence_number: 1, predecessor_id: null },
      {
        operation_type: "delete_original",
        sequence_number: 2,
        predecessor_id: expect.any(String),
      },
    ]);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM compiled_entries")).toBe(5);
  });

  it("rolls back every decision write when an outbox insert fails", async () => {
    await activate();
    context.database.exec(`
      CREATE TRIGGER fail_canonical BEFORE INSERT ON discord_outbox
      WHEN NEW.operation_type = 'canonical_message'
      BEGIN SELECT RAISE(ABORT, 'forced outbox failure'); END;
    `);

    await expect(service.processMessage(message("100", "alice", "1"))).rejects.toThrow(
      /forced outbox failure/,
    );

    expect(scalar(context, "SELECT COUNT(*) AS value FROM attempts")).toBe(0);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM submissions")).toBe(0);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM attempt_contributions")).toBe(0);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM discord_outbox")).toBe(0);
    expect(
      scalar(
        context,
        "SELECT COUNT(*) AS value FROM audit_events WHERE event_type = 'submission_accepted'",
      ),
    ).toBe(0);
    expect(context.database.prepare("SELECT state FROM rounds").get()).toEqual({
      state: "waiting_for_start",
    });
  });

  it("deduplicates a replayed Discord message without new state or output", async () => {
    await activate();
    const inbound = message("100", "alice", "1");
    await service.processMessage(inbound);
    const before = {
      submissions: scalar(context, "SELECT COUNT(*) AS value FROM submissions"),
      outbox: scalar(context, "SELECT COUNT(*) AS value FROM discord_outbox"),
      ledger: scalar(context, "SELECT COUNT(*) AS value FROM score_ledger"),
    };

    await expect(service.processMessage(inbound)).resolves.toEqual({ kind: "duplicate" });
    expect({
      submissions: scalar(context, "SELECT COUNT(*) AS value FROM submissions"),
      outbox: scalar(context, "SELECT COUNT(*) AS value FROM discord_outbox"),
      ledger: scalar(context, "SELECT COUNT(*) AS value FROM score_ledger"),
    }).toEqual(before);
  });

  it("preserves an attempt across pause and resume while deleting paused numerics", async () => {
    await activate();
    await service.processMessage(message("100", "alice", "1"));

    await service.pauseRound();
    await expect(service.processMessage(message("101", "bob", "2"))).resolves.toMatchObject({
      kind: "recorded",
      decision: "paused_deleted",
    });
    expect(context.database.prepare("SELECT state, paused_from_state FROM rounds").get()).toEqual({
      state: "paused",
      paused_from_state: "counting",
    });

    await service.resumeRound();
    await expect(service.processMessage(message("102", "bob", "2"))).resolves.toMatchObject({
      kind: "recorded",
      decision: "accepted",
    });
    expect(context.database.prepare("SELECT state, paused_from_state FROM rounds").get()).toEqual({
      state: "counting",
      paused_from_state: null,
    });
  });

  it("ignores banned submissions and audits ban lifecycle", async () => {
    await activate();
    await service.banPlayer("alice", "Alice", "admin");

    await expect(service.processMessage(message("100", "alice", "1"))).resolves.toMatchObject({
      kind: "recorded",
      decision: "banned_deleted",
    });
    expect(scalar(context, "SELECT COUNT(*) AS value FROM attempts")).toBe(0);

    await service.unbanPlayer("alice", "admin");
    await expect(service.processMessage(message("101", "alice", "1"))).resolves.toMatchObject({
      kind: "recorded",
      decision: "accepted",
    });
    expect(
      context.database
        .prepare("SELECT event_type FROM audit_events WHERE event_type IN ('player_banned', 'player_unbanned') ORDER BY rowid")
        .all(),
    ).toEqual([{ event_type: "player_banned" }, { event_type: "player_unbanned" }]);
  });

  it("charges only worsening penalty deltas within one round", async () => {
    await activate();
    await service.processMessage(message("100", "alice", "1"));
    await service.processMessage(message("101", "alice", "2"));
    await service.processMessage(message("102", "bob", "1"));
    await service.processMessage(message("103", "alice", "2"));
    await service.processMessage(message("104", "alice", "4"));

    expect(
      context.database
        .prepare("SELECT worst_severity FROM round_player_penalties WHERE player_id = 'alice'")
        .get(),
    ).toEqual({ worst_severity: -3 });
    expect(
      context.database
        .prepare(
          "SELECT delta FROM score_ledger WHERE player_id = 'alice' AND entry_type = 'penalty' ORDER BY rowid",
        )
        .all(),
    ).toEqual([{ delta: -2 }, { delta: -1 }]);
  });

  it("commits participation and stacked bonus rewards on completion", async () => {
    await activate({
      target: 3,
      bonusRules: [{ id: "even", predicate: { kind: "divisible_by", divisor: 2 } }],
    });
    await service.processMessage(message("100", "alice", "1"));
    await service.processMessage(message("101", "bob", "2"));
    await service.processMessage(message("102", "alice", "3"));

    expect(context.database.prepare("SELECT state FROM rounds").get()).toEqual({ state: "completed" });
    expect(context.repository.leaderboard()).toEqual([
      { playerId: "alice", displayName: "alice", total: 4 },
      { playerId: "bob", displayName: "bob", total: 3 },
    ]);
    expect(
      context.database
        .prepare("SELECT operation_type FROM discord_outbox ORDER BY sequence_number DESC LIMIT 2")
        .all(),
    ).toEqual([
      { operation_type: "leaderboard_publication" },
      { operation_type: "completion_announcement" },
    ]);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM round_bans")).toBe(0);
  });

  it("cancels provisionally scored attempts while retaining committed penalties", async () => {
    await activate();
    await service.processMessage(message("100", "alice", "1"));
    await service.processMessage(message("101", "alice", "2"));
    await service.processMessage(message("102", "bob", "1"));
    await service.banPlayer("charlie", "Charlie", "admin");

    await service.cancelRound("admin");

    expect(context.database.prepare("SELECT state FROM rounds").get()).toEqual({ state: "cancelled" });
    expect(scalar(context, "SELECT COUNT(*) AS value FROM attempt_contributions")).toBe(0);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM round_bans")).toBe(0);
    expect(context.repository.leaderboard()).toEqual([
      { playerId: "alice", displayName: "alice", total: -2 },
    ]);
  });

  it("enforces one active round and blocks season reset while active", async () => {
    await activate();
    const second = context.adminRepository.createTemplate(roundTemplate({ name: "Second" }));

    await expect(service.activateRound(second)).rejects.toThrow(/active round/i);
    await expect(service.resetSeason()).rejects.toThrow(/active round/i);
  });

  it("blocks activation and season reset until terminal Discord work is settled", async () => {
    await activate();
    await service.cancelRound("admin");
    const second = context.adminRepository.createTemplate(roundTemplate({ name: "Second" }));

    await expect(service.resetSeason()).rejects.toThrow(/terminal Discord work/i);
    await expect(service.activateRound(second)).rejects.toThrow(/terminal Discord work/i);

    context.database
      .prepare("UPDATE rounds SET operationally_settled_at = ? WHERE state = 'cancelled'")
      .run("settled");
    await expect(service.resetSeason()).resolves.toEqual(expect.any(String));
    await expect(service.activateRound(second)).resolves.toEqual(expect.any(String));
  });
});

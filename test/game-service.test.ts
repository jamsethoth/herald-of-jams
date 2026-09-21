import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { GameService } from "../src/application/game-service.js";
import { DEFAULT_ANNOUNCEMENTS } from "../src/domain/announcement-templates.js";
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

function outboxContents(context: TestDatabaseContext, operationType: string): string[] {
  return (
    context.database
      .prepare(
        `SELECT payload_json FROM discord_outbox
         WHERE operation_type = ? ORDER BY sequence_number`,
      )
      .all(operationType) as { payload_json: string }[]
  ).map(({ payload_json }) => (JSON.parse(payload_json) as { content: string }).content);
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
      { operation_type: "start_announcement", sequence_number: 1, predecessor_id: null },
      {
        operation_type: "canonical_message",
        sequence_number: 2,
        predecessor_id: expect.any(String),
      },
      {
        operation_type: "delete_original",
        sequence_number: 3,
        predecessor_id: expect.any(String),
      },
    ]);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM compiled_entries")).toBe(5);
    const nonces = context.database.prepare("SELECT nonce FROM discord_outbox").all() as { nonce: string }[];
    expect(nonces.every(({ nonce }) => nonce.length <= 25)).toBe(true);
  });

  it("queues the snapshotted start announcement when activation commits", async () => {
    const templateId = context.adminRepository.createTemplate(
      roundTemplate({ announcements: { start: "Begin at {start}" } }),
    );

    await service.activateRound(templateId);
    context.adminRepository.updateAnnouncementDefaults(
      { ...DEFAULT_ANNOUNCEMENTS, start: "Changed after activation" },
      "admin",
    );

    expect(outboxContents(context, "start_announcement")).toEqual(["Begin at 1"]);
    const compiled = JSON.parse(
      (
        context.database.prepare("SELECT compiled_config_json FROM rounds").get() as {
          compiled_config_json: string;
        }
      ).compiled_config_json,
    ) as { announcements: { start: string } };
    expect(compiled.announcements.start).toBe("Begin at {start}");
  });

  it("rolls back activation when the start announcement cannot be queued", async () => {
    const templateId = context.adminRepository.createTemplate(roundTemplate());
    context.database.exec(`
      CREATE TRIGGER fail_start_outbox BEFORE INSERT ON discord_outbox
      WHEN NEW.operation_type = 'start_announcement'
      BEGIN SELECT RAISE(ABORT, 'forced start outbox failure'); END;
    `);

    await expect(service.activateRound(templateId)).rejects.toThrow(/forced start outbox failure/);

    expect(scalar(context, "SELECT COUNT(*) AS value FROM rounds")).toBe(0);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM compiled_entries")).toBe(0);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM seasons")).toBe(0);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM discord_outbox")).toBe(0);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM audit_events")).toBe(0);
  });

  it("splits a maximum-length canonical submission into valid Discord messages", async () => {
    await activate();
    await service.processMessage(message("100", "alice", "1"));
    const digits = "9".repeat(2_000);
    await service.processMessage(message("101", "bob", digits));

    const payloads = context.database
      .prepare(
        `SELECT payload_json FROM discord_outbox
         WHERE operation_type = 'canonical_message'
           AND json_extract(payload_json, '$.submissionId') = '101'
         ORDER BY sequence_number`,
      )
      .all() as { payload_json: string }[];
    const contents = payloads.map(({ payload_json }) =>
      (JSON.parse(payload_json) as { content: string }).content,
    );
    expect(contents.length).toBeGreaterThan(1);
    expect(contents.every((content) => content.length <= 2_000)).toBe(true);
    expect(contents.map((content, index) => content.slice(index === 0 ? "bob: ".length : "↳ ".length)).join(""))
      .toBe(digits);
  });

  it("derives Discord-valid nonces from production UUID operation IDs", async () => {
    const productionService = new GameService(
      context.repository,
      context.adminRepository,
      context.clock,
      { next: () => randomUUID() },
    );
    const templateId = context.adminRepository.createTemplate(roundTemplate());
    await productionService.activateRound(templateId);
    await productionService.processMessage(message("100", "alice", "1"));

    const nonces = context.database.prepare("SELECT nonce FROM discord_outbox").all() as { nonce: string }[];
    expect(nonces).toHaveLength(3);
    expect(nonces.every(({ nonce }) => nonce.length === 25)).toBe(true);
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
    expect(scalar(context, "SELECT COUNT(*) AS value FROM discord_outbox")).toBe(1);
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

  it("completes a one-value round using its activation-time announcement snapshot", async () => {
    const templateId = context.adminRepository.createTemplate(
      roundTemplate({
        start: 2,
        target: 2,
        bonusRules: [{ id: "prime", predicate: { kind: "prime" } }],
        announcements: {
          bonus: "Custom {player} +{bonusPoints}",
          completion: "Custom complete",
        },
      }),
    );
    await service.activateRound(templateId);
    context.adminRepository.updateAnnouncementDefaults(
      { ...DEFAULT_ANNOUNCEMENTS, completion: "Changed after activation" },
      "admin",
    );

    await service.processMessage(message("100", "alice", "2"));

    expect(context.database.prepare("SELECT state FROM rounds").get()).toEqual({
      state: "completed",
    });
    expect(outboxContents(context, "bonus_announcement")).toEqual(["Custom alice +1"]);
    expect(outboxContents(context, "completion_announcement")).toEqual(["Custom complete"]);
  });

  it("resolves an inherited global announcement when the round is activated", async () => {
    const templateId = context.adminRepository.createTemplate(
      roundTemplate({ start: 1, target: 1 }),
    );
    context.adminRepository.updateAnnouncementDefaults(
      { ...DEFAULT_ANNOUNCEMENTS, completion: "Current global completion" },
      "admin",
    );

    await service.activateRound(templateId);
    await service.processMessage(message("100", "alice", "1"));

    const compiled = JSON.parse(
      (
        context.database.prepare("SELECT compiled_config_json FROM rounds").get() as {
          compiled_config_json: string;
        }
      ).compiled_config_json,
    ) as { announcements: { completion: string } };
    expect(compiled.announcements.completion).toBe("Current global completion");
    expect(outboxContents(context, "completion_announcement")).toEqual([
      "Current global completion",
    ]);
  });

  it("falls back to built-in reset wording for a pre-revision compiled round", async () => {
    await activate();
    const row = context.database.prepare("SELECT compiled_config_json FROM rounds").get() as {
      compiled_config_json: string;
    };
    const compiled = JSON.parse(row.compiled_config_json) as Record<string, unknown>;
    delete compiled.announcements;
    context.database
      .prepare("UPDATE rounds SET compiled_config_json = ?")
      .run(JSON.stringify(compiled));
    await service.processMessage(message("100", "alice", "1"));

    await service.processMessage(message("101", "alice", "2"));

    expect(outboxContents(context, "reset_announcement")).toEqual([
      DEFAULT_ANNOUNCEMENTS.reset.replace("{start}", "1"),
    ]);
  });

  it("cancels provisional rewards and removes penalties owned by the round", async () => {
    await activate();
    await service.processMessage(message("100", "alice", "1"));
    await service.processMessage(message("101", "alice", "2"));
    await service.processMessage(message("102", "bob", "1"));
    await service.banPlayer("charlie", "Charlie", "admin");

    await service.cancelRound("admin");

    expect(context.database.prepare("SELECT state FROM rounds").get()).toEqual({ state: "cancelled" });
    expect(scalar(context, "SELECT COUNT(*) AS value FROM attempt_contributions")).toBe(0);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM round_bans")).toBe(0);
    expect(context.repository.leaderboard()).toEqual([]);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM score_ledger WHERE entry_type = 'penalty'"))
      .toBe(0);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM round_player_penalties")).toBe(0);
    expect(outboxContents(context, "cancellation_announcement")).toEqual([
      DEFAULT_ANNOUNCEMENTS.cancellation,
    ]);
    const cancellationAudit = context.database
      .prepare("SELECT details_json FROM audit_events WHERE event_type = 'round_cancelled'")
      .get() as { details_json: string };
    expect(JSON.parse(cancellationAudit.details_json)).toMatchObject({
      discardedPenaltyEntries: 1,
      discardedPenaltyPoints: 2,
    });
  });

  it("rolls back every cancellation change when terminal output cannot be queued", async () => {
    await activate();
    await service.processMessage(message("100", "alice", "1"));
    await service.processMessage(message("101", "alice", "2"));
    await service.processMessage(message("102", "bob", "1"));
    await service.banPlayer("charlie", "Charlie", "admin");
    context.database.exec(`
      CREATE TRIGGER fail_cancellation_outbox BEFORE INSERT ON discord_outbox
      WHEN NEW.operation_type = 'cancellation_announcement'
      BEGIN SELECT RAISE(ABORT, 'forced cancellation outbox failure'); END;
    `);

    await expect(service.cancelRound("admin")).rejects.toThrow(
      /forced cancellation outbox failure/,
    );

    expect(context.database.prepare("SELECT state FROM rounds").get()).toEqual({ state: "counting" });
    expect(scalar(context, "SELECT COUNT(*) AS value FROM score_ledger WHERE entry_type = 'penalty'"))
      .toBe(1);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM round_player_penalties")).toBe(1);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM round_bans")).toBe(1);
    expect(scalar(context, "SELECT COUNT(*) AS value FROM attempt_contributions")).toBe(1);
    expect(
      scalar(
        context,
        "SELECT COUNT(*) AS value FROM discord_outbox WHERE operation_type = 'cancellation_announcement'",
      ),
    ).toBe(0);
    expect(
      scalar(
        context,
        "SELECT COUNT(*) AS value FROM audit_events WHERE event_type = 'round_cancelled'",
      ),
    ).toBe(0);
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

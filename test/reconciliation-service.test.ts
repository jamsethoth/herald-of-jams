import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GameService } from "../src/application/game-service.js";
import { ReconciliationService } from "../src/application/reconciliation-service.js";
import { SerialExecutor } from "../src/application/serial-executor.js";
import { createTestDatabase, message, roundTemplate, type TestDatabaseContext } from "./fixtures.js";
import { FakeDiscordTransport } from "./fake-discord-transport.js";

describe("ReconciliationService", () => {
  let context: TestDatabaseContext;
  let gameService: GameService;
  let transport: FakeDiscordTransport;
  let reconciler: ReconciliationService;

  beforeEach(async () => {
    context = createTestDatabase();
    gameService = new GameService(
      context.repository,
      context.adminRepository,
      context.clock,
      context.ids,
    );
    transport = new FakeDiscordTransport();
    reconciler = new ReconciliationService(
      transport,
      gameService,
      context.repository,
      new SerialExecutor(),
      context.clock,
    );
  });

  afterEach(() => context.close());

  async function activate(overrides = {}) {
    const templateId = context.adminRepository.createTemplate(roundTemplate(overrides));
    await gameService.activateRound(templateId);
  }

  it("sorts reverse history by BigInt ID and advances the checkpoint after committed dispositions", async () => {
    await activate({ target: 3 });
    transport.addHistory(
      message("102", "alice", "3"),
      message("101", "bob", "2"),
      message("100", "alice", "1"),
    );

    const result = await reconciler.reconcile("channel-1");

    expect(result).toEqual({
      highWaterMessageId: "102",
      examinedCount: 3,
      completed: true,
    });
    expect(
      context.database
        .prepare("SELECT message_id, decision FROM submissions ORDER BY rowid")
        .all(),
    ).toEqual([
      { message_id: "100", decision: "accepted" },
      { message_id: "101", decision: "accepted" },
      { message_id: "102", decision: "accepted" },
    ]);
    expect(context.database.prepare("SELECT last_examined_message_id FROM channel_checkpoints").get()).toEqual({
      last_examined_message_id: "102",
    });
    expect(
      context.database
        .prepare("SELECT operation_type FROM discord_outbox ORDER BY sequence_number")
        .all(),
    ).toEqual(
      expect.arrayContaining([
        { operation_type: "canonical_message" },
        { operation_type: "delete_original" },
      ]),
    );
  });

  it("invalidates every later numeric after the first reconnect break before announcing reset", async () => {
    await activate();
    transport.addHistory(
      message("105", "dana", "2"),
      message("104", "charlie", "1"),
      message("103", "alice", "4"),
      message("102", "alice", "3"),
      message("101", "bob", "2"),
      message("100", "alice", "1"),
    );

    const result = await reconciler.reconcile("channel-1");

    expect(result.breakingMessageId).toBe("103");
    expect(context.repository.submission("104")?.decision).toBe(
      "invalidated_after_reconnect_break",
    );
    expect(context.repository.submission("105")?.decision).toBe(
      "invalidated_after_reconnect_break",
    );
    expect(context.repository.activeRoundState()).toBe("waiting_for_start");
    expect(
      context.database
        .prepare(
          `SELECT operation_type, sequence_number, json_extract(payload_json, '$.messageId') AS message_id,
                  json_extract(payload_json, '$.submissionId') AS submission_id
           FROM discord_outbox ORDER BY sequence_number`,
        )
        .all()
        .filter((row) => {
          const item = row as { message_id: string | null; submission_id: string | null };
          return (
            item.message_id === "103" ||
            item.message_id === "104" ||
            item.message_id === "105" ||
            item.submission_id === "103"
          );
        }),
    ).toEqual([
      expect.objectContaining({ operation_type: "canonical_message", submission_id: "103" }),
      expect.objectContaining({ operation_type: "delete_original", message_id: "103" }),
      expect.objectContaining({ operation_type: "delete_original", message_id: "104" }),
      expect.objectContaining({ operation_type: "delete_original", message_id: "105" }),
      expect.objectContaining({ operation_type: "reset_announcement", submission_id: "103" }),
    ]);
    expect(
      context.database
        .prepare(
          `SELECT COUNT(*) AS value FROM discord_outbox
           WHERE operation_type = 'canonical_message'
             AND json_extract(payload_json, '$.submissionId') IN ('104', '105')`,
        )
        .get(),
    ).toEqual({ value: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS value FROM attempt_contributions").get()).toEqual({
      value: 0,
    });
    expect(context.database.prepare("SELECT COUNT(*) AS value FROM score_ledger").get()).toEqual({
      value: 1,
    });
  });

  it("converges after restart at accepted, delivered, break, and invalidation boundaries", async () => {
    await activate();
    const history = [
      message("100", "alice", "1"),
      message("101", "bob", "2"),
      message("102", "bob", "4"),
      message("103", "charlie", "1"),
    ];
    transport.addHistory(...history);

    await gameService.processMessage(history[0]!);
    context.database
      .prepare("UPDATE channel_checkpoints SET last_examined_message_id = '0' WHERE channel_id = 'channel-1'")
      .run();
    await reconciler.reconcile("channel-1");
    await reconciler.reconcile("channel-1");

    expect(
      context.database.prepare("SELECT message_id, COUNT(*) AS count FROM submissions GROUP BY message_id").all(),
    ).toEqual([
      { message_id: "100", count: 1 },
      { message_id: "101", count: 1 },
      { message_id: "102", count: 1 },
      { message_id: "103", count: 1 },
    ]);
    expect(
      context.database
        .prepare("SELECT COUNT(*) AS value FROM discord_outbox WHERE operation_type = 'reset_announcement'")
        .get(),
    ).toEqual({ value: 1 });
    expect(context.database.prepare("SELECT last_examined_message_id FROM channel_checkpoints").get()).toEqual({
      last_examined_message_id: "103",
    });
  });

  it("recovers a deferred reset after restart during invalidation cleanup", async () => {
    await activate();
    const history = [
      message("100", "alice", "1"),
      message("101", "bob", "2"),
      message("102", "bob", "4"),
      message("103", "charlie", "1"),
    ];
    transport.addHistory(...history);
    await gameService.processMessage(history[0]!);
    await gameService.processMessage(history[1]!);
    await gameService.processMessage(history[2]!, { deferResetAnnouncement: true });
    await gameService.invalidateAfterReconnectBreak(history[3]!, "102");
    context.database
      .prepare(
        `INSERT INTO channel_checkpoints (channel_id, last_examined_message_id, updated_at)
         VALUES ('channel-1', '103', 'now')`,
      )
      .run();

    const restarted = new ReconciliationService(
      transport,
      gameService,
      context.repository,
      new SerialExecutor(),
      context.clock,
    );
    const result = await restarted.reconcile("channel-1");

    expect(result.breakingMessageId).toBe("102");
    expect(
      context.database
        .prepare("SELECT COUNT(*) AS value FROM submissions WHERE message_id = '103'")
        .get(),
    ).toEqual({ value: 1 });
    expect(
      context.database
        .prepare("SELECT COUNT(*) AS value FROM discord_outbox WHERE operation_type = 'reset_announcement'")
        .get(),
    ).toEqual({ value: 1 });
  });

  it("performs a final catch-up pass before releasing queued live work", async () => {
    await activate({ target: 3 });
    transport.addHistory(message("100", "alice", "1"));
    const originalLatest = transport.getLatestMessageId.bind(transport);
    let calls = 0;
    transport.getLatestMessageId = async (channelId) => {
      calls += 1;
      if (calls === 2) {
        transport.addHistory(message("101", "bob", "2"), message("102", "alice", "3"));
      }
      return originalLatest(channelId);
    };

    const result = await reconciler.reconcile("channel-1");

    expect(result.highWaterMessageId).toBe("102");
    expect(result.completed).toBe(true);
  });

  it("does not reopen invalidation for a duplicate historical break", async () => {
    await activate();
    const live = [
      message("100", "alice", "1"),
      message("101", "alice", "9"),
      message("102", "bob", "1"),
    ];
    for (const item of live) await gameService.processMessage(item);
    context.database
      .prepare(
        `INSERT INTO channel_checkpoints (channel_id, last_examined_message_id, updated_at)
         VALUES ('channel-1', '100', 'now')`,
      )
      .run();
    transport.addHistory(...live, message("103", "charlie", "2"));

    await reconciler.reconcile("channel-1");

    expect(context.repository.submission("103")?.decision).toBe("accepted");
  });
});

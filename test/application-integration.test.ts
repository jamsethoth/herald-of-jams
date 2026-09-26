import { afterEach, describe, expect, it } from "vitest";

import { ApplicationRuntime } from "../src/main.js";
import { GameService } from "../src/application/game-service.js";
import { OutboxDispatcher } from "../src/application/outbox-dispatcher.js";
import { OutboxRepository } from "../src/db/outbox-repository.js";
import { createTestDatabase, message, roundTemplate, type TestDatabaseContext } from "./fixtures.js";
import { FakeDiscordTransport } from "./fake-discord-transport.js";
import { RuntimeHealth } from "../src/runtime/health.js";

describe("ApplicationRuntime", () => {
  it("gates live intake behind migration, command registration, connection, reconciliation, and dispatch", async () => {
    const events: string[] = [];
    const health = new RuntimeHealth();
    const runtime = new ApplicationRuntime({
      health,
      migrate: () => void events.push("migrate"),
      loadActiveChannel: () => {
        events.push("load-active-state");
        return "channel-1";
      },
      startHttp: async () => void events.push("http-start"),
      connectDiscord: async () => {
        events.push("register-command");
        events.push("connect");
      },
      reconcile: async () => {
        expect(health.snapshot()).toEqual({ status: "reconciling" });
        events.push("reconcile");
      },
      dispatchPending: async () => void events.push("dispatch"),
      enableLiveIntake: () => void events.push("live"),
      stopHttp: async () => void events.push("http-stop"),
      stopDiscord: async () => void events.push("gateway-stop"),
      drainWork: async () => void events.push("drain"),
      closeDatabase: () => void events.push("database-close"),
    });

    await runtime.start();
    expect(health.snapshot()).toEqual({ status: "ready" });
    expect(events.filter((event) => event !== "http-start")).toEqual([
      "migrate",
      "load-active-state",
      "register-command",
      "connect",
      "reconcile",
      "dispatch",
      "live",
    ]);
    await runtime.shutdown();
    expect(events.slice(-4)).toEqual(["http-stop", "gateway-stop", "drain", "database-close"]);
  });

  it("makes start and shutdown idempotent", async () => {
    let starts = 0;
    let closes = 0;
    const runtime = new ApplicationRuntime({
      migrate: () => undefined,
      loadActiveChannel: () => null,
      startHttp: async () => void (starts += 1),
      connectDiscord: async () => undefined,
      reconcile: async () => undefined,
      dispatchPending: async () => undefined,
      enableLiveIntake: () => undefined,
      stopHttp: async () => undefined,
      stopDiscord: async () => undefined,
      drainWork: async () => undefined,
      closeDatabase: () => void (closes += 1),
    });
    await runtime.start();
    await runtime.start();
    await runtime.shutdown();
    await runtime.shutdown();
    expect({ starts, closes }).toEqual({ starts: 1, closes: 1 });
  });
});

describe("restart convergence", () => {
  let context: TestDatabaseContext;
  afterEach(() => context?.close());

  it("recovers before-send, ambiguous-send, deletion, reset, and leaderboard boundaries", async () => {
    context = createTestDatabase();
    const service = new GameService(
      context.repository,
      context.adminRepository,
      context.clock,
      context.ids,
    );
    const templateId = context.adminRepository.createTemplate(
      roundTemplate({ target: 2, bonusRules: [{ id: "finish", predicate: { kind: "one_of", values: [2] } }] }),
    );
    await service.activateRound(templateId);
    await service.processMessage(message("100", "alice", "1"));
    await service.processMessage(message("101", "bob", "2"));
    const transport = new FakeDiscordTransport();
    const outbox = new OutboxRepository(context.database, context.clock, context.ids);
    let dispatcher = new OutboxDispatcher(outbox, transport, context.clock);
    const operations = context.database
      .prepare("SELECT id, nonce, operation_type FROM discord_outbox ORDER BY sequence_number")
      .all() as { id: string; nonce: string; operation_type: string }[];
    transport.acceptThenLoseResponse(operations[0]!.nonce);
    await dispatcher.dispatchNext("channel-1");

    dispatcher = new OutboxDispatcher(
      new OutboxRepository(context.database, context.clock, context.ids),
      transport,
      context.clock,
    );
    for (let guard = 0; guard < 20; guard += 1) {
      const result = await dispatcher.dispatchNext("channel-1");
      if (result.kind === "idle" || result.kind === "needs_review") break;
    }

    expect(transport.sentCount(operations[0]!.nonce)).toBe(1);
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM submissions").get()).toEqual({ count: 2 });
    expect(
      context.database
        .prepare("SELECT operation_type, status FROM discord_outbox ORDER BY sequence_number")
        .all(),
    ).toEqual(
      operations.map(({ operation_type }) => ({ operation_type, status: "delivered" })),
    );
    expect(context.database.prepare("SELECT operationally_settled_at IS NOT NULL AS settled FROM rounds").get()).toEqual({ settled: 1 });
  });
});

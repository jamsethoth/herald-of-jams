import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OutboxDispatcher } from "../src/application/outbox-dispatcher.js";
import { OutboxRepository } from "../src/db/outbox-repository.js";
import { createTestDatabase, type TestDatabaseContext } from "./fixtures.js";
import { FakeDiscordTransport } from "./fake-discord-transport.js";

describe("OutboxDispatcher", () => {
  let context: TestDatabaseContext;
  let outbox: OutboxRepository;
  let transport: FakeDiscordTransport;
  let dispatcher: OutboxDispatcher;

  beforeEach(() => {
    context = createTestDatabase();
    outbox = new OutboxRepository(context.database, context.clock, context.ids);
    transport = new FakeDiscordTransport();
    dispatcher = new OutboxDispatcher(outbox, transport, context.clock);
  });

  afterEach(() => context.close());

  function insert(
    id: string,
    sequence: number,
    operationType: "canonical_message" | "delete_original" = "canonical_message",
    payload: Record<string, string> = { content: "hello" },
    createdAt = context.clock.now().toISOString(),
  ) {
    const predecessor =
      sequence === 1
        ? null
        : (context.database
            .prepare("SELECT id FROM discord_outbox WHERE channel_id = 'channel-1' AND sequence_number = ?")
            .get(sequence - 1) as { id: string }).id;
    context.database
      .prepare(
        `INSERT INTO discord_outbox
          (id, channel_id, sequence_number, predecessor_id, operation_type, payload_json,
           nonce, status, created_at)
         VALUES (?, 'channel-1', ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        sequence,
        predecessor,
        operationType,
        JSON.stringify(payload),
        `nonce-${id}`,
        createdAt,
      );
    return outbox.get(id)!;
  }

  it("never starts N+1 until N is delivered and resumes in sequence", async () => {
    const first = insert("one", 1);
    insert("two", 2, "delete_original", { messageId: "original-2" });
    transport.scriptSend(first.nonce, "definite_failure", "success");

    await expect(dispatcher.dispatchNext("channel-1")).resolves.toMatchObject({ kind: "retry_scheduled" });
    await expect(dispatcher.dispatchNext("channel-1")).resolves.toEqual({ kind: "idle" });
    expect(transport.deletedCount("original-2")).toBe(0);

    context.clock.advance(1_000);
    await expect(dispatcher.dispatchNext("channel-1")).resolves.toMatchObject({ kind: "delivered", operationId: "one" });
    await expect(dispatcher.dispatchNext("channel-1")).resolves.toMatchObject({ kind: "delivered", operationId: "two" });
    expect(transport.deletedCount("original-2")).toBe(1);
  });

  it("reconciles stale delivering work after restart before sending", async () => {
    const operation = insert("one", 1);
    context.database
      .prepare("UPDATE discord_outbox SET status = 'delivering', last_error = 'process stopped' WHERE id = ?")
      .run(operation.id);

    const restarted = new OutboxDispatcher(
      new OutboxRepository(context.database, context.clock, context.ids),
      transport,
      context.clock,
    );
    await restarted.dispatchNext("channel-1");

    expect(transport.sentCount(operation.nonce)).toBe(1);
    expect(outbox.status(operation.id)).toBe("delivered");
  });

  it("treats deletion of an already absent original as delivered", async () => {
    const operation = insert("delete", 1, "delete_original", { messageId: "gone" });
    transport.scriptDelete("gone", "already_absent");

    await dispatcher.dispatchNext("channel-1");

    expect(outbox.status(operation.id)).toBe("delivered");
  });

  it("schedules deterministic bounded exponential retries after definite failures", async () => {
    const operation = insert("one", 1);
    transport.scriptSend(
      operation.nonce,
      "definite_failure",
      "definite_failure",
      "definite_failure",
    );

    await dispatcher.dispatchNext("channel-1");
    expect(outbox.get(operation.id)?.nextAttemptAt).toBe("2026-09-21T00:00:01.000Z");
    context.clock.advance(1_000);
    await dispatcher.dispatchNext("channel-1");
    expect(outbox.get(operation.id)?.nextAttemptAt).toBe("2026-09-21T00:00:03.000Z");

    context.database
      .prepare(
        "UPDATE discord_outbox SET attempt_count = 30, status = 'pending', next_attempt_at = NULL WHERE id = ?",
      )
      .run(operation.id);
    await dispatcher.dispatchNext("channel-1");
    expect(outbox.get(operation.id)?.nextAttemptAt).toBe("2026-09-21T00:05:01.000Z");
  });

  it("reconciles an accepted create after a lost response without duplicating it", async () => {
    const operation = insert("one", 1);
    transport.acceptThenLoseResponse(operation.nonce);

    await dispatcher.dispatchNext("channel-1");
    expect(transport.sentCount(operation.nonce)).toBe(1);
    await dispatcher.dispatchNext("channel-1");

    expect(transport.sentCount(operation.nonce)).toBe(1);
    expect(outbox.status(operation.id)).toBe("delivered");
  });

  it("requires review instead of resending ambiguous work outside the nonce window", async () => {
    const old = new Date(context.clock.now().getTime() - 10 * 60_000).toISOString();
    const operation = insert("one", 1, "canonical_message", { content: "hello" }, old);
    transport.loseResponseWithoutMatch(operation.nonce);

    await dispatcher.dispatchNext("channel-1");
    await dispatcher.dispatchNext("channel-1");

    expect(transport.sentCount(operation.nonce)).toBe(1);
    expect(outbox.status(operation.id)).toBe("needs_review");
  });

  it("returns ambiguous lookup failures to retry_wait instead of stranding delivery", async () => {
    const operation = insert("one", 1);
    context.database
      .prepare("UPDATE discord_outbox SET status = 'retry_wait', last_error = 'ambiguous: lost response'")
      .run();
    transport.findOwnMessageByNonce = async () => {
      throw new Error("history unavailable");
    };

    await expect(dispatcher.dispatchNext("channel-1")).resolves.toMatchObject({
      kind: "retry_scheduled",
      operationId: operation.id,
    });
    expect(outbox.status(operation.id)).toBe("retry_wait");
    expect(outbox.get(operation.id)?.lastError).toContain("ambiguous:");
  });

  it("audits manual delivery and abandonment resolutions", () => {
    const delivered = insert("one", 1);
    const abandoned = insert("two", 2);
    context.database
      .prepare("UPDATE discord_outbox SET status = 'needs_review' WHERE id IN (?, ?)")
      .run(delivered.id, abandoned.id);

    outbox.markDelivered(delivered.id, "discord-1", "admin");
    outbox.abandon(abandoned.id, "confirmed absent", "admin");

    expect(outbox.status(delivered.id)).toBe("delivered");
    expect(outbox.status(abandoned.id)).toBe("abandoned");
    expect(
      context.database
        .prepare("SELECT event_type FROM audit_events ORDER BY rowid")
        .all(),
    ).toEqual([
      { event_type: "outbox_marked_delivered" },
      { event_type: "outbox_abandoned" },
    ]);
  });
});

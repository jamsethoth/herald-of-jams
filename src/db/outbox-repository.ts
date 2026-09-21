import type Database from "better-sqlite3";

import type { Clock, IdGenerator } from "../application/contracts.js";

export type OutboxStatus =
  | "pending"
  | "delivering"
  | "delivered"
  | "retry_wait"
  | "needs_review"
  | "abandoned";

export interface OutboxOperation {
  id: string;
  channelId: string;
  sequenceNumber: number;
  predecessorId: string | null;
  operationType: string;
  payload: Record<string, unknown>;
  nonce: string;
  status: OutboxStatus;
  attemptCount: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  discordMessageId: string | null;
  createdAt: string;
}

interface OutboxRow {
  id: string;
  channel_id: string;
  sequence_number: number;
  predecessor_id: string | null;
  operation_type: string;
  payload_json: string;
  nonce: string;
  status: OutboxStatus;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: string | null;
  discord_message_id: string | null;
  created_at: string;
}

function mapRow(row: OutboxRow): OutboxOperation {
  return {
    id: row.id,
    channelId: row.channel_id,
    sequenceNumber: row.sequence_number,
    predecessorId: row.predecessor_id,
    operationType: row.operation_type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    nonce: row.nonce,
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    discordMessageId: row.discord_message_id,
    createdAt: row.created_at,
  };
}

export class OutboxRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  get(id: string): OutboxOperation | undefined {
    const row = this.database.prepare("SELECT * FROM discord_outbox WHERE id = ?").get(id) as
      | OutboxRow
      | undefined;
    return row === undefined ? undefined : mapRow(row);
  }

  status(id: string): OutboxStatus | undefined {
    return (
      this.database.prepare("SELECT status FROM discord_outbox WHERE id = ?").get(id) as
        | { status: OutboxStatus }
        | undefined
    )?.status;
  }

  recoverStaleDeliveries(): void {
    const now = this.clock.now().toISOString();
    this.database
      .prepare(
        `UPDATE discord_outbox
         SET status = 'retry_wait', next_attempt_at = ?,
             last_error = 'ambiguous: process stopped while delivery was in progress'
         WHERE status = 'delivering'`,
      )
      .run(now);
  }

  claimNext(channelId: string): OutboxOperation | undefined {
    return this.database
      .transaction(() => {
        const row = this.database
          .prepare(
            `SELECT * FROM discord_outbox
             WHERE channel_id = ? AND status NOT IN ('delivered', 'abandoned')
             ORDER BY sequence_number LIMIT 1`,
          )
          .get(channelId) as OutboxRow | undefined;
        if (
          row === undefined ||
          (row.status !== "pending" && row.status !== "retry_wait") ||
          (row.next_attempt_at !== null && row.next_attempt_at > this.clock.now().toISOString())
        ) {
          return undefined;
        }
        const predecessorResolved =
          row.predecessor_id === null ||
          this.database
            .prepare(
              "SELECT 1 FROM discord_outbox WHERE id = ? AND status IN ('delivered', 'abandoned')",
            )
            .get(row.predecessor_id) !== undefined;
        if (!predecessorResolved) {
          return undefined;
        }
        this.database
          .prepare(
            `UPDATE discord_outbox
             SET status = 'delivering', attempt_count = attempt_count + 1, next_attempt_at = NULL
             WHERE id = ?`,
          )
          .run(row.id);
        return { ...mapRow(row), status: "delivering" as const, attemptCount: row.attempt_count + 1 };
      })
      .immediate();
  }

  recordDelivered(id: string, discordMessageId: string | null): void {
    this.database
      .transaction(() => {
        this.database
          .prepare(
            `UPDATE discord_outbox
             SET status = 'delivered', discord_message_id = COALESCE(?, discord_message_id),
                 resolved_at = ?, next_attempt_at = NULL, last_error = NULL
             WHERE id = ?`,
          )
          .run(discordMessageId, this.clock.now().toISOString(), id);
        this.settleTerminalRoundIfReady(id);
      })
      .immediate();
  }

  scheduleRetry(id: string, attemptCount: number, error: string): string {
    const delay = Math.min(300_000, 1_000 * 2 ** Math.max(0, attemptCount - 1));
    const nextAttemptAt = new Date(this.clock.now().getTime() + delay).toISOString();
    this.database
      .prepare(
        `UPDATE discord_outbox
         SET status = 'retry_wait', next_attempt_at = ?, last_error = ? WHERE id = ?`,
      )
      .run(nextAttemptAt, error.slice(0, 500), id);
    return nextAttemptAt;
  }

  scheduleAmbiguousReconciliation(id: string, error: string, delayMs = 0): string {
    const nextAttemptAt = new Date(this.clock.now().getTime() + delayMs).toISOString();
    this.database
      .prepare(
        `UPDATE discord_outbox
         SET status = 'retry_wait', next_attempt_at = ?, last_error = ? WHERE id = ?`,
      )
      .run(nextAttemptAt, `ambiguous: ${error.slice(0, 480)}`, id);
    return nextAttemptAt;
  }

  requireReview(id: string, error: string): void {
    this.database
      .prepare(
        `UPDATE discord_outbox
         SET status = 'needs_review', next_attempt_at = NULL, last_error = ? WHERE id = ?`,
      )
      .run(error.slice(0, 500), id);
  }

  retry(id: string, actorId: string): void {
    this.database
      .transaction(() => {
        const operation = this.get(id);
        if (operation === undefined || operation.status !== "retry_wait") {
          throw new Error("only definite retry-wait failures may be retried");
        }
        this.database
          .prepare(
            `UPDATE discord_outbox
             SET status = 'pending', next_attempt_at = NULL WHERE id = ?`,
          )
          .run(id);
        this.audit("outbox_retry_requested", operation, actorId, {});
      })
      .immediate();
  }

  markDelivered(id: string, discordMessageId: string, actorId: string): void {
    this.database
      .transaction(() => {
        const operation = this.requireReviewOperation(id);
        if (discordMessageId.length === 0) {
          throw new Error("Discord message ID is required");
        }
        this.database
          .prepare(
            `UPDATE discord_outbox
             SET status = 'delivered', discord_message_id = ?, resolved_at = ?, last_error = NULL
             WHERE id = ?`,
          )
          .run(discordMessageId, this.clock.now().toISOString(), id);
        this.audit("outbox_marked_delivered", operation, actorId, { discordMessageId });
        this.settleTerminalRoundIfReady(id);
      })
      .immediate();
  }

  abandon(id: string, reason: string, actorId: string): void {
    this.database
      .transaction(() => {
        const operation = this.requireReviewOperation(id);
        if (reason.trim().length === 0) {
          throw new Error("abandonment reason is required");
        }
        this.database
          .prepare(
            `UPDATE discord_outbox
             SET status = 'abandoned', resolved_at = ?, last_error = ? WHERE id = ?`,
          )
          .run(this.clock.now().toISOString(), reason.slice(0, 500), id);
        this.audit("outbox_abandoned", operation, actorId, { reason });
        this.settleTerminalRoundIfReady(id);
      })
      .immediate();
  }

  private requireReviewOperation(id: string): OutboxOperation {
    const operation = this.get(id);
    if (operation === undefined || operation.status !== "needs_review") {
      throw new Error("outbox operation is not awaiting review");
    }
    return operation;
  }

  private audit(
    eventType: string,
    operation: OutboxOperation,
    actorId: string,
    details: Record<string, unknown>,
  ): void {
    const roundId = typeof operation.payload.roundId === "string" ? operation.payload.roundId : null;
    this.database
      .prepare(
        `INSERT INTO audit_events (id, event_type, round_id, actor_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.ids.next(),
        eventType,
        roundId,
        actorId,
        JSON.stringify({ operationId: operation.id, ...details }),
        this.clock.now().toISOString(),
      );
  }

  private settleTerminalRoundIfReady(operationId: string): void {
    const operation = this.get(operationId);
    const roundId = operation?.payload.roundId;
    if (typeof roundId !== "string") {
      return;
    }
    const unresolved = this.database
      .prepare(
        `SELECT 1 FROM discord_outbox
         WHERE json_extract(payload_json, '$.roundId') = ?
           AND status NOT IN ('delivered', 'abandoned') LIMIT 1`,
      )
      .get(roundId);
    if (unresolved === undefined) {
      this.database
        .prepare(
          `UPDATE rounds SET operationally_settled_at = ?
           WHERE id = ? AND state IN ('completed', 'cancelled')`,
        )
        .run(this.clock.now().toISOString(), roundId);
    }
  }
}

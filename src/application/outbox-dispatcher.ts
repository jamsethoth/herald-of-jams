import type { Clock, DiscordTransport } from "./contracts.js";
import type { OutboxOperation, OutboxRepository } from "../db/outbox-repository.js";

const NONCE_UNIQUENESS_WINDOW_MS = 5 * 60_000;

export class DefiniteDiscordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefiniteDiscordError";
  }
}

export class AmbiguousDiscordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AmbiguousDiscordError";
  }
}

export type DispatchResult =
  | { kind: "idle" }
  | { kind: "delivered"; operationId: string }
  | { kind: "retry_scheduled"; operationId: string; nextAttemptAt: string }
  | { kind: "needs_review"; operationId: string };

function requiredString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new DefiniteDiscordError(`outbox payload is missing ${key}`);
  }
  return value;
}

export class OutboxDispatcher {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly transport: DiscordTransport,
    private readonly clock: Clock,
  ) {
    this.outbox.recoverStaleDeliveries();
  }

  async dispatchNext(channelId: string): Promise<DispatchResult> {
    const operation = this.outbox.claimNext(channelId);
    if (operation === undefined) {
      return { kind: "idle" };
    }

    const needsReconciliation = operation.lastError?.startsWith("ambiguous:") === true;
    if (needsReconciliation && operation.operationType !== "delete_original") {
      const found = await this.transport.findOwnMessageByNonce(
        operation.channelId,
        operation.nonce,
        operation.createdAt,
      );
      if (found !== null) {
        this.outbox.recordDelivered(operation.id, found.id);
        return { kind: "delivered", operationId: operation.id };
      }
      if (
        this.clock.now().getTime() - new Date(operation.createdAt).getTime() >=
        NONCE_UNIQUENESS_WINDOW_MS
      ) {
        this.outbox.requireReview(
          operation.id,
          "ambiguous delivery could not be reconciled outside the nonce uniqueness window",
        );
        return { kind: "needs_review", operationId: operation.id };
      }
    }

    try {
      const discordMessageId = await this.deliver(operation);
      this.outbox.recordDelivered(operation.id, discordMessageId);
      return { kind: "delivered", operationId: operation.id };
    } catch (error) {
      const description = error instanceof Error ? error.message : "unknown Discord delivery failure";
      if (error instanceof AmbiguousDiscordError) {
        this.outbox.scheduleAmbiguousReconciliation(operation.id, description);
        return {
          kind: "retry_scheduled",
          operationId: operation.id,
          nextAttemptAt: this.clock.now().toISOString(),
        };
      }
      const nextAttemptAt = this.outbox.scheduleRetry(
        operation.id,
        operation.attemptCount,
        description,
      );
      return { kind: "retry_scheduled", operationId: operation.id, nextAttemptAt };
    }
  }

  private async deliver(operation: OutboxOperation): Promise<string | null> {
    if (operation.operationType === "delete_original") {
      await this.transport.deleteMessage(
        operation.channelId,
        requiredString(operation.payload, "messageId"),
      );
      return null;
    }
    const sent = await this.transport.sendMessage({
      channelId: operation.channelId,
      content: requiredString(operation.payload, "content"),
      nonce: operation.nonce,
      enforceNonce: true,
      suppressNotifications: operation.operationType === "canonical_message",
    });
    return sent.id;
  }
}

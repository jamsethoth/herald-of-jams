import type { Clock, DiscordTransport, InboundDiscordMessage } from "./contracts.js";
import type { GameService } from "./game-service.js";
import type { SerialExecutor } from "./serial-executor.js";
import type { GameRepository } from "../db/game-repository.js";

export interface ReconciliationResult {
  highWaterMessageId: string | null;
  examinedCount: number;
  completed: boolean;
  breakingMessageId?: string;
}

function greaterThan(left: string, right: string): boolean {
  return BigInt(left) > BigInt(right);
}

export class ReconciliationService {
  constructor(
    private readonly transport: DiscordTransport,
    private readonly gameService: GameService,
    private readonly repository: GameRepository,
    private readonly executor: SerialExecutor,
    private readonly clock: Clock,
  ) {}

  async reconcile(channelId: string): Promise<ReconciliationResult> {
    return this.executor.run(channelId, async () => {
      let checkpoint = this.checkpoint(channelId);
      let highWater = await this.transport.getLatestMessageId(channelId);
      let examinedCount = 0;
      let breakingMessageId: string | undefined =
        this.repository.pendingReconnectBreak(channelId);
      let completed = false;

      while (highWater !== null && (checkpoint === null || greaterThan(highWater, checkpoint))) {
        const messages: InboundDiscordMessage[] = [];
        for await (const message of this.transport.listMessagesAfter(channelId, checkpoint)) {
          if (!greaterThan(message.id, highWater)) {
            messages.push(message);
          }
        }
        messages.sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));

        for (const message of messages) {
          let disposition;
          if (breakingMessageId === undefined && !completed) {
            disposition = await this.gameService.processMessage(message, {
              deferResetAnnouncement: true,
            });
            const stored = this.repository.submission(message.id);
            if (stored?.decision.startsWith("broken_") === true) {
              breakingMessageId = message.id;
            }
            completed = this.roundCompleted(stored?.roundId);
          } else if (breakingMessageId !== undefined) {
            disposition = await this.gameService.invalidateAfterReconnectBreak(
              message,
              breakingMessageId,
            );
          } else {
            disposition = { kind: "conversation" as const };
          }
          void disposition;
          this.advanceCheckpoint(channelId, message.id);
          checkpoint = message.id;
          examinedCount += 1;
        }

        const finalHighWater = await this.transport.getLatestMessageId(channelId);
        if (finalHighWater === null || finalHighWater === highWater) {
          break;
        }
        highWater = finalHighWater;
      }

      if (breakingMessageId !== undefined) {
        await this.gameService.ensureReconnectReset(breakingMessageId);
      }
      return {
        highWaterMessageId: highWater,
        examinedCount,
        completed,
        ...(breakingMessageId === undefined ? {} : { breakingMessageId }),
      };
    });
  }

  private checkpoint(channelId: string): string | null {
    return (
      this.repository.database
        .prepare("SELECT last_examined_message_id FROM channel_checkpoints WHERE channel_id = ?")
        .get(channelId) as { last_examined_message_id: string } | undefined
    )?.last_examined_message_id ?? null;
  }

  private advanceCheckpoint(channelId: string, messageId: string): void {
    this.repository.immediate(() => {
      this.repository.database
        .prepare(
          `INSERT INTO channel_checkpoints (channel_id, last_examined_message_id, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(channel_id) DO UPDATE SET
             last_examined_message_id = excluded.last_examined_message_id,
             updated_at = excluded.updated_at`,
        )
        .run(channelId, messageId, this.clock.now().toISOString());
    });
  }

  private roundCompleted(roundId: string | undefined): boolean {
    if (roundId === undefined) {
      return false;
    }
    return (
      this.repository.database.prepare("SELECT state FROM rounds WHERE id = ?").get(roundId) as
        | { state: string }
        | undefined
    )?.state === "completed";
  }
}

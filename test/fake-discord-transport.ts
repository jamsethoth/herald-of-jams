import type {
  DiscordTransport,
  InboundDiscordMessage,
} from "../src/application/contracts.js";
import {
  AmbiguousDiscordError,
  DefiniteDiscordError,
} from "../src/application/outbox-dispatcher.js";

type SendBehavior =
  | "success"
  | "definite_failure"
  | "ambiguous_failure"
  | "accept_then_lose_response";
type DeleteBehavior = "deleted" | "already_absent" | "definite_failure";

export class FakeDiscordTransport implements DiscordTransport {
  private readonly sendBehaviors = new Map<string, SendBehavior[]>();
  private readonly deleteBehaviors = new Map<string, DeleteBehavior[]>();
  private readonly acceptedByNonce = new Map<string, { id: string }>();
  private readonly sendCounts = new Map<string, number>();
  private readonly deleteCounts = new Map<string, number>();
  private readonly history: InboundDiscordMessage[] = [];
  private remoteSequence = 0;

  scriptSend(nonce: string, ...behaviors: SendBehavior[]): void {
    this.sendBehaviors.set(nonce, [...behaviors]);
  }

  acceptThenLoseResponse(nonce: string): void {
    this.scriptSend(nonce, "accept_then_lose_response");
  }

  loseResponseWithoutMatch(nonce: string): void {
    this.scriptSend(nonce, "ambiguous_failure");
  }

  scriptDelete(messageId: string, ...behaviors: DeleteBehavior[]): void {
    this.deleteBehaviors.set(messageId, [...behaviors]);
  }

  sentCount(nonce: string): number {
    return this.sendCounts.get(nonce) ?? 0;
  }

  deletedCount(messageId: string): number {
    return this.deleteCounts.get(messageId) ?? 0;
  }

  addHistory(...messages: InboundDiscordMessage[]): void {
    this.history.push(...messages);
  }

  async sendMessage(input: {
    channelId: string;
    content: string;
    nonce: string;
    enforceNonce: true;
    suppressNotifications: boolean;
  }): Promise<{ id: string; nonce?: string }> {
    this.sendCounts.set(input.nonce, this.sentCount(input.nonce) + 1);
    const behavior = this.sendBehaviors.get(input.nonce)?.shift() ?? "success";
    if (behavior === "definite_failure") {
      throw new DefiniteDiscordError("scripted definite failure");
    }
    if (behavior === "ambiguous_failure") {
      throw new AmbiguousDiscordError("scripted ambiguous failure without history match");
    }
    const existing = this.acceptedByNonce.get(input.nonce);
    const accepted = existing ?? { id: `discord-${++this.remoteSequence}` };
    this.acceptedByNonce.set(input.nonce, accepted);
    if (behavior === "accept_then_lose_response") {
      throw new AmbiguousDiscordError("scripted lost response");
    }
    return { ...accepted, nonce: input.nonce };
  }

  async deleteMessage(
    _channelId: string,
    messageId: string,
  ): Promise<"deleted" | "already_absent"> {
    this.deleteCounts.set(messageId, this.deletedCount(messageId) + 1);
    const behavior = this.deleteBehaviors.get(messageId)?.shift() ?? "deleted";
    if (behavior === "definite_failure") {
      throw new DefiniteDiscordError("scripted definite delete failure");
    }
    return behavior;
  }

  async findOwnMessageByNonce(
    _channelId: string,
    nonce: string,
    _createdAfter: string,
  ): Promise<{ id: string } | null> {
    return this.acceptedByNonce.get(nonce) ?? null;
  }

  async *listMessagesAfter(
    channelId: string,
    afterMessageId: string | null,
  ): AsyncIterable<InboundDiscordMessage> {
    for (const message of this.history) {
      if (
        message.channelId === channelId &&
        (afterMessageId === null || BigInt(message.id) > BigInt(afterMessageId))
      ) {
        yield message;
      }
    }
  }

  async getLatestMessageId(channelId: string): Promise<string | null> {
    const ids = this.history
      .filter((message) => message.channelId === channelId)
      .map((message) => BigInt(message.id));
    return ids.length === 0 ? null : ids.reduce((left, right) => (left > right ? left : right)).toString();
  }
}

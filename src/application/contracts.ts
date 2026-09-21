export interface InboundDiscordMessage {
  id: string;
  channelId: string;
  authorId: string;
  displayName: string;
  content: string;
  createdAt: string;
}

export type MessageDisposition =
  | { kind: "conversation" }
  | { kind: "duplicate" }
  | { kind: "recorded"; decision: string; outboxOperationIds: readonly string[] };

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface DiscordTransport {
  sendMessage(input: {
    channelId: string;
    content: string;
    nonce: string;
    enforceNonce: true;
    suppressNotifications: boolean;
  }): Promise<{ id: string; nonce?: string }>;
  deleteMessage(channelId: string, messageId: string): Promise<"deleted" | "already_absent">;
  findOwnMessageByNonce(
    channelId: string,
    nonce: string,
    createdAfter: string,
  ): Promise<{ id: string } | null>;
  listMessagesAfter(
    channelId: string,
    afterMessageId: string | null,
  ): AsyncIterable<InboundDiscordMessage>;
  getLatestMessageId(channelId: string): Promise<string | null>;
}

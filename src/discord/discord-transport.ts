import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  type Message,
  type TextBasedChannel,
} from "discord.js";

import type { DiscordTransport, InboundDiscordMessage } from "../application/contracts.js";

export const DISCORD_GATEWAY_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
] as const;

export function createDiscordClient(): Client {
  return new Client({ intents: [...DISCORD_GATEWAY_INTENTS] });
}

async function textChannel(client: Client, channelId: string): Promise<TextBasedChannel> {
  const channel = await client.channels.fetch(channelId);
  if (channel === null || !channel.isTextBased()) {
    throw new Error(`Discord channel ${channelId} is not text based`);
  }
  return channel;
}

function inbound(message: Message): InboundDiscordMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    authorId: message.author.id,
    displayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
  };
}

export class DiscordJsTransport implements DiscordTransport {
  constructor(private readonly client: Client) {}

  async sendMessage(input: {
    channelId: string;
    content: string;
    nonce: string;
    enforceNonce: true;
    suppressNotifications: boolean;
  }): Promise<{ id: string; nonce?: string }> {
    const channel = await textChannel(this.client, input.channelId);
    if (!channel.isSendable()) {
      throw new Error(`Discord channel ${input.channelId} cannot send messages`);
    }
    const sent = await channel.send({
      content: input.content,
      nonce: input.nonce,
      enforceNonce: input.enforceNonce,
      allowedMentions: { parse: ["users"] },
      ...(input.suppressNotifications ? { flags: MessageFlags.SuppressNotifications } : {}),
    });
    return { id: sent.id, ...(sent.nonce === null ? {} : { nonce: String(sent.nonce) }) };
  }

  async deleteMessage(
    channelId: string,
    messageId: string,
  ): Promise<"deleted" | "already_absent"> {
    const channel = await textChannel(this.client, channelId);
    if (!("messages" in channel)) {
      throw new Error(`Discord channel ${channelId} has no message manager`);
    }
    try {
      await channel.messages.delete(messageId);
      return "deleted";
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: number }).code === 10008
      ) {
        return "already_absent";
      }
      throw error;
    }
  }

  async findOwnMessageByNonce(
    channelId: string,
    nonce: string,
    createdAfter: string,
  ): Promise<{ id: string } | null> {
    const channel = await textChannel(this.client, channelId);
    if (!("messages" in channel)) {
      return null;
    }
    const messages = await channel.messages.fetch({ limit: 100 });
    const cutoff = new Date(createdAfter).getTime();
    const own = messages.find(
      (message) =>
        message.author.id === this.client.user?.id &&
        String(message.nonce) === nonce &&
        message.createdTimestamp >= cutoff,
    );
    return own === undefined ? null : { id: own.id };
  }

  async *listMessagesAfter(
    channelId: string,
    afterMessageId: string | null,
  ): AsyncIterable<InboundDiscordMessage> {
    const channel = await textChannel(this.client, channelId);
    if (!("messages" in channel)) {
      return;
    }
    let cursor = afterMessageId;
    while (true) {
      const page = await channel.messages.fetch({
        limit: 100,
        ...(cursor === null ? {} : { after: cursor }),
      });
      const ordered = [...page.values()].sort((left, right) =>
        BigInt(left.id) < BigInt(right.id) ? -1 : 1,
      );
      if (ordered.length === 0) {
        return;
      }
      for (const message of ordered) {
        yield inbound(message);
      }
      cursor = ordered[ordered.length - 1]!.id;
      if (ordered.length < 100) {
        return;
      }
    }
  }

  async getLatestMessageId(channelId: string): Promise<string | null> {
    const channel = await textChannel(this.client, channelId);
    if (!("messages" in channel)) {
      return null;
    }
    const messages = await channel.messages.fetch({ limit: 1 });
    return messages.first()?.id ?? null;
  }
}

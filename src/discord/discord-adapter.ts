import { Events, type Client, type Interaction, type Message, type PartialMessage } from "discord.js";

import type { Clock, IdGenerator, InboundDiscordMessage, MessageDisposition } from "../application/contracts.js";
import type { SerialExecutor } from "../application/serial-executor.js";
import type { DispatchResult } from "../application/outbox-dispatcher.js";
import type { GameRepository } from "../db/game-repository.js";

export interface GatewayMessage extends InboundDiscordMessage {
  guildId: string | null;
  authorIsBot: boolean;
  webhookId: string | null;
}

export interface GatewayInteraction {
  guildId: string | null;
  commandName: string;
  reply(content: string): Promise<void>;
  followUp(content: string): Promise<void>;
}

export interface DiscordGatewayHandlers {
  messageCreate(message: GatewayMessage): void | Promise<void>;
  messageDelete(message: { id: string }): void | Promise<void>;
  interactionCreate(interaction: GatewayInteraction): void | Promise<void>;
}

export interface DiscordGateway {
  subscribe(handlers: DiscordGatewayHandlers): () => void;
  start(token: string, guildId: string): Promise<void>;
  stop(): Promise<void>;
}

export class DiscordJsGateway implements DiscordGateway {
  constructor(private readonly client: Client) {}

  subscribe(handlers: DiscordGatewayHandlers): () => void {
    const onMessage = (message: Message) => {
      void handlers.messageCreate({
        id: message.id,
        guildId: message.guildId,
        channelId: message.channelId,
        authorId: message.author.id,
        displayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
        authorIsBot: message.author.bot,
        webhookId: message.webhookId,
      });
    };
    const onDelete = (message: Message | PartialMessage) => {
      void handlers.messageDelete({ id: message.id });
    };
    const onInteraction = (interaction: Interaction) => {
      if (!interaction.isChatInputCommand()) {
        return;
      }
      void handlers.interactionCreate({
        guildId: interaction.guildId,
        commandName: interaction.commandName,
        reply: async (content) => {
          await interaction.reply({ content, allowedMentions: { parse: [] } });
        },
        followUp: async (content) => {
          await interaction.followUp({ content, allowedMentions: { parse: [] } });
        },
      });
    };
    this.client.on(Events.MessageCreate, onMessage);
    this.client.on(Events.MessageDelete, onDelete);
    this.client.on(Events.InteractionCreate, onInteraction);
    return () => {
      this.client.off(Events.MessageCreate, onMessage);
      this.client.off(Events.MessageDelete, onDelete);
      this.client.off(Events.InteractionCreate, onInteraction);
    };
  }

  async start(token: string, guildId: string): Promise<void> {
    await this.client.login(token);
    const guild = await this.client.guilds.fetch(guildId);
    await guild.commands.create({
      name: "leaderboard",
      description: "Show the current Herald of Jams season leaderboard",
    });
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }
}

interface AdapterDependencies {
  gateway: DiscordGateway;
  gameService: { processMessage(message: InboundDiscordMessage): Promise<MessageDisposition> };
  dispatcher: { dispatchNext(channelId: string): Promise<DispatchResult> };
  executor: SerialExecutor;
  repository: GameRepository;
  clock: Clock;
  ids: IdGenerator;
  config: { token: string; guildId: string; channelId: string };
}

function escapeDiscordText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("@", "@\u200b")
    .replace(/[\_*~`>|]/g, "\\$&");
}

function leaderboardPages(entries: ReturnType<GameRepository["leaderboard"]>): readonly string[] {
  if (entries.length === 0) {
    return ["The seasonal leaderboard is empty."];
  }
  const lines = entries.map(
    (entry, index) => `${index + 1}. ${escapeDiscordText(entry.displayName)}: ${entry.total}`,
  );
  const pages: string[] = [];
  let page = "Season leaderboard";
  for (const rawLine of lines) {
    const line = rawLine.slice(0, 1_975);
    if (`${page}\n${line}`.length > 2_000) {
      pages.push(page);
      page = line;
    } else {
      page += `\n${line}`;
    }
  }
  pages.push(page);
  return pages;
}

export class DiscordAdapter {
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly dependencies: AdapterDependencies) {}

  async start(): Promise<void> {
    this.unsubscribe = this.dependencies.gateway.subscribe({
      messageCreate: async (message) => this.handleMessage(message),
      messageDelete: async (message) => this.handleDelete(message.id),
      interactionCreate: async (interaction) => this.handleInteraction(interaction),
    });
    await this.dependencies.gateway.start(
      this.dependencies.config.token,
      this.dependencies.config.guildId,
    );
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.dependencies.gateway.stop();
  }

  private async handleMessage(message: GatewayMessage): Promise<void> {
    if (
      message.guildId !== this.dependencies.config.guildId ||
      message.channelId !== this.dependencies.config.channelId ||
      message.authorIsBot ||
      message.webhookId !== null
    ) {
      return;
    }
    try {
      await this.dependencies.executor.run(message.channelId, async () => {
        const disposition = await this.dependencies.gameService.processMessage({
          id: message.id,
          channelId: message.channelId,
          authorId: message.authorId,
          displayName: message.displayName,
          content: message.content,
          createdAt: message.createdAt,
        });
        if (disposition.kind === "recorded") {
          await this.dependencies.dispatcher.dispatchNext(message.channelId);
        }
      });
    } catch (error) {
      this.auditFailure("messageCreate", error);
    }
  }

  private async handleDelete(messageId: string): Promise<void> {
    const operation = this.dependencies.repository.database
      .prepare(
        `SELECT id FROM discord_outbox
         WHERE operation_type = 'canonical_message' AND discord_message_id = ? LIMIT 1`,
      )
      .get(messageId) as { id: string } | undefined;
    if (operation === undefined) {
      return;
    }
    this.dependencies.repository.immediate(() => {
      this.dependencies.repository.database
        .prepare(
          `INSERT INTO audit_events
            (id, event_type, actor_id, details_json, created_at)
           VALUES (?, 'canonical_message_deleted', NULL, ?, ?)`,
        )
        .run(
          this.dependencies.ids.next(),
          JSON.stringify({ operationId: operation.id, discordMessageId: messageId }),
          this.dependencies.clock.now().toISOString(),
        );
    });
  }

  private async handleInteraction(interaction: GatewayInteraction): Promise<void> {
    if (
      interaction.guildId !== this.dependencies.config.guildId ||
      interaction.commandName !== "leaderboard"
    ) {
      return;
    }
    try {
      const pages = leaderboardPages(this.dependencies.repository.leaderboard());
      await interaction.reply(pages[0]!);
      for (const page of pages.slice(1)) {
        await interaction.followUp(page);
      }
    } catch (error) {
      this.auditFailure("interactionCreate", error);
    }
  }

  private auditFailure(source: string, error: unknown): void {
    const errorType = error instanceof Error ? error.name : "UnknownError";
    this.dependencies.repository.immediate(() => {
      this.dependencies.repository.database
        .prepare(
          `INSERT INTO audit_events
            (id, event_type, actor_id, details_json, created_at)
           VALUES (?, 'discord_adapter_failure', NULL, ?, ?)`,
        )
        .run(
          this.dependencies.ids.next(),
          JSON.stringify({ source, errorType }),
          this.dependencies.clock.now().toISOString(),
        );
    });
  }
}

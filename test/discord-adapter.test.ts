import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InboundDiscordMessage, MessageDisposition } from "../src/application/contracts.js";
import type { DispatchResult } from "../src/application/outbox-dispatcher.js";
import { GameService } from "../src/application/game-service.js";
import { SerialExecutor } from "../src/application/serial-executor.js";
import {
  DiscordAdapter,
  type DiscordGateway,
  type DiscordGatewayHandlers,
  type GatewayInteraction,
  type GatewayMessage,
} from "../src/discord/discord-adapter.js";
import { DISCORD_GATEWAY_INTENTS } from "../src/discord/discord-transport.js";
import { GatewayIntentBits } from "discord.js";
import { createTestDatabase, type TestDatabaseContext } from "./fixtures.js";

class FakeGateway implements DiscordGateway {
  handlers: DiscordGatewayHandlers | undefined;
  started?: { token: string; guildId: string };
  stopped = false;

  subscribe(handlers: DiscordGatewayHandlers): () => void {
    this.handlers = handlers;
    return () => {
      this.handlers = undefined;
    };
  }

  async start(token: string, guildId: string): Promise<void> {
    this.started = { token, guildId };
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async message(payload: GatewayMessage): Promise<void> {
    await this.handlers?.messageCreate(payload);
  }

  async deleted(id: string): Promise<void> {
    await this.handlers?.messageDelete({ id });
  }

  async interaction(payload: GatewayInteraction): Promise<void> {
    await this.handlers?.interactionCreate(payload);
  }
}

function gatewayMessage(overrides: Partial<GatewayMessage> = {}): GatewayMessage {
  return {
    id: "100",
    guildId: "guild-1",
    channelId: "channel-1",
    authorId: "alice",
    displayName: "Alice",
    content: "1",
    createdAt: "2026-09-21T00:00:00.000Z",
    authorIsBot: false,
    webhookId: null,
    ...overrides,
  };
}

describe("DiscordAdapter", () => {
  let context: TestDatabaseContext;
  let gateway: FakeGateway;

  beforeEach(() => {
    context = createTestDatabase();
    gateway = new FakeGateway();
  });

  afterEach(() => context.close());

  function adapter(
    processMessage: (message: InboundDiscordMessage) => Promise<MessageDisposition> = vi.fn(async (_message: InboundDiscordMessage) => ({
      kind: "recorded" as const,
      decision: "accepted",
      outboxOperationIds: ["operation"],
    })),
    dispatchNext: (channelId: string) => Promise<DispatchResult> = vi.fn(async () => ({ kind: "idle" as const })),
  ) {
    return {
      instance: new DiscordAdapter({
        gateway,
        gameService: { processMessage },
        dispatcher: { dispatchNext },
        executor: new SerialExecutor(),
        repository: context.repository,
        clock: context.clock,
        ids: context.ids,
        config: {
          token: "top-secret-token",
          guildId: "guild-1",
          channelId: "channel-1",
        },
      }),
      processMessage,
      dispatchNext,
    };
  }

  it("requests only the three required Gateway intents", () => {
    expect(DISCORD_GATEWAY_INTENTS).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ]);
  });

  it("registers the guild command, converts eligible messages, and stops cleanly", async () => {
    const subject = adapter();
    await subject.instance.start();
    await gateway.message(gatewayMessage());
    await subject.instance.stop();

    expect(gateway.started).toEqual({ token: "top-secret-token", guildId: "guild-1" });
    expect(subject.processMessage).toHaveBeenCalledWith({
      id: "100",
      channelId: "channel-1",
      authorId: "alice",
      displayName: "Alice",
      content: "1",
      createdAt: "2026-09-21T00:00:00.000Z",
    });
    expect(subject.dispatchNext).toHaveBeenCalledWith("channel-1");
    expect(gateway.stopped).toBe(true);
  });

  it.each([
    { guildId: "other" },
    { channelId: "other" },
    { authorIsBot: true },
    { webhookId: "webhook" },
  ])("ignores ineligible messages: %j", async (overrides) => {
    const subject = adapter();
    await subject.instance.start();
    await gateway.message(gatewayMessage(overrides));

    expect(subject.processMessage).not.toHaveBeenCalled();
  });

  it("does not wake output for a duplicate event", async () => {
    const processMessage = vi.fn(async () => ({ kind: "duplicate" as const }));
    const subject = adapter(processMessage);
    await subject.instance.start();
    await gateway.message(gatewayMessage());

    expect(subject.dispatchNext).not.toHaveBeenCalled();
  });

  it("records redacted operational failures without message content or secrets", async () => {
    const processMessage = vi.fn(async () => {
      throw new Error("failure included 1 and top-secret-token");
    });
    const subject = adapter(processMessage);
    await subject.instance.start();
    await gateway.message(gatewayMessage({ content: "sensitive-message-content" }));

    const event = context.database
      .prepare("SELECT event_type, details_json FROM audit_events")
      .get() as { event_type: string; details_json: string };
    expect(event.event_type).toBe("discord_adapter_failure");
    expect(event.details_json).not.toContain("sensitive-message-content");
    expect(event.details_json).not.toContain("top-secret-token");
  });

  it("privately audits deletion of a delivered canonical message only", async () => {
    context.database
      .prepare(
        `INSERT INTO discord_outbox
          (id, channel_id, sequence_number, operation_type, payload_json, nonce, status,
           discord_message_id, created_at, resolved_at)
         VALUES ('op', 'channel-1', 1, 'canonical_message', '{}', 'nonce', 'delivered',
                 'bot-message', 'now', 'now')`,
      )
      .run();
    const subject = adapter();
    await subject.instance.start();

    await gateway.deleted("unrelated");
    await gateway.deleted("bot-message");

    expect(
      context.database
        .prepare("SELECT event_type FROM audit_events WHERE event_type = 'canonical_message_deleted'")
        .all(),
    ).toEqual([{ event_type: "canonical_message_deleted" }]);
  });

  it("keeps hidden sequence and predicate data out of public Discord payloads", async () => {
    const service = new GameService(
      context.repository,
      context.adminRepository,
      context.clock,
      context.ids,
    );
    const templateId = context.adminRepository.createTemplate({
      name: "Hidden",
      channelId: "channel-1",
      start: 1,
      target: 3,
      step: 1,
      skipRules: [{ kind: "one_of", values: [2] }],
      bonusRules: [{ id: "prime", predicate: { kind: "prime" } }],
    });
    await service.activateRound(templateId);
    await service.processMessage({
      id: "100",
      channelId: "channel-1",
      authorId: "alice",
      displayName: "Alice",
      content: "1",
      createdAt: "now",
    });
    await service.processMessage({
      id: "101",
      channelId: "channel-1",
      authorId: "bob",
      displayName: "Bob",
      content: "2",
      createdAt: "now",
    });
    await service.processMessage({
      id: "102",
      channelId: "channel-1",
      authorId: "bob",
      displayName: "Bob",
      content: "1",
      createdAt: "now",
    });
    await service.processMessage({
      id: "103",
      channelId: "channel-1",
      authorId: "alice",
      displayName: "Alice",
      content: "3",
      createdAt: "now",
    });

    const payloads = context.database
      .prepare(
        `SELECT operation_type, payload_json FROM discord_outbox
         WHERE operation_type IN (
           'canonical_message', 'bonus_announcement', 'reset_announcement',
           'completion_announcement', 'leaderboard_publication'
         )`,
      )
      .all() as { operation_type: string; payload_json: string }[];
    expect(new Set(payloads.map(({ operation_type }) => operation_type))).toEqual(
      new Set([
        "canonical_message",
        "bonus_announcement",
        "reset_announcement",
        "completion_announcement",
        "leaderboard_publication",
      ]),
    );
    for (const { payload_json } of payloads) {
      expect(payload_json).not.toMatch(/expected|compiled|predicate|skipRules|bonusRuleIds/i);
    }
  });

  it("renders an escaped, paginated leaderboard and a friendly empty response", async () => {
    const replies: string[] = [];
    const subject = adapter();
    await subject.instance.start();
    await gateway.interaction({
      guildId: "guild-1",
      commandName: "leaderboard",
      reply: async (content) => void replies.push(content),
      followUp: async (content) => void replies.push(content),
    });
    expect(replies).toEqual(["The seasonal leaderboard is empty."]);

    context.database.prepare("INSERT INTO seasons (id, started_at) VALUES ('season', 'now')").run();
    context.database
      .prepare(
        "INSERT INTO players (discord_user_id, latest_display_name, updated_at) VALUES ('player', '@everyone_*', 'now')",
      )
      .run();
    context.database
      .prepare(
        `INSERT INTO round_templates
          (id, private_name, channel_id, start_value, target_value, step_value, rules_json, created_at, updated_at)
         VALUES ('template', 'name', 'channel-1', 1, 2, 1, '{}', 'now', 'now')`,
      )
      .run();
    context.database
      .prepare(
        `INSERT INTO rounds
          (id, template_id, season_id, channel_id, state, compiled_config_json, activated_at,
           cancelled_at, operationally_settled_at)
         VALUES ('round', 'template', 'season', 'channel-1', 'cancelled', '{}', 'now', 'now', 'now')`,
      )
      .run();
    context.database
      .prepare(
        `INSERT INTO score_ledger
          (id, season_id, round_id, player_id, entry_type, delta, source_key, created_at)
         VALUES ('score', 'season', 'round', 'player', 'participation', 2, 'source', 'now')`,
      )
      .run();
    replies.length = 0;
    await gateway.interaction({
      guildId: "guild-1",
      commandName: "leaderboard",
      reply: async (content) => void replies.push(content),
      followUp: async (content) => void replies.push(content),
    });

    expect(replies.join("\n")).toContain("@\u200beveryone\\_\\*");
    expect(replies.every((reply) => reply.length <= 2_000)).toBe(true);
  });
});

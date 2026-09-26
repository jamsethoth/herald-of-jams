import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Clock, IdGenerator } from "./application/contracts.js";
import { GameService } from "./application/game-service.js";
import { OutboxDispatcher } from "./application/outbox-dispatcher.js";
import { OutboxPump } from "./application/outbox-pump.js";
import { ReconciliationService } from "./application/reconciliation-service.js";
import { SerialExecutor } from "./application/serial-executor.js";
import { resolveConfig, type AppConfig } from "./config.js";
import { AdminRepository } from "./db/admin-repository.js";
import { migrate, openDatabase } from "./db/database.js";
import { GameRepository } from "./db/game-repository.js";
import { OutboxRepository } from "./db/outbox-repository.js";
import { DiscordAdapter, DiscordJsGateway } from "./discord/discord-adapter.js";
import { createDiscordClient, DiscordJsTransport } from "./discord/discord-transport.js";
import { REQUIRED_CAPABILITIES } from "./discord/permissions.js";
import { parseLaunchOptions } from "./runtime/launch-options.js";
import { resolveRuntimeResources, type RuntimeResources } from "./runtime/resources.js";
import { buildAdminServer } from "./web/server.js";

export interface RuntimeSteps {
  migrate(): void;
  loadActiveChannel(): string | null;
  startHttp(): Promise<void>;
  connectDiscord(): Promise<void>;
  reconcile(channelId: string): Promise<void>;
  dispatchPending(channelId: string | null): Promise<void>;
  enableLiveIntake(): void;
  stopHttp(): Promise<void>;
  stopDiscord(): Promise<void>;
  drainWork(): Promise<void>;
  closeDatabase(): void;
}

export class ApplicationRuntime {
  private started = false;
  private stopped = false;

  constructor(private readonly steps: RuntimeSteps) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.steps.migrate();
    const activeChannel = this.steps.loadActiveChannel();
    await this.steps.connectDiscord();
    if (activeChannel !== null) {
      await this.steps.reconcile(activeChannel);
    }
    await this.steps.dispatchPending(activeChannel);
    await this.steps.startHttp();
    this.steps.enableLiveIntake();
    this.started = true;
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.steps.stopHttp();
    await this.steps.stopDiscord();
    await this.steps.drainWork();
    this.steps.closeDatabase();
  }
}

class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

class UuidGenerator implements IdGenerator {
  next(): string {
    return randomUUID();
  }
}

export function composeApplication(
  config: AppConfig,
  resources: RuntimeResources,
): ApplicationRuntime {
  mkdirSync(dirname(config.database.path), { recursive: true });
  const database = openDatabase(config.database.path);
  const clock = new SystemClock();
  const ids = new UuidGenerator();
  const gameRepository = new GameRepository(database);
  const adminRepository = new AdminRepository(database, clock, ids);
  const outboxRepository = new OutboxRepository(database, clock, ids);
  const gameService = new GameService(gameRepository, adminRepository, clock, ids);
  const executor = new SerialExecutor();
  const client = createDiscordClient();
  const gateway = new DiscordJsGateway(client);
  const transport = new DiscordJsTransport(client);
  const dispatcher = new OutboxDispatcher(outboxRepository, transport, clock);
  const reconciler = new ReconciliationService(
    transport,
    gameService,
    gameRepository,
    executor,
    clock,
  );
  const pump = new OutboxPump(dispatcher, () =>
    (
      database
        .prepare(
          "SELECT DISTINCT channel_id FROM discord_outbox WHERE status NOT IN ('delivered', 'abandoned', 'needs_review')",
        )
        .all() as { channel_id: string }[]
    ).map(({ channel_id }) => channel_id),
  );
  const adapter = new DiscordAdapter({
    gateway,
    gameService,
    dispatcher: {
      dispatchNext: (channelId) => dispatcher.dispatchNext(channelId),
      wake: (channelId) => pump.wake(channelId),
    },
    reconcile: (channelId) => reconciler.reconcile(channelId).then(() => undefined),
    executor,
    repository: gameRepository,
    clock,
    ids,
    config: {
      token: config.discord.token,
      guildId: config.discord.guildId,
      applicationId: config.discord.applicationId,
      channelId: "",
    },
  });
  const server = buildAdminServer({
    config,
    database,
    clock,
    resources,
    adminRepository,
    gameService,
    executor,
    outboxRepository,
    permissionReport: async (channelId) =>
      channelId === undefined
        ? { ok: client.isReady(), missing: client.isReady() ? [] : [...REQUIRED_CAPABILITIES] }
        : gateway.permissionReport(channelId),
    discordConnected: () => client.isReady(),
    criticalFailure: () => adapter.hasCriticalFailure(),
    outboxWake: (channelId) => pump.wake(channelId),
  });

  return new ApplicationRuntime({
    migrate: () => migrate(database, resources.migrationsDirectory),
    loadActiveChannel: () =>
      (
        database
          .prepare(
            "SELECT channel_id FROM rounds WHERE state IN ('waiting_for_start', 'counting', 'paused') LIMIT 1",
          )
          .get() as { channel_id: string } | undefined
      )?.channel_id ?? null,
    startHttp: async () => {
      await server.listen({ host: config.admin.host, port: config.admin.port });
    },
    connectDiscord: async () => {
      adapter.prepare();
      await adapter.connect();
    },
    reconcile: async (channelId) => {
      await reconciler.reconcile(channelId);
    },
    dispatchPending: async () => {
      const channels = database
        .prepare(
          "SELECT DISTINCT channel_id FROM discord_outbox WHERE status NOT IN ('delivered', 'abandoned')",
        )
        .all() as { channel_id: string }[];
      for (const { channel_id } of channels) {
        for (let guard = 0; guard < 100_000; guard += 1) {
          const result = await dispatcher.dispatchNext(channel_id);
          if (result.kind !== "delivered") break;
        }
      }
    },
    enableLiveIntake: () => {
      pump.start();
      adapter.startAcceptingMessages();
    },
    stopHttp: async () => server.close(),
    stopDiscord: async () => {
      await pump.stop();
      await adapter.stop();
    },
    drainWork: async () => executor.whenIdle(),
    closeDatabase: () => database.close(),
  });
}

export async function main(): Promise<void> {
  const options = parseLaunchOptions(process.argv.slice(2));
  const applicationRoot = dirname(fileURLToPath(import.meta.url));
  const application = composeApplication(
    resolveConfig(options, process.env),
    resolveRuntimeResources(applicationRoot),
  );
  const shutdown = async () => application.shutdown();
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await application.start();
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    const name = error instanceof Error ? error.name : "UnknownError";
    process.stderr.write(`Herald of Jams failed to start: ${name}\n`);
  });
}

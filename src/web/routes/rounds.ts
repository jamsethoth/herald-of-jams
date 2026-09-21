import type { FastifyInstance, preHandlerHookHandler } from "fastify";

import type { GameService } from "../../application/game-service.js";
import type { SerialExecutor } from "../../application/serial-executor.js";
import type { AdminRepository } from "../../db/admin-repository.js";
import type { PermissionReport } from "../../discord/permissions.js";
import type Database from "better-sqlite3";

interface RoundRouteDependencies {
  gameService: GameService;
  executor: SerialExecutor;
  adminRepository: AdminRepository;
  permissionReport(channelId?: string): PermissionReport | Promise<PermissionReport>;
  database: Database.Database;
  outboxWake?: (channelId: string) => void;
}

function activeChannel(database: Database.Database): string {
  return (
    database
      .prepare("SELECT channel_id FROM rounds WHERE state IN ('waiting_for_start', 'counting', 'paused') LIMIT 1")
      .get() as { channel_id: string } | undefined
  )?.channel_id ?? "round-lifecycle";
}

export function registerRoundRoutes(
  app: FastifyInstance,
  dependencies: RoundRouteDependencies,
  requireAuthenticated: preHandlerHookHandler,
  csrfHook: preHandlerHookHandler,
): void {
  const hooks = { preHandler: [requireAuthenticated, csrfHook] };
  app.post("/admin/rounds/activate/:templateId", hooks, async (request, reply) => {
    const { templateId } = request.params as { templateId: string };
    try {
      const template = dependencies.adminRepository.getTemplate(templateId);
      const permissions = await dependencies.permissionReport(template.channelId);
      if (!permissions.ok) {
        return reply.code(409).type("text/plain").send(`Missing permissions: ${permissions.missing.join(", ")}`);
      }
      await dependencies.executor.run(template.channelId, () =>
        dependencies.gameService.activateRound(templateId),
      );
      dependencies.outboxWake?.(template.channelId);
      return reply.redirect("/admin");
    } catch (error) {
      return reply.code(409).type("text/plain").send(error instanceof Error ? error.message : "Conflict");
    }
  });

  app.post("/admin/rounds/pause", hooks, async (_request, reply) => {
    try {
      const channelId = activeChannel(dependencies.database);
      await dependencies.executor.run(channelId, () => dependencies.gameService.pauseRound("admin"));
      dependencies.outboxWake?.(channelId);
      return reply.redirect("/admin");
    } catch (error) {
      return reply.code(409).type("text/plain").send(error instanceof Error ? error.message : "Conflict");
    }
  });

  app.post("/admin/rounds/resume", hooks, async (_request, reply) => {
    try {
      const channelId = activeChannel(dependencies.database);
      await dependencies.executor.run(channelId, () => dependencies.gameService.resumeRound("admin"));
      dependencies.outboxWake?.(channelId);
      return reply.redirect("/admin");
    } catch (error) {
      return reply.code(409).type("text/plain").send(error instanceof Error ? error.message : "Conflict");
    }
  });

  app.post("/admin/rounds/cancel", hooks, async (request, reply) => {
    const { confirmation } = request.body as { confirmation?: unknown };
    if (confirmation !== "CANCEL") {
      return reply.code(400).type("text/plain").send("Type CANCEL to confirm cancellation");
    }
    try {
      const channelId = activeChannel(dependencies.database);
      await dependencies.executor.run(channelId, () => dependencies.gameService.cancelRound("admin"));
      dependencies.outboxWake?.(channelId);
      return reply.redirect("/admin");
    } catch (error) {
      return reply.code(409).type("text/plain").send(error instanceof Error ? error.message : "Conflict");
    }
  });
}

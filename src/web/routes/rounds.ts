import type { FastifyInstance, preHandlerHookHandler } from "fastify";

import type { GameService } from "../../application/game-service.js";
import type { SerialExecutor } from "../../application/serial-executor.js";
import type { AdminRepository } from "../../db/admin-repository.js";
import type { PermissionReport } from "../../discord/permissions.js";

interface RoundRouteDependencies {
  gameService: GameService;
  executor: SerialExecutor;
  adminRepository: AdminRepository;
  permissionReport(channelId?: string): PermissionReport | Promise<PermissionReport>;
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
      return reply.redirect("/admin");
    } catch (error) {
      return reply.code(409).type("text/plain").send(error instanceof Error ? error.message : "Conflict");
    }
  });

  app.post("/admin/rounds/pause", hooks, async (_request, reply) => {
    try {
      await dependencies.executor.run("round-lifecycle", () => dependencies.gameService.pauseRound("admin"));
      return reply.redirect("/admin");
    } catch (error) {
      return reply.code(409).type("text/plain").send(error instanceof Error ? error.message : "Conflict");
    }
  });

  app.post("/admin/rounds/resume", hooks, async (_request, reply) => {
    try {
      await dependencies.executor.run("round-lifecycle", () => dependencies.gameService.resumeRound("admin"));
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
      await dependencies.executor.run("round-lifecycle", () => dependencies.gameService.cancelRound("admin"));
      return reply.redirect("/admin");
    } catch (error) {
      return reply.code(409).type("text/plain").send(error instanceof Error ? error.message : "Conflict");
    }
  });
}

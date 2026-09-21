import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import type Database from "better-sqlite3";

import type { GameService } from "../../application/game-service.js";
import type { SerialExecutor } from "../../application/serial-executor.js";

export function registerModerationRoutes(
  app: FastifyInstance,
  database: Database.Database,
  gameService: GameService,
  executor: SerialExecutor,
  requireAuthenticated: preHandlerHookHandler,
  csrfHook: preHandlerHookHandler,
): void {
  app.get("/admin/moderation", { preHandler: requireAuthenticated }, async (_request, reply) => {
    const bans = database
      .prepare(
        `SELECT round_bans.player_id, players.latest_display_name
         FROM round_bans JOIN players ON players.discord_user_id = round_bans.player_id
         ORDER BY players.latest_display_name COLLATE NOCASE`,
      )
      .all();
    return reply.view("moderation.eta", {
      title: "Round moderation",
      bans,
      csrf: reply.generateCsrf(),
    });
  });

  app.post(
    "/admin/moderation/ban",
    { preHandler: [requireAuthenticated, csrfHook] },
    async (request, reply) => {
      const body = request.body as { playerId?: unknown; displayName?: unknown };
      if (typeof body.playerId !== "string" || body.playerId.length === 0) {
        return reply.code(400).send("Discord user ID is required");
      }
      try {
        await executor.run("round-lifecycle", () =>
          gameService.banPlayer(
            body.playerId as string,
            typeof body.displayName === "string" && body.displayName.length > 0
              ? body.displayName
              : (body.playerId as string),
            "admin",
          ),
        );
        return reply.redirect("/admin/moderation");
      } catch (error) {
        return reply.code(409).send(error instanceof Error ? error.message : "Conflict");
      }
    },
  );

  app.post(
    "/admin/moderation/unban",
    { preHandler: [requireAuthenticated, csrfHook] },
    async (request, reply) => {
      const body = request.body as { playerId?: unknown };
      if (typeof body.playerId !== "string" || body.playerId.length === 0) {
        return reply.code(400).send("Discord user ID is required");
      }
      try {
        await executor.run("round-lifecycle", () =>
          gameService.unbanPlayer(body.playerId as string, "admin"),
        );
        return reply.redirect("/admin/moderation");
      } catch (error) {
        return reply.code(409).send(error instanceof Error ? error.message : "Conflict");
      }
    },
  );
}

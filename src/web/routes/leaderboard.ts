import type Database from "better-sqlite3";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";

import type { GameService } from "../../application/game-service.js";
import type { SerialExecutor } from "../../application/serial-executor.js";
import type { GameRepository } from "../../db/game-repository.js";

export function registerLeaderboardRoutes(
  app: FastifyInstance,
  database: Database.Database,
  repository: GameRepository,
  gameService: GameService,
  executor: SerialExecutor,
  requireAuthenticated: preHandlerHookHandler,
  csrfHook: preHandlerHookHandler,
): void {
  app.get("/admin/leaderboard", { preHandler: requireAuthenticated }, async (_request, reply) =>
    reply.view("leaderboard.eta", {
      title: "Current leaderboard",
      entries: repository.leaderboard(),
      seasons: database.prepare("SELECT id, started_at, ended_at FROM seasons ORDER BY started_at DESC").all(),
      csrf: reply.generateCsrf(),
    }),
  );

  app.get("/admin/seasons/:id", { preHandler: requireAuthenticated }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const entries = database
      .prepare(
        `SELECT score_ledger.round_id, score_ledger.player_id,
                players.latest_display_name, score_ledger.entry_type, score_ledger.delta
         FROM score_ledger
         JOIN players ON players.discord_user_id = score_ledger.player_id
         WHERE score_ledger.season_id = ?
         ORDER BY score_ledger.round_id, score_ledger.rowid`,
      )
      .all(id);
    return reply.view("season.eta", { title: "Season archive", seasonId: id, entries });
  });

  app.post(
    "/admin/seasons/reset",
    { preHandler: [requireAuthenticated, csrfHook] },
    async (request, reply) => {
      const { confirmation } = request.body as { confirmation?: unknown };
      if (confirmation !== "RESET") {
        return reply.code(400).send("Type RESET to confirm season reset");
      }
      try {
        await executor.run("round-lifecycle", () => gameService.resetSeason("admin"));
        return reply.redirect("/admin/leaderboard");
      } catch (error) {
        return reply.code(409).send(error instanceof Error ? error.message : "Conflict");
      }
    },
  );
}

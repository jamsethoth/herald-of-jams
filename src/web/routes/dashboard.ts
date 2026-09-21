import type Database from "better-sqlite3";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";

import type { PermissionReport } from "../../discord/permissions.js";

interface DashboardDependencies {
  database: Database.Database;
  permissionReport(): PermissionReport;
  discordConnected(): boolean;
}

export function registerDashboardRoute(
  app: FastifyInstance,
  dependencies: DashboardDependencies,
  requireAuthenticated: preHandlerHookHandler,
): void {
  app.get("/admin", { preHandler: requireAuthenticated }, async (_request, reply) => {
    const round = dependencies.database
      .prepare(
        `SELECT id, state FROM rounds
         WHERE state IN ('waiting_for_start', 'counting', 'paused') LIMIT 1`,
      )
      .get() as { id: string; state: string } | undefined;
    const accepted =
      round === undefined
        ? 0
        : (
            dependencies.database
              .prepare(
                `SELECT COUNT(*) AS count FROM submissions
                 WHERE round_id = ? AND attempt_id = (
                   SELECT id FROM attempts WHERE round_id = ? AND state = 'active' LIMIT 1
                 ) AND decision = 'accepted'`,
              )
              .get(round.id, round.id) as { count: number }
          ).count;
    const unresolved = (
      dependencies.database
        .prepare(
          "SELECT COUNT(*) AS count FROM discord_outbox WHERE status NOT IN ('delivered', 'abandoned')",
        )
        .get() as { count: number }
    ).count;
    const critical = (
      dependencies.database
        .prepare("SELECT COUNT(*) AS count FROM discord_outbox WHERE status = 'needs_review'")
        .get() as { count: number }
    ).count;
    return reply.view("dashboard.eta", {
      title: "Herald of Jams administration",
      connected: dependencies.discordConnected(),
      permissions: dependencies.permissionReport(),
      round,
      expectedPosition: accepted,
      unresolved,
      critical,
      csrf: reply.generateCsrf(),
    });
  });
}

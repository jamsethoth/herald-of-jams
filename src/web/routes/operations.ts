import type Database from "better-sqlite3";
import type { FastifyInstance, preHandlerHookHandler } from "fastify";

import type { OutboxRepository } from "../../db/outbox-repository.js";

export function registerOperationRoutes(
  app: FastifyInstance,
  database: Database.Database,
  outbox: OutboxRepository,
  requireAuthenticated: preHandlerHookHandler,
  csrfHook: preHandlerHookHandler,
): void {
  app.get("/admin/operations", { preHandler: requireAuthenticated }, async (_request, reply) => {
    const operations = database
      .prepare(
        `SELECT id, operation_type, sequence_number, predecessor_id, attempt_count,
                next_attempt_at, status,
                CASE WHEN last_error IS NULL THEN NULL ELSE 'Recorded delivery failure' END AS display_error,
                json_extract(payload_json, '$.roundId') AS round_id,
                COALESCE(json_extract(payload_json, '$.submissionId'),
                         json_extract(payload_json, '$.messageId')) AS submission_id
         FROM discord_outbox ORDER BY channel_id, sequence_number`,
      )
      .all();
    return reply.view("operations.eta", {
      title: "Discord operations",
      operations,
      csrf: reply.generateCsrf(),
    });
  });

  app.get("/admin/audit", { preHandler: requireAuthenticated }, async (request, reply) => {
    const query = request.query as { eventType?: string; actorId?: string; roundId?: string };
    const conditions: string[] = [];
    const parameters: string[] = [];
    for (const [column, value] of [
      ["event_type", query.eventType],
      ["actor_id", query.actorId],
      ["round_id", query.roundId],
    ] as const) {
      if (value !== undefined && value.length > 0) {
        conditions.push(`${column} = ?`);
        parameters.push(value);
      }
    }
    const events = database
      .prepare(
        `SELECT event_type, round_id, actor_id, details_json, created_at FROM audit_events
         ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(...parameters);
    return reply.view("audit.eta", { title: "Audit events", events });
  });

  const hooks = { preHandler: [requireAuthenticated, csrfHook] };
  app.post("/admin/operations/:id/retry", hooks, async (request, reply) => {
    try {
      outbox.retry((request.params as { id: string }).id, "admin");
      return reply.redirect("/admin/operations");
    } catch (error) {
      return reply.code(409).send(error instanceof Error ? error.message : "Conflict");
    }
  });

  app.post("/admin/operations/:id/mark-delivered", hooks, async (request, reply) => {
    const body = request.body as { discordMessageId?: unknown };
    if (typeof body.discordMessageId !== "string" || body.discordMessageId.length === 0) {
      return reply.code(400).send("Discord message ID is required");
    }
    try {
      outbox.markDelivered((request.params as { id: string }).id, body.discordMessageId, "admin");
      return reply.redirect("/admin/operations");
    } catch (error) {
      return reply.code(409).send(error instanceof Error ? error.message : "Conflict");
    }
  });

  app.post("/admin/operations/:id/abandon", hooks, async (request, reply) => {
    const body = request.body as { confirmation?: unknown; reason?: unknown };
    if (body.confirmation !== "ABANDON") {
      return reply.code(400).send("Type ABANDON to confirm");
    }
    if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
      return reply.code(400).send("Reason is required");
    }
    try {
      outbox.abandon((request.params as { id: string }).id, body.reason, "admin");
      return reply.redirect("/admin/operations");
    } catch (error) {
      return reply.code(409).send(error instanceof Error ? error.message : "Conflict");
    }
  });
}

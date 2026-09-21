import type { FastifyInstance, preHandlerHookHandler } from "fastify";

import type { AdminRepository } from "../../db/admin-repository.js";
import type { AnnouncementTemplates } from "../../domain/types.js";

function parseAnnouncements(body: unknown): AnnouncementTemplates {
  const values = body as Record<string, unknown>;
  return {
    start: typeof values.start === "string" ? values.start : "",
    bonus: typeof values.bonus === "string" ? values.bonus : "",
    reset: typeof values.reset === "string" ? values.reset : "",
    completion: typeof values.completion === "string" ? values.completion : "",
    cancellation: typeof values.cancellation === "string" ? values.cancellation : "",
  };
}

export function registerAnnouncementRoutes(
  app: FastifyInstance,
  repository: AdminRepository,
  requireAuthenticated: preHandlerHookHandler,
  csrfHook: preHandlerHookHandler,
): void {
  app.get(
    "/admin/settings/announcements",
    { preHandler: requireAuthenticated },
    async (_request, reply) =>
      reply.view("announcement-settings.eta", {
        title: "Announcement defaults",
        announcements: repository.getAnnouncementDefaults(),
        csrf: reply.generateCsrf(),
      }),
  );

  app.post(
    "/admin/settings/announcements",
    { preHandler: [requireAuthenticated, csrfHook] },
    async (request, reply) => {
      try {
        repository.updateAnnouncementDefaults(parseAnnouncements(request.body), "admin");
        return reply.redirect("/admin/settings/announcements");
      } catch (error) {
        const text = error instanceof Error ? error.message : "Invalid announcement settings";
        return reply.code(400).type("text/plain").send(text);
      }
    },
  );
}

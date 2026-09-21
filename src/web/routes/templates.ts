import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { z } from "zod";

import type { AdminRepository } from "../../db/admin-repository.js";
import { compileRound } from "../../domain/round-compiler.js";
import type { RoundTemplateInput } from "../../domain/types.js";

const predicateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prime") }),
  z.object({ kind: z.literal("divisible_by"), divisor: z.coerce.number() }),
  z.object({ kind: z.literal("one_of"), values: z.array(z.coerce.number()) }),
  z.object({
    kind: z.literal("range"),
    minimum: z.coerce.number(),
    maximum: z.coerce.number(),
  }),
]);

const templateSchema = z.object({
  name: z.string().min(1),
  notes: z.string().optional(),
  channelId: z.string().min(1),
  start: z.coerce.number(),
  target: z.coerce.number(),
  step: z.coerce.number(),
  skipRules: z.union([z.array(predicateSchema), z.string().transform((text, context) => {
    try {
      return z.array(predicateSchema).parse(JSON.parse(text));
    } catch {
      context.addIssue({ code: "custom", message: "invalid skip rules" });
      return z.NEVER;
    }
  })]).default([]),
  bonusRules: z.union([
    z.array(z.object({ id: z.string().min(1), predicate: predicateSchema })),
    z.string().transform((text, context) => {
      try {
        return z.array(z.object({ id: z.string().min(1), predicate: predicateSchema })).parse(
          JSON.parse(text),
        );
      } catch {
        context.addIssue({ code: "custom", message: "invalid bonus rules" });
        return z.NEVER;
      }
    }),
  ]).default([]),
  bonusAnnouncement: z.string().optional(),
  resetAnnouncement: z.string().optional(),
  completionAnnouncement: z.string().optional(),
  cancellationAnnouncement: z.string().optional(),
});

function values(body: Record<string, unknown>, key: string): unknown[] {
  const value = body[key];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function predicatesFromRows(body: Record<string, unknown>, prefix: "skip" | "bonus") {
  const kinds = values(body, `${prefix}Kind`);
  return kinds
    .map((kind, index) => {
      if (kind === "prime") return { kind: "prime" };
      if (kind === "divisible_by") {
        return { kind, divisor: values(body, `${prefix}Divisor`)[index] };
      }
      if (kind === "one_of") {
        const raw = String(values(body, `${prefix}Values`)[index] ?? "");
        return { kind, values: raw.split(",").filter(Boolean).map((value) => Number(value.trim())) };
      }
      if (kind === "range") {
        return {
          kind,
          minimum: values(body, `${prefix}Minimum`)[index],
          maximum: values(body, `${prefix}Maximum`)[index],
        };
      }
      return undefined;
    })
    .filter((predicate) => predicate !== undefined);
}

function parseTemplate(body: unknown): RoundTemplateInput {
  const raw = body as Record<string, unknown>;
  const normalized = {
    ...raw,
    ...(raw.skipRules === undefined && raw.skipKind !== undefined
      ? { skipRules: predicatesFromRows(raw, "skip") }
      : {}),
    ...(raw.bonusRules === undefined && raw.bonusKind !== undefined
      ? {
          bonusRules: predicatesFromRows(raw, "bonus").map((predicate, index) => ({
            id: String(values(raw, "bonusId")[index] ?? ""),
            predicate,
          })),
        }
      : {}),
  };
  const parsed = templateSchema.parse(normalized);
  const announcements = {
    ...(parsed.bonusAnnouncement === undefined || parsed.bonusAnnouncement.length === 0
      ? {}
      : { bonus: parsed.bonusAnnouncement }),
    ...(parsed.resetAnnouncement === undefined || parsed.resetAnnouncement.length === 0
      ? {}
      : { reset: parsed.resetAnnouncement }),
    ...(parsed.completionAnnouncement === undefined || parsed.completionAnnouncement.length === 0
      ? {}
      : { completion: parsed.completionAnnouncement }),
    ...(parsed.cancellationAnnouncement === undefined || parsed.cancellationAnnouncement.length === 0
      ? {}
      : { cancellation: parsed.cancellationAnnouncement }),
  };
  return {
    name: parsed.name,
    ...(parsed.notes === undefined || parsed.notes.length === 0 ? {} : { notes: parsed.notes }),
    channelId: parsed.channelId,
    start: parsed.start,
    target: parsed.target,
    step: parsed.step,
    skipRules: parsed.skipRules,
    bonusRules: parsed.bonusRules,
    ...(Object.keys(announcements).length === 0 ? {} : { announcements }),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Invalid template";
}

export function registerTemplateRoutes(
  app: FastifyInstance,
  repository: AdminRepository,
  requireAuthenticated: preHandlerHookHandler,
  csrfHook: preHandlerHookHandler,
): void {
  app.get("/admin/templates", { preHandler: requireAuthenticated }, async (_request, reply) =>
    reply.view("templates-list.eta", {
      title: "Round templates",
      templates: repository.listTemplates(),
      csrf: reply.generateCsrf(),
    }),
  );

  app.get("/admin/templates/new", { preHandler: requireAuthenticated }, async (_request, reply) =>
    reply.view("template-edit.eta", {
      title: "New template",
      action: "/admin/templates",
      template: {
        name: "",
        notes: "",
        channelId: "",
        start: 1,
        target: 100,
        step: 1,
        skipRules: [],
        bonusRules: [],
      },
      csrf: reply.generateCsrf(),
    }),
  );

  app.get("/admin/templates/:id/edit", { preHandler: requireAuthenticated }, async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.view("template-edit.eta", {
      title: "Edit template",
      action: `/admin/templates/${id}`,
      template: repository.getTemplate(id),
      csrf: reply.generateCsrf(),
    });
  });

  app.post(
    "/admin/templates/preview",
    { preHandler: [requireAuthenticated, csrfHook] },
    async (request, reply) => {
      try {
        const compiled = compileRound(
          parseTemplate(request.body),
          repository.getAnnouncementDefaults(),
        );
        const bonusMatches = compiled.entries.reduce(
          (total, entry) => total + entry.bonusRuleIds.length,
          0,
        );
        return reply.view("template-preview.eta", {
          title: "Template preview",
          sequence: compiled.entries.map(({ value }) => value).join(", "),
          required: compiled.entries.length,
          bonusMatches,
          thresholds: "25% / 50% / 75%",
          announcements: compiled.announcements,
        });
      } catch (error) {
        return reply.code(400).type("text/plain").send(errorText(error));
      }
    },
  );

  app.post(
    "/admin/templates",
    { preHandler: [requireAuthenticated, csrfHook] },
    async (request, reply) => {
      try {
        repository.createTemplate(parseTemplate(request.body));
        return reply.redirect("/admin/templates");
      } catch (error) {
        return reply.code(400).type("text/plain").send(errorText(error));
      }
    },
  );

  app.post(
    "/admin/templates/:id",
    { preHandler: [requireAuthenticated, csrfHook] },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        repository.updateTemplate(id, parseTemplate(request.body));
        return reply.redirect("/admin/templates");
      } catch (error) {
        return reply.code(400).type("text/plain").send(errorText(error));
      }
    },
  );
}

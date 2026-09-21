import { isIP } from "node:net";
import { resolve } from "node:path";

import cookie from "@fastify/cookie";
import csrfProtection from "@fastify/csrf-protection";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifySession, { type SessionStore } from "@fastify/session";
import fastifyStatic from "@fastify/static";
import view from "@fastify/view";
import type Database from "better-sqlite3";
import { Eta } from "eta";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";

import type { Clock } from "../application/contracts.js";
import type { GameService } from "../application/game-service.js";
import type { SerialExecutor } from "../application/serial-executor.js";
import type { AppConfig } from "../config.js";
import type { AdminRepository } from "../db/admin-repository.js";
import type { PermissionReport } from "../discord/permissions.js";
import { SqliteSessionStore, verifyPassword } from "./auth.js";
import { registerDashboardRoute } from "./routes/dashboard.js";
import { registerRoundRoutes } from "./routes/rounds.js";
import { registerTemplateRoutes } from "./routes/templates.js";

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1_000;
const LOGIN_WINDOW_MS = 15 * 60 * 1_000;
const MAX_LOGIN_FAILURES = 5;

interface AdminServerDependencies {
  config: AppConfig;
  database: Database.Database;
  clock: Clock;
  adminRepository?: AdminRepository;
  gameService?: GameService;
  executor?: SerialExecutor;
  permissionReport?: () => PermissionReport;
  discordConnected?: () => boolean;
}

interface LoginAttemptRow {
  window_started_at: string;
  attempt_count: number;
  blocked_until: string | null;
}

function isLoopback(address: string): boolean {
  const normalized = address.toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."))
  );
}

export function buildAdminServer(dependencies: AdminServerDependencies) {
  const { config, database, clock } = dependencies;
  const app = Fastify({
    logger: false,
    trustProxy: (address) => config.admin.trustProxy && isLoopback(address),
  });
  const sessionStore = new SqliteSessionStore(database, clock);
  let cleanupTimer: NodeJS.Timeout | undefined;
  const csrfHook = (
    request: FastifyRequest,
    reply: FastifyReply,
    done: (error?: Error) => void,
  ) => app.csrfProtection(request, reply, done);
  const requireAuthenticated = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const absoluteExpiry = request.session.absoluteExpiresAt;
    if (
      request.session.authenticated !== true ||
      absoluteExpiry === undefined ||
      absoluteExpiry <= clock.now().toISOString()
    ) {
      if (request.session.authenticated === true) {
        await request.session.destroy();
      }
      await reply.redirect("/admin/login");
    }
  };

  void app.register(helmet, { contentSecurityPolicy: true });
  void app.register(formbody);
  void app.register(cookie);
  void app.register(fastifySession, {
    secret: config.admin.sessionSecret,
    cookieName: "herald_admin",
    store: sessionStore as SessionStore,
    saveUninitialized: false,
    rolling: false,
    cookie: {
      path: "/admin",
      httpOnly: true,
      sameSite: "strict",
      secure: config.admin.secureCookie,
      maxAge: SESSION_LIFETIME_MS / 1_000,
    },
  });
  void app.register(csrfProtection, { sessionPlugin: "@fastify/session" });
  void app.register(rateLimit, { global: false, max: 100, timeWindow: "1 minute" });
  void app.register(fastifyStatic, {
    root: resolve(process.cwd(), "src", "web", "public"),
    prefix: "/admin/static/",
    decorateReply: false,
  });
  void app.register(view, {
    engine: { eta: new Eta() },
    root: resolve(process.cwd(), "src", "web", "views"),
    layout: "layout.eta",
  });

  app.addHook("onRequest", async (request, reply) => {
    if (
      config.runtime.production &&
      request.url.startsWith("/admin") &&
      request.protocol !== "https"
    ) {
      await reply.code(426).type("text/plain").send("HTTPS is required");
    }
  });
  app.addHook("onReady", async () => {
    cleanupTimer = setInterval(() => sessionStore.cleanupExpired(), 60 * 60 * 1_000);
    cleanupTimer.unref();
  });
  app.addHook("onClose", async () => {
    if (cleanupTimer !== undefined) {
      clearInterval(cleanupTimer);
    }
  });

  app.get("/admin/login", async (request, reply) => {
    if (request.session.authenticated === true) {
      return reply.redirect("/admin");
    }
    return reply.view("login.eta", { title: "Herald of Jams login", csrf: reply.generateCsrf() });
  });

  app.post(
    "/admin/login",
    {
      preHandler: csrfHook,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const key = request.ip;
      const now = clock.now();
      const nowIso = now.toISOString();
      const row = database
        .prepare("SELECT window_started_at, attempt_count, blocked_until FROM login_attempts WHERE key = ?")
        .get(key) as LoginAttemptRow | undefined;
      if (row?.blocked_until !== null && row?.blocked_until !== undefined && row.blocked_until > nowIso) {
        return reply.code(429).type("text/plain").send("Invalid credentials");
      }

      const body = request.body as { password?: unknown };
      const password = typeof body.password === "string" ? body.password : "";
      const valid = await verifyPassword(password, config.admin.passwordHash);
      if (!valid) {
        const withinWindow =
          row !== undefined &&
          now.getTime() - new Date(row.window_started_at).getTime() < LOGIN_WINDOW_MS;
        const attemptCount = withinWindow ? row.attempt_count + 1 : 1;
        const windowStartedAt = withinWindow ? row.window_started_at : nowIso;
        const blockedUntil =
          attemptCount >= MAX_LOGIN_FAILURES
            ? new Date(now.getTime() + LOGIN_WINDOW_MS).toISOString()
            : null;
        database
          .prepare(
            `INSERT INTO login_attempts (key, window_started_at, attempt_count, blocked_until)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               window_started_at = excluded.window_started_at,
               attempt_count = excluded.attempt_count,
               blocked_until = excluded.blocked_until`,
          )
          .run(key, windowStartedAt, attemptCount, blockedUntil);
        return reply.code(401).type("text/plain").send("Invalid credentials");
      }

      database.prepare("DELETE FROM login_attempts WHERE key = ?").run(key);
      await request.session.regenerate();
      request.session.authenticated = true;
      request.session.absoluteExpiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS).toISOString();
      await request.session.save();
      return reply.redirect("/admin");
    },
  );

  if (
    dependencies.adminRepository !== undefined &&
    dependencies.gameService !== undefined &&
    dependencies.executor !== undefined &&
    dependencies.permissionReport !== undefined &&
    dependencies.discordConnected !== undefined
  ) {
    registerDashboardRoute(
      app,
      {
        database,
        permissionReport: dependencies.permissionReport,
        discordConnected: dependencies.discordConnected,
      },
      requireAuthenticated,
    );
    registerTemplateRoutes(
      app,
      dependencies.adminRepository,
      requireAuthenticated,
      csrfHook,
    );
    registerRoundRoutes(
      app,
      {
        gameService: dependencies.gameService,
        executor: dependencies.executor,
        adminRepository: dependencies.adminRepository,
        permissionReport: dependencies.permissionReport,
      },
      requireAuthenticated,
      csrfHook,
    );
  } else {
    app.get("/admin", { preHandler: requireAuthenticated }, async (_request, reply) => {
      return reply.type("text/html").send(
        `<main><h1>Herald of Jams</h1><form method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${reply.generateCsrf()}"><button>Log out</button></form></main>`,
      );
    });
  }

  app.post(
    "/admin/logout",
    { preHandler: [requireAuthenticated, csrfHook] },
    async (request, reply) => {
      await request.session.destroy();
      return reply.redirect("/admin/login");
    },
  );

  return app;
}

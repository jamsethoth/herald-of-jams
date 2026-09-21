import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { GameService } from "../src/application/game-service.js";
import { SerialExecutor } from "../src/application/serial-executor.js";
import { OutboxRepository } from "../src/db/outbox-repository.js";
import { hashPassword } from "../src/web/auth.js";
import { buildAdminServer } from "../src/web/server.js";
import { createTestDatabase, message, roundTemplate, type TestDatabaseContext } from "./fixtures.js";

const csrf = (body: string) => /name="_csrf" value="([^"]+)"/.exec(body)?.[1] ?? "";
const cookie = (header: string | string[] | undefined) =>
  (Array.isArray(header) ? header.at(-1) : header)?.split(";", 1)[0] ?? "";

describe("moderation, leaderboard, and operation routes", () => {
  let context: TestDatabaseContext;
  let service: GameService;
  let outbox: OutboxRepository;
  let config: AppConfig;

  beforeEach(async () => {
    context = createTestDatabase();
    service = new GameService(context.repository, context.adminRepository, context.clock, context.ids);
    outbox = new OutboxRepository(context.database, context.clock, context.ids);
    config = {
      discord: { token: "secret", applicationId: "app", guildId: "guild" },
      database: { path: "unused" },
      admin: {
        host: "127.0.0.1",
        port: 3000,
        passwordHash: await hashPassword("password"),
        sessionSecret: "x".repeat(32),
        secureCookie: false,
        trustProxy: false,
      },
      runtime: { production: false },
    };
  });

  afterEach(() => context.close());

  function server() {
    return buildAdminServer({
      config,
      database: context.database,
      clock: context.clock,
      adminRepository: context.adminRepository,
      gameService: service,
      executor: new SerialExecutor(),
      outboxRepository: outbox,
      permissionReport: () => ({ ok: true, missing: [] }),
      discordConnected: () => true,
    });
  }

  async function authenticate(app: ReturnType<typeof server>) {
    const page = await app.inject({ method: "GET", url: "/admin/login" });
    const anonymous = cookie(page.headers["set-cookie"]);
    const login = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { cookie: anonymous, "content-type": "application/x-www-form-urlencoded" },
      payload: `password=password&_csrf=${encodeURIComponent(csrf(page.body))}`,
    });
    const authenticated = cookie(login.headers["set-cookie"]);
    const dashboard = await app.inject({ method: "GET", url: "/admin", headers: { cookie: authenticated } });
    return { cookie: authenticated, csrf: csrf(dashboard.body) };
  }

  it("moderates by Discord ID and banned numerics never evaluate", async () => {
    const templateId = context.adminRepository.createTemplate(roundTemplate());
    await service.activateRound(templateId);
    const app = server();
    const auth = await authenticate(app);

    await app.inject({
      method: "POST",
      url: "/admin/moderation/ban",
      headers: { cookie: auth.cookie },
      payload: { _csrf: auth.csrf, playerId: "alice", displayName: "Alice" },
    });
    await service.processMessage(message("100", "alice", "1"));
    expect(context.database.prepare("SELECT decision FROM submissions WHERE message_id = '100'").get()).toEqual({
      decision: "banned_deleted",
    });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM attempts").get()).toEqual({ count: 0 });
    await app.inject({
      method: "POST",
      url: "/admin/moderation/unban",
      headers: { cookie: auth.cookie },
      payload: { _csrf: auth.csrf, playerId: "alice" },
    });
    expect(
      context.database
        .prepare("SELECT event_type FROM audit_events WHERE event_type IN ('player_banned', 'player_unbanned') ORDER BY rowid")
        .all(),
    ).toEqual([{ event_type: "player_banned" }, { event_type: "player_unbanned" }]);
    await app.close();
  });

  it("shows current totals by immutable ID, archives breakdowns, and guards season reset", async () => {
    const templateId = context.adminRepository.createTemplate(roundTemplate({ target: 2 }));
    await service.activateRound(templateId);
    await service.processMessage(message("100", "alice", "1", { displayName: "Alice Old" }));
    await service.processMessage(message("101", "bob", "2", { displayName: "Bob" }));
    context.database
      .prepare("UPDATE players SET latest_display_name = 'Alice New' WHERE discord_user_id = 'alice'")
      .run();
    const seasonId = (context.database.prepare("SELECT id FROM seasons").get() as { id: string }).id;
    const app = server();
    const auth = await authenticate(app);

    const leaderboard = await app.inject({
      method: "GET",
      url: "/admin/leaderboard",
      headers: { cookie: auth.cookie },
    });
    expect(leaderboard.body).toContain("Alice New");
    expect(leaderboard.body).not.toContain("Alice Old");

    const unsettled = await app.inject({
      method: "POST",
      url: "/admin/seasons/reset",
      headers: { cookie: auth.cookie },
      payload: { _csrf: auth.csrf, confirmation: "RESET" },
    });
    expect(unsettled.statusCode).toBe(409);
    context.database.prepare("UPDATE rounds SET operationally_settled_at = 'settled'").run();
    const reset = await app.inject({
      method: "POST",
      url: "/admin/seasons/reset",
      headers: { cookie: auth.cookie },
      payload: { _csrf: auth.csrf, confirmation: "RESET" },
    });
    expect(reset.statusCode).toBe(302);
    const archive = await app.inject({
      method: "GET",
      url: `/admin/seasons/${seasonId}`,
      headers: { cookie: auth.cookie },
    });
    expect(archive.body).toContain("Alice New");
    expect(archive.body).toContain("participation");
    await app.close();
  });

  it("filters audits and enforces evidence-based operation recovery", async () => {
    const templateId = context.adminRepository.createTemplate(roundTemplate());
    await service.activateRound(templateId);
    context.database
      .prepare(
        "UPDATE discord_outbox SET status = 'delivered' WHERE operation_type = 'start_announcement'",
      )
      .run();
    await service.cancelRound("admin");
    const operation = context.database
      .prepare("SELECT id FROM discord_outbox WHERE operation_type = 'cancellation_announcement'")
      .get() as { id: string };
    context.database
      .prepare(
        "UPDATE discord_outbox SET status = 'retry_wait', last_error = 'secret-token failure' WHERE id = ?",
      )
      .run(operation.id);
    const app = server();
    const auth = await authenticate(app);

    const operations = await app.inject({
      method: "GET",
      url: "/admin/operations",
      headers: { cookie: auth.cookie },
    });
    expect(operations.body).toContain("cancellation_announcement");
    expect(operations.body).toContain("Recorded delivery failure");
    expect(operations.body).not.toContain("secret-token");

    const retry = await app.inject({
      method: "POST",
      url: `/admin/operations/${operation.id}/retry`,
      headers: { cookie: auth.cookie },
      payload: { _csrf: auth.csrf },
    });
    expect(retry.statusCode).toBe(302);
    expect(outbox.status(operation.id)).toBe("pending");
    context.database
      .prepare("UPDATE discord_outbox SET status = 'needs_review' WHERE id = ?")
      .run(operation.id);
    const blindRetry = await app.inject({
      method: "POST",
      url: `/admin/operations/${operation.id}/retry`,
      headers: { cookie: auth.cookie },
      payload: { _csrf: auth.csrf },
    });
    expect(blindRetry.statusCode).toBe(409);
    const missingEvidence = await app.inject({
      method: "POST",
      url: `/admin/operations/${operation.id}/mark-delivered`,
      headers: { cookie: auth.cookie },
      payload: { _csrf: auth.csrf, discordMessageId: "" },
    });
    expect(missingEvidence.statusCode).toBe(400);
    const unconfirmed = await app.inject({
      method: "POST",
      url: `/admin/operations/${operation.id}/abandon`,
      headers: { cookie: auth.cookie },
      payload: { _csrf: auth.csrf, confirmation: "no", reason: "confirmed absent" },
    });
    expect(unconfirmed.statusCode).toBe(400);
    const abandoned = await app.inject({
      method: "POST",
      url: `/admin/operations/${operation.id}/abandon`,
      headers: { cookie: auth.cookie },
      payload: { _csrf: auth.csrf, confirmation: "ABANDON", reason: "confirmed absent" },
    });
    expect(abandoned.statusCode).toBe(302);
    expect(outbox.status(operation.id)).toBe("abandoned");
    expect(context.database.prepare("SELECT operationally_settled_at FROM rounds").get()).toEqual({
      operationally_settled_at: "2026-09-21T00:00:00.000Z",
    });

    const audit = await app.inject({
      method: "GET",
      url: "/admin/audit?eventType=outbox_abandoned",
      headers: { cookie: auth.cookie },
    });
    expect(audit.body).toContain("outbox_abandoned");
    expect(audit.body).not.toContain("round_activated");
    await expect(service.resetSeason()).resolves.toEqual(expect.any(String));
    await app.close();
  });
});

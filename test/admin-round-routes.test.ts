import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { GameService } from "../src/application/game-service.js";
import { SerialExecutor } from "../src/application/serial-executor.js";
import { hashPassword } from "../src/web/auth.js";
import { buildAdminServer } from "../src/web/server.js";
import { createTestDatabase, message, roundTemplate, type TestDatabaseContext } from "./fixtures.js";

function token(body: string): string {
  return /name="_csrf" value="([^"]+)"/.exec(body)?.[1] ?? "";
}

function finalCookie(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header.at(-1) : header;
  return value?.split(";", 1)[0] ?? "";
}

describe("round administration routes", () => {
  let context: TestDatabaseContext;
  let service: GameService;
  let config: AppConfig;
  let permissionOk: boolean;

  beforeEach(async () => {
    context = createTestDatabase();
    service = new GameService(context.repository, context.adminRepository, context.clock, context.ids);
    permissionOk = true;
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
      permissionReport: () => ({
        ok: permissionOk,
        missing: permissionOk ? [] : ["manageMessages"],
      }),
      discordConnected: () => true,
    });
  }

  async function login(app: ReturnType<typeof server>): Promise<string> {
    const page = await app.inject({ method: "GET", url: "/admin/login" });
    const cookie = finalCookie(page.headers["set-cookie"]);
    const response = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `password=password&_csrf=${encodeURIComponent(token(page.body))}`,
    });
    return finalCookie(response.headers["set-cookie"]);
  }

  async function authToken(app: ReturnType<typeof server>, cookie: string): Promise<string> {
    const page = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    return token(page.body);
  }

  it("validates previews without persistence and creates, edits, lists, and escapes templates", async () => {
    const app = server();
    const cookie = await login(app);
    const csrf = await authToken(app, cookie);
    const invalid = await app.inject({
      method: "POST",
      url: "/admin/templates/preview",
      headers: { cookie },
      payload: { ...roundTemplate({ step: 0 }), _csrf: csrf },
    });
    expect(invalid.statusCode).toBe(400);
    expect(context.adminRepository.listTemplates()).toHaveLength(0);

    const preview = await app.inject({
      method: "POST",
      url: "/admin/templates/preview",
      headers: { cookie },
      payload: {
        ...roundTemplate({
          target: 3,
          bonusRules: [{ id: "prime", predicate: { kind: "prime" } }],
        }),
        _csrf: csrf,
      },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.body).toContain("1, 2, 3");
    expect(preview.body).toMatch(/bonus matches.*2/i);
    expect(preview.body).toMatch(/25%.*50%.*75%/s);
    expect(context.adminRepository.listTemplates()).toHaveLength(0);

    const created = await app.inject({
      method: "POST",
      url: "/admin/templates",
      headers: { cookie },
      payload: { ...roundTemplate({ name: "<script>alert(1)</script>" }), _csrf: csrf },
    });
    expect(created.statusCode).toBe(302);
    const stored = context.adminRepository.listTemplates()[0]!;
    const edited = await app.inject({
      method: "POST",
      url: `/admin/templates/${stored.id}`,
      headers: { cookie },
      payload: { ...roundTemplate({ name: "Edited" }), _csrf: csrf },
    });
    expect(edited.statusCode).toBe(302);
    const list = await app.inject({
      method: "GET",
      url: "/admin/templates",
      headers: { cookie },
    });
    expect(list.body).toContain("Edited");
    expect(list.body).not.toContain("<script>");
    expect(list.body).toContain(`/admin/rounds/activate/${stored.id}`);
    const editPage = await app.inject({
      method: "GET",
      url: `/admin/templates/${stored.id}/edit`,
      headers: { cookie },
    });
    expect(editPage.body).toContain('formaction="/admin/templates/preview"');

    const noCsrf = await app.inject({
      method: "POST",
      url: "/admin/templates",
      headers: { cookie },
      payload: roundTemplate(),
    });
    expect(noCsrf.statusCode).toBe(403);
    await app.close();
  });

  it("activates an immutable snapshot and rejects missing Discord permissions", async () => {
    const app = server();
    const cookie = await login(app);
    const csrf = await authToken(app, cookie);
    const templateId = context.adminRepository.createTemplate(roundTemplate());
    permissionOk = false;
    const rejected = await app.inject({
      method: "POST",
      url: `/admin/rounds/activate/${templateId}`,
      headers: { cookie },
      payload: { _csrf: csrf },
    });
    expect(rejected.statusCode).toBe(409);
    expect(rejected.body).toContain("manageMessages");

    permissionOk = true;
    const activated = await app.inject({
      method: "POST",
      url: `/admin/rounds/activate/${templateId}`,
      headers: { cookie },
      payload: { _csrf: csrf },
    });
    expect(activated.statusCode).toBe(302);
    const before = (
      context.database.prepare("SELECT compiled_config_json FROM rounds").get() as {
        compiled_config_json: string;
      }
    ).compiled_config_json;
    context.adminRepository.updateTemplate(templateId, roundTemplate({ target: 9 }));
    expect(
      context.database.prepare("SELECT compiled_config_json FROM rounds").get(),
    ).toEqual({ compiled_config_json: before });

    const second = context.adminRepository.createTemplate(roundTemplate({ name: "Second" }));
    const blocked = await app.inject({
      method: "POST",
      url: `/admin/rounds/activate/${second}`,
      headers: { cookie },
      payload: { _csrf: csrf },
    });
    expect(blocked.statusCode).toBe(409);
    await app.close();
  });

  it("serializes pause, resume, and confirmed cancellation while preserving penalties", async () => {
    const app = server();
    const cookie = await login(app);
    const csrf = await authToken(app, cookie);
    const templateId = context.adminRepository.createTemplate(roundTemplate());
    await service.activateRound(templateId);
    await service.processMessage(message("100", "alice", "1"));
    await service.processMessage(message("101", "alice", "2"));
    await service.processMessage(message("102", "bob", "1"));

    const pause = await app.inject({
      method: "POST",
      url: "/admin/rounds/pause",
      headers: { cookie },
      payload: { _csrf: csrf },
    });
    expect(pause.statusCode).toBe(302);
    expect(context.repository.activeRoundState()).toBe("paused");
    await app.inject({
      method: "POST",
      url: "/admin/rounds/resume",
      headers: { cookie },
      payload: { _csrf: csrf },
    });
    expect(context.repository.activeRoundState()).toBe("counting");

    const unconfirmed = await app.inject({
      method: "POST",
      url: "/admin/rounds/cancel",
      headers: { cookie },
      payload: { _csrf: csrf, confirmation: "no" },
    });
    expect(unconfirmed.statusCode).toBe(400);
    await app.inject({
      method: "POST",
      url: "/admin/rounds/cancel",
      headers: { cookie },
      payload: { _csrf: csrf, confirmation: "CANCEL" },
    });
    expect(context.database.prepare("SELECT state FROM rounds").get()).toEqual({ state: "cancelled" });
    expect(context.repository.leaderboard()).toEqual([
      { playerId: "alice", displayName: "alice", total: -2 },
    ]);

    const next = context.adminRepository.createTemplate(roundTemplate({ name: "Next" }));
    const unsettled = await app.inject({
      method: "POST",
      url: `/admin/rounds/activate/${next}`,
      headers: { cookie },
      payload: { _csrf: csrf },
    });
    expect(unsettled.statusCode).toBe(409);
    expect(unsettled.body).toMatch(/terminal Discord work/i);
    await app.close();
  });

  it("shows private operational state and expected position on the dashboard", async () => {
    const app = server();
    const cookie = await login(app);
    const templateId = context.adminRepository.createTemplate(roundTemplate());
    await service.activateRound(templateId);
    await service.processMessage(message("100", "alice", "1"));

    const dashboard = await app.inject({ method: "GET", url: "/admin", headers: { cookie } });
    expect(dashboard.body).toContain("Discord connected");
    expect(dashboard.body).toContain("Expected position: 1");
    expect(dashboard.body).toContain("Unresolved Discord operations: 2");
    expect(dashboard.body).toContain('name="_csrf"');
    expect(dashboard.body).toContain('/admin/rounds/pause');
    expect(dashboard.body).toContain('/admin/rounds/cancel');
    expect(dashboard.body).toContain('/admin/templates');
    await app.close();
  });
});

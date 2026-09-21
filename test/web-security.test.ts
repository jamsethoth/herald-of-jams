import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config.js";
import { hashPassword } from "../src/web/auth.js";
import { buildAdminServer } from "../src/web/server.js";
import { createTestDatabase, type TestDatabaseContext } from "./fixtures.js";

function cookieValue(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie.at(-1) : setCookie;
  if (header === undefined) {
    throw new Error("response did not set a cookie");
  }
  return header.split(";", 1)[0]!;
}

function csrfToken(body: string): string {
  const match = /name="_csrf" value="([^"]+)"/.exec(body);
  if (match === null) {
    throw new Error("response did not contain a CSRF token");
  }
  return match[1]!;
}

describe("admin server security", () => {
  let context: TestDatabaseContext;
  let config: AppConfig;

  beforeEach(async () => {
    context = createTestDatabase();
    config = {
      discord: { token: "secret-token", applicationId: "app", guildId: "guild" },
      database: { path: "unused" },
      admin: {
        host: "127.0.0.1",
        port: 3000,
        passwordHash: await hashPassword("correct password"),
        sessionSecret: "x".repeat(32),
        secureCookie: false,
        trustProxy: false,
      },
      runtime: { production: false },
    };
  });

  afterEach(() => context.close());

  it("redirects unauthenticated requests and rejects mutation without CSRF", async () => {
    const app = buildAdminServer({ config, database: context.database, clock: context.clock });

    const dashboard = await app.inject({ method: "GET", url: "/admin" });
    expect(dashboard.statusCode).toBe(302);
    expect(dashboard.headers.location).toBe("/admin/login");
    const response = await app.inject({
      method: "POST",
      url: "/admin/login",
      payload: { password: "correct password" },
    });
    expect(response.statusCode).toBe(403);

    await app.close();
  });

  it("regenerates on login, uses hardened scoped cookies, and destroys on logout", async () => {
    const app = buildAdminServer({ config, database: context.database, clock: context.clock });
    const loginPage = await app.inject({ method: "GET", url: "/admin/login" });
    const anonymousCookie = cookieValue(loginPage.headers["set-cookie"]);
    const token = csrfToken(loginPage.body);

    const login = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: {
        cookie: anonymousCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `password=${encodeURIComponent("correct password")}&_csrf=${encodeURIComponent(token)}`,
    });
    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toBe("/admin");
    const authenticatedCookie = cookieValue(login.headers["set-cookie"]);
    expect(authenticatedCookie).not.toBe(anonymousCookie);
    const cookieHeader = String(login.headers["set-cookie"]);
    expect(cookieHeader).toMatch(/HttpOnly/i);
    expect(cookieHeader).toMatch(/SameSite=Strict/i);
    expect(cookieHeader).toMatch(/Path=\/admin/i);
    expect(cookieHeader).toMatch(/Expires=/i);
    expect(cookieHeader).not.toMatch(/Secure/i);

    const dashboard = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: authenticatedCookie },
    });
    expect(dashboard.statusCode).toBe(200);
    const logoutToken = csrfToken(dashboard.body);
    const logout = await app.inject({
      method: "POST",
      url: "/admin/logout",
      headers: {
        cookie: authenticatedCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      payload: `_csrf=${encodeURIComponent(logoutToken)}`,
    });
    expect(logout.statusCode).toBe(302);
    expect(logout.headers.location).toBe("/admin/login");
    const afterLogout = await app.inject({
      method: "GET",
      url: "/admin",
      headers: { cookie: authenticatedCookie },
    });
    expect(afterLogout.statusCode).toBe(302);

    await app.close();
  });

  it("blocks for fifteen minutes after five generic login failures", async () => {
    const app = buildAdminServer({ config, database: context.database, clock: context.clock });
    const loginPage = await app.inject({ method: "GET", url: "/admin/login" });
    const cookie = cookieValue(loginPage.headers["set-cookie"]);
    const token = csrfToken(loginPage.body);
    const failures: string[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/admin/login",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        payload: `password=wrong&_csrf=${encodeURIComponent(token)}`,
      });
      expect(response.statusCode).toBe(401);
      failures.push(response.body);
    }
    expect(new Set(failures)).toEqual(new Set(["Invalid credentials"]));

    const blocked = await app.inject({
      method: "POST",
      url: "/admin/login",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      payload: `password=${encodeURIComponent("correct password")}&_csrf=${encodeURIComponent(token)}`,
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.body).toBe("Invalid credentials");
    expect(
      context.database.prepare("SELECT attempt_count, blocked_until FROM login_attempts").get(),
    ).toEqual({ attempt_count: 5, blocked_until: "2026-09-21T00:15:00.000Z" });

    await app.close();
  });

  it("trusts forwarded HTTPS only from the configured loopback proxy boundary", async () => {
    config.runtime.production = true;
    config.admin.secureCookie = true;
    config.admin.trustProxy = true;
    const app = buildAdminServer({ config, database: context.database, clock: context.clock });

    const forged = await app.inject({
      method: "GET",
      url: "/admin/login",
      remoteAddress: "203.0.113.10",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(forged.statusCode).toBe(426);
    expect(forged.headers["set-cookie"]).toBeUndefined();

    const trusted = await app.inject({
      method: "GET",
      url: "/admin/login",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(trusted.statusCode).toBe(200);
    expect(String(trusted.headers["set-cookie"])).toMatch(/Secure/i);

    await app.close();
  });
});

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

function validEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    DISCORD_TOKEN: "discord-token",
    DISCORD_APPLICATION_ID: "application-id",
    DISCORD_GUILD_ID: "guild-id",
    DATABASE_PATH: "data/test.sqlite",
    ADMIN_HOST: "127.0.0.1",
    ADMIN_PORT: "3000",
    ADMIN_PASSWORD_HASH: "scrypt$hash",
    SESSION_SECRET: "a-session-secret-that-is-at-least-32-bytes",
    ADMIN_SECURE_COOKIE: "false",
    TRUST_PROXY: "false",
    ...overrides,
  };
}

function captureError(work: () => unknown): string {
  try {
    work();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("loadConfig", () => {
  it("loads a loopback development configuration", () => {
    expect(loadConfig(validEnv())).toEqual({
      discord: {
        token: "discord-token",
        applicationId: "application-id",
        guildId: "guild-id",
      },
      database: { path: "data/test.sqlite" },
      admin: {
        host: "127.0.0.1",
        port: 3000,
        passwordHash: "scrypt$hash",
        sessionSecret: "a-session-secret-that-is-at-least-32-bytes",
        secureCookie: false,
        trustProxy: false,
      },
      runtime: { production: false },
    });
  });

  it("defaults omitted cookie and proxy flags to false", () => {
    const config = loadConfig(
      validEnv({ ADMIN_SECURE_COOKIE: undefined, TRUST_PROXY: undefined }),
    );

    expect(config.admin.secureCookie).toBe(false);
    expect(config.admin.trustProxy).toBe(false);
  });

  it("rejects production without trusted proxy and HTTPS cookie policy", () => {
    expect(() =>
      loadConfig(
        validEnv({
          NODE_ENV: "production",
          ADMIN_HOST: "10.0.0.5",
          ADMIN_SECURE_COOKIE: "true",
          TRUST_PROXY: "false",
        }),
      ),
    ).toThrow(/TRUST_PROXY/);
  });

  it("rejects insecure cookies outside loopback development", () => {
    expect(() =>
      loadConfig(validEnv({ ADMIN_HOST: "192.168.1.10", ADMIN_SECURE_COOKIE: "false" })),
    ).toThrow(/ADMIN_SECURE_COOKIE/);
  });

  it("does not include secret values in validation errors", () => {
    const secret = "do-not-echo-this-secret-with-32-bytes";
    const error = captureError(() =>
      loadConfig(validEnv({ SESSION_SECRET: secret, ADMIN_PORT: "bad" })),
    );

    expect(error).toContain("ADMIN_PORT");
    expect(error).not.toContain(secret);
  });

  it("requires a session secret of at least 32 bytes", () => {
    expect(() => loadConfig(validEnv({ SESSION_SECRET: "too-short" }))).toThrow(
      /SESSION_SECRET/,
    );
  });
});

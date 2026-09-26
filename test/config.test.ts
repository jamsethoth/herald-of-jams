import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConfig, resolveConfig } from "../src/config.js";

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

const temporaryDirectories: string[] = [];

function configFile(overrides: Record<string, string | undefined> = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "herald-config-"));
  temporaryDirectories.push(directory);
  const values: Record<string, string | undefined> = {
    NODE_ENV: "production",
    DISCORD_TOKEN: "file-token",
    DISCORD_APPLICATION_ID: "123456789012345678",
    DISCORD_GUILD_ID: "987654321098765432",
    ADMIN_HOST: "127.0.0.1",
    ADMIN_PORT: "3000",
    ADMIN_PASSWORD_HASH: "scrypt$file-hash",
    SESSION_SECRET: "file-session-secret-that-is-at-least-32-bytes",
    ADMIN_SECURE_COOKIE: "false",
    TRUST_PROXY: "false",
    ...overrides,
  };
  const path = join(directory, "config.env");
  writeFileSync(
    path,
    Object.entries(values)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n"),
    "utf8",
  );
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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
      runtime: { production: false, desktop: false },
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

  it("loads an explicit file authoritatively and defaults its database beside the file", () => {
    const path = configFile();
    const config = resolveConfig(
      { configPath: path, desktop: true, smokeTest: false },
      validEnv({ DISCORD_TOKEN: "ambient-token", DATABASE_PATH: "ambient.sqlite" }),
    );

    expect(config.discord.token).toBe("file-token");
    expect(config.database.path).toBe(resolve(dirname(path), "herald-of-jams.sqlite"));
    expect(config.runtime).toEqual({ production: true, desktop: true });
  });

  it("round-trips launcher scrypt and Base64 values through the native env parser", () => {
    const passwordHash = "scrypt$16384$8$1$c2FsdA==$aGFzaA==";
    const sessionSecret = "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=";
    const path = configFile({ ADMIN_PASSWORD_HASH: passwordHash, SESSION_SECRET: sessionSecret });

    const config = resolveConfig(
      { configPath: path, desktop: true, smokeTest: false },
      {},
    );

    expect(config.admin.passwordHash).toBe(passwordHash);
    expect(config.admin.sessionSecret).toBe(sessionSecret);
  });

  it("preserves environment-only configuration", () => {
    expect(resolveConfig({ desktop: false, smokeTest: false }, validEnv())).toEqual(
      loadConfig(validEnv()),
    );
  });

  it.each([
    ["DISCORD_APPLICATION_ID", "not-decimal"],
    ["DISCORD_GUILD_ID", "guild-name"],
    ["ADMIN_HOST", "0.0.0.0"],
    ["TRUST_PROXY", "true"],
    ["ADMIN_SECURE_COOKIE", "true"],
  ])("rejects unsafe desktop %s configuration by field name", (field, value) => {
    const path = configFile({ [field]: value });

    expect(() =>
      resolveConfig({ configPath: path, desktop: true, smokeTest: false }, {}),
    ).toThrow(new RegExp(field));
  });

  it("rejects corrupted explicit files without echoing their values", () => {
    const secret = "do-not-echo-this-config-value";
    const nulPath = configFile();
    writeFileSync(nulPath, `DISCORD_TOKEN=${secret}\0trailing`, "utf8");
    const malformedPath = configFile();
    writeFileSync(malformedPath, `DISCORD_TOKEN=${secret}\nMALFORMED LINE`, "utf8");

    for (const path of [nulPath, malformedPath]) {
      const error = captureError(() =>
        resolveConfig({ configPath: path, desktop: true, smokeTest: false }, {}),
      );
      expect(error).toMatch(/config/i);
      expect(error).not.toContain(secret);
    }
  });
});

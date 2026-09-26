import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";

import { z } from "zod";

import type { LaunchOptions } from "./runtime/launch-options.js";

export interface AppConfig {
  discord: {
    token: string;
    applicationId: string;
    guildId: string;
  };
  database: {
    path: string;
  };
  admin: {
    host: string;
    port: number;
    passwordHash: string;
    sessionSecret: string;
    secureCookie: boolean;
    trustProxy: boolean;
  };
  runtime: {
    production: boolean;
    desktop: boolean;
  };
}

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DISCORD_TOKEN: z.string().min(1, "is required"),
  DISCORD_APPLICATION_ID: z.string().min(1, "is required"),
  DISCORD_GUILD_ID: z.string().min(1, "is required"),
  DATABASE_PATH: z.string().min(1, "is required"),
  ADMIN_HOST: z.string().min(1).default("127.0.0.1"),
  ADMIN_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  ADMIN_PASSWORD_HASH: z.string().min(1, "is required"),
  SESSION_SECRET: z.string().refine((value) => Buffer.byteLength(value, "utf8") >= 32, {
    message: "must contain at least 32 bytes",
  }),
  ADMIN_SECURE_COOKIE: booleanString.default(false),
  TRUST_PROXY: booleanString.default(false),
});

function formatValidationError(error: z.ZodError): Error {
  const details = error.issues
    .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
    .join("; ");

  return new Error(`Invalid configuration: ${details}`);
}

function parseConfiguration(env: NodeJS.ProcessEnv, desktop: boolean): AppConfig {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    throw formatValidationError(result.error);
  }

  const parsed = result.data;
  const production = parsed.NODE_ENV === "production";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

  if (desktop) {
    if (!production) {
      throw new Error("Invalid configuration: NODE_ENV must be production in desktop mode");
    }
    if (!/^\d+$/.test(parsed.DISCORD_APPLICATION_ID)) {
      throw new Error("Invalid configuration: DISCORD_APPLICATION_ID must be decimal");
    }
    if (!/^\d+$/.test(parsed.DISCORD_GUILD_ID)) {
      throw new Error("Invalid configuration: DISCORD_GUILD_ID must be decimal");
    }
    if (!loopbackHosts.has(parsed.ADMIN_HOST)) {
      throw new Error("Invalid configuration: ADMIN_HOST must be loopback in desktop mode");
    }
    if (parsed.TRUST_PROXY) {
      throw new Error("Invalid configuration: TRUST_PROXY must be false in desktop mode");
    }
    if (parsed.ADMIN_SECURE_COOKIE) {
      throw new Error(
        "Invalid configuration: ADMIN_SECURE_COOKIE must be false in desktop mode",
      );
    }
  } else {
    if (production && !parsed.TRUST_PROXY) {
      throw new Error("Invalid configuration: TRUST_PROXY must be true in production");
    }
    if (!parsed.ADMIN_SECURE_COOKIE && (production || !loopbackHosts.has(parsed.ADMIN_HOST))) {
      throw new Error(
        "Invalid configuration: ADMIN_SECURE_COOKIE may be false only for loopback development",
      );
    }
  }

  return {
    discord: {
      token: parsed.DISCORD_TOKEN,
      applicationId: parsed.DISCORD_APPLICATION_ID,
      guildId: parsed.DISCORD_GUILD_ID,
    },
    database: { path: parsed.DATABASE_PATH },
    admin: {
      host: parsed.ADMIN_HOST,
      port: parsed.ADMIN_PORT,
      passwordHash: parsed.ADMIN_PASSWORD_HASH,
      sessionSecret: parsed.SESSION_SECRET,
      secureCookie: parsed.ADMIN_SECURE_COOKIE,
      trustProxy: parsed.TRUST_PROXY,
    },
    runtime: { production, desktop },
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  return parseConfiguration(env, false);
}

function loadExplicitEnvironment(configPath: string): NodeJS.ProcessEnv {
  let contents: string;
  try {
    contents = readFileSync(configPath, "utf8");
  } catch {
    throw new Error("Invalid configuration file: unable to read config");
  }
  if (contents.includes("\0")) {
    throw new Error("Invalid configuration file: NUL bytes are not allowed");
  }
  const malformed = contents.split(/\r?\n/u).some((line) => {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) return false;
    const assignment = trimmed.startsWith("export ") ? trimmed.slice(7).trimStart() : trimmed;
    return !/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(assignment);
  });
  if (malformed) {
    throw new Error("Invalid configuration file: malformed assignment");
  }
  try {
    return parseEnv(contents);
  } catch {
    throw new Error("Invalid configuration file: unable to parse config");
  }
}

export function resolveConfig(options: LaunchOptions, env: NodeJS.ProcessEnv): AppConfig {
  if (options.configPath === undefined) {
    return parseConfiguration(env, options.desktop);
  }
  const fileEnvironment = loadExplicitEnvironment(options.configPath);
  fileEnvironment.DATABASE_PATH ??= resolve(
    dirname(options.configPath),
    "herald-of-jams.sqlite",
  );
  return parseConfiguration(fileEnvironment, options.desktop);
}

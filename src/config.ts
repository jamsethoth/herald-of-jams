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

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const result = environmentSchema.safeParse(env);
  if (!result.success) {
    throw formatValidationError(result.error);
  }

  const parsed = result.data;
  const production = parsed.NODE_ENV === "production";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

  if (production && !parsed.TRUST_PROXY) {
    throw new Error("Invalid configuration: TRUST_PROXY must be true in production");
  }

  if (!parsed.ADMIN_SECURE_COOKIE && (production || !loopbackHosts.has(parsed.ADMIN_HOST))) {
    throw new Error(
      "Invalid configuration: ADMIN_SECURE_COOKIE may be false only for loopback development",
    );
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
    runtime: { production },
  };
}
import { z } from "zod";

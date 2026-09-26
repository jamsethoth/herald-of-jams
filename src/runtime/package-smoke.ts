import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Clock } from "../application/contracts.js";
import type { AppConfig } from "../config.js";
import { migrate, openDatabase } from "../db/database.js";
import { buildAdminServer } from "../web/server.js";
import type { RuntimeResources } from "./resources.js";

const smokeConfig: AppConfig = {
  discord: { token: "offline", applicationId: "1", guildId: "1" },
  database: { path: "unused" },
  admin: {
    host: "127.0.0.1",
    port: 3000,
    passwordHash: "unused",
    sessionSecret: "offline-smoke-session-secret-32-bytes",
    secureCookie: false,
    trustProxy: false,
  },
  runtime: { production: true, desktop: true },
};

const systemClock: Clock = { now: () => new Date() };

export async function runPackageSmokeTest(options: {
  readonly dataDirectory: string;
  readonly resources: RuntimeResources;
}): Promise<void> {
  mkdirSync(options.dataDirectory, { recursive: true });
  const databasePath = join(options.dataDirectory, "package-smoke.sqlite");
  const database = openDatabase(databasePath);
  let app: ReturnType<typeof buildAdminServer> | undefined;
  try {
    migrate(database, options.resources.migrationsDirectory);
    app = buildAdminServer({
      config: smokeConfig,
      database,
      clock: systemClock,
      resources: options.resources,
      health: () => ({ status: "ready" }),
    });
    const login = await app.inject({ method: "GET", url: "/admin/login" });
    if (login.statusCode !== 200 || !login.body.includes("Herald of Jams login")) {
      throw new Error("Packaged login page smoke check failed");
    }
    const stylesheet = await app.inject({ method: "GET", url: "/admin/static/admin.css" });
    if (stylesheet.statusCode !== 200) {
      throw new Error("Packaged static asset smoke check failed");
    }
  } finally {
    if (app !== undefined) await app.close();
    database.close();
    rmSync(`${databasePath}-wal`, { force: true });
    rmSync(`${databasePath}-shm`, { force: true });
  }
}

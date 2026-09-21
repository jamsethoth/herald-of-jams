import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import Database from "better-sqlite3";

interface Migration {
  version: number;
  sql: string;
  requiresForeignKeysOff: boolean;
}

function loadMigrations(): readonly Migration[] {
  const directory = resolve(process.cwd(), "src", "db", "migrations");
  return readdirSync(directory)
    .map((filename) => {
      const match = /^(\d+)-.+\.sql$/.exec(filename);
      if (match === null) {
        return undefined;
      }
      return {
        version: Number(match[1]),
        sql: readFileSync(resolve(directory, filename), "utf8"),
        requiresForeignKeysOff: false,
      };
    })
    .filter((migration): migration is Migration => migration !== undefined)
    .map((migration) => ({
      ...migration,
      requiresForeignKeysOff: migration.sql.startsWith("-- requires-foreign-keys-off"),
    }))
    .sort((left, right) => left.version - right.version);
}

function recordVersion(database: Database.Database, version: number): void {
  database
    .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
    .run(version, new Date().toISOString());
}

function appliedVersions(database: Database.Database): readonly number[] {
  const hasMigrationTable = database
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (hasMigrationTable === undefined) {
    return [];
  }
  return (
    database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
      version: number;
    }[]
  ).map(({ version }) => version);
}

export function openDatabase(path: string): Database.Database {
  const database = new Database(path);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  return database;
}

export function migrate(database: Database.Database): void {
  const migrations = loadMigrations();
  const knownVersions = new Set(migrations.map(({ version }) => version));
  const alreadyApplied = appliedVersions(database);

  for (const version of alreadyApplied) {
    if (!knownVersions.has(version)) {
      throw new Error(`database uses unknown future schema version ${version}`);
    }
  }

  const applied = new Set(alreadyApplied);
  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      continue;
    }
    if (migration.requiresForeignKeysOff) {
      database.pragma("foreign_keys = OFF");
      try {
        database
          .transaction(() => {
            database.exec(migration.sql);
            const violations = database.pragma("foreign_key_check") as unknown[];
            if (violations.length > 0) {
              throw new Error("migration violates foreign keys");
            }
            recordVersion(database, migration.version);
          })
          .immediate();
      } finally {
        database.pragma("foreign_keys = ON");
      }
      continue;
    }
    database.transaction(() => {
      database.exec(migration.sql);
      recordVersion(database, migration.version);
    })();
  }
}

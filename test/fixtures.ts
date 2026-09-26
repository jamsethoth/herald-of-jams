import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type Database from "better-sqlite3";

import type { Clock, IdGenerator, InboundDiscordMessage } from "../src/application/contracts.js";
import { AdminRepository } from "../src/db/admin-repository.js";
import { openDatabase, migrate } from "../src/db/database.js";
import { GameRepository } from "../src/db/game-repository.js";
import type { RoundTemplateInput } from "../src/domain/types.js";
import type { RuntimeResources } from "../src/runtime/resources.js";

export const testRuntimeResources: RuntimeResources = {
  migrationsDirectory: resolve(import.meta.dirname, "..", "src", "db", "migrations"),
  viewsDirectory: resolve(import.meta.dirname, "..", "src", "web", "views"),
  publicDirectory: resolve(import.meta.dirname, "..", "src", "web", "public"),
};

export class TestClock implements Clock {
  constructor(private current = new Date("2026-09-21T00:00:00.000Z")) {}

  now(): Date {
    return new Date(this.current);
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

export class SequenceIds implements IdGenerator {
  private sequence = 0;

  next(): string {
    this.sequence += 1;
    return `id-${this.sequence.toString().padStart(4, "0")}`;
  }
}

export interface TestDatabaseContext {
  database: Database.Database;
  repository: GameRepository;
  adminRepository: AdminRepository;
  clock: TestClock;
  ids: SequenceIds;
  close(): void;
}

export function createTestDatabase(): TestDatabaseContext {
  const directory = mkdtempSync(join(tmpdir(), "herald-of-jams-service-"));
  const database = openDatabase(join(directory, "game.sqlite"));
  migrate(database, testRuntimeResources.migrationsDirectory);
  const clock = new TestClock();
  const ids = new SequenceIds();
  return {
    database,
    repository: new GameRepository(database),
    adminRepository: new AdminRepository(database, clock, ids),
    clock,
    ids,
    close() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function roundTemplate(overrides: Partial<RoundTemplateInput> = {}): RoundTemplateInput {
  return {
    name: "Count to five",
    channelId: "channel-1",
    start: 1,
    target: 5,
    step: 1,
    skipRules: [],
    bonusRules: [],
    ...overrides,
  };
}

export function message(
  id: string,
  authorId: string,
  content: string,
  overrides: Partial<InboundDiscordMessage> = {},
): InboundDiscordMessage {
  return {
    id,
    channelId: "channel-1",
    authorId,
    displayName: authorId,
    content,
    createdAt: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

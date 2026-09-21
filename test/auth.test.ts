import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "fastify";

import {
  SqliteSessionStore,
  hashPassword,
  verifyPassword,
} from "../src/web/auth.js";
import { createTestDatabase, type TestDatabaseContext } from "./fixtures.js";

describe("password hashing", () => {
  it("hashes with random salt and verifies only the correct password", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(first).toMatch(/^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(second).not.toBe(first);
    await expect(verifyPassword("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyPassword("wrong", first)).resolves.toBe(false);
  });

  it.each(["", "plaintext", "scrypt$bad$8$1$salt$hash", "scrypt$16384$8$1$bad$bad"])(
    "rejects malformed encoding %j without throwing",
    async (encoded) => {
      await expect(verifyPassword("password", encoded)).resolves.toBe(false);
    },
  );
});

describe("SqliteSessionStore", () => {
  let context: TestDatabaseContext;
  let store: SqliteSessionStore;

  beforeEach(() => {
    context = createTestDatabase();
    store = new SqliteSessionStore(context.database, context.clock);
  });

  afterEach(() => context.close());

  function set(id: string, session: Session): Promise<void> {
    return new Promise((resolve, reject) => {
      store.set(id, session, (error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  function get(id: string): Promise<Session | null | undefined> {
    return new Promise((resolve, reject) => {
      store.get(id, (error, session) => (error === null ? resolve(session) : reject(error)));
    });
  }

  function destroy(id: string): Promise<void> {
    return new Promise((resolve, reject) => {
      store.destroy(id, (error) => (error === undefined ? resolve() : reject(error)));
    });
  }

  it("round-trips, expires, cleans up, and destroys sessions", async () => {
    const expires = new Date(context.clock.now().getTime() + 60_000);
    const session = {
      cookie: { originalMaxAge: 60_000, expires },
      authenticated: true,
    } as Session;
    await set("session-1", session);
    await expect(get("session-1")).resolves.toMatchObject({ authenticated: true });

    context.clock.advance(60_001);
    await expect(get("session-1")).resolves.toBeNull();
    expect(store.cleanupExpired()).toBe(0);

    await set("session-2", {
      cookie: { originalMaxAge: 60_000, expires: new Date(context.clock.now().getTime() + 60_000) },
    } as Session);
    await destroy("session-2");
    await expect(get("session-2")).resolves.toBeNull();
  });
});

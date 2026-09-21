import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

import type Database from "better-sqlite3";
import type { Session } from "fastify";
import type { Clock } from "../application/contracts.js";

declare module "fastify" {
  interface Session {
    authenticated?: boolean;
    absoluteExpiresAt?: string;
  }
}

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const HASH_BYTES = 64;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1_000;

function derive(password: string, salt: Buffer, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      length,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error === null ? resolve(result) : reject(error)),
    );
  });
}

type SessionWithCookie = Session & {
  cookie: {
    expires?: Date | string | null;
  };
};

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, HASH_BYTES);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function strictBase64(value: string, expectedBytes: number): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length === expectedBytes && decoded.toString("base64") === value
    ? decoded
    : undefined;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const [algorithm, nText, rText, pText, saltText, hashText, extra] = encoded.split("$");
    if (algorithm !== "scrypt" || extra !== undefined) {
      return false;
    }
    const n = Number(nText);
    const r = Number(rText);
    const p = Number(pText);
    if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) {
      return false;
    }
    const salt = strictBase64(saltText ?? "", SALT_BYTES);
    const expected = strictBase64(hashText ?? "", HASH_BYTES);
    if (salt === undefined || expected === undefined) {
      return false;
    }
    const actual = await derive(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export class SqliteSessionStore {
  constructor(
    private readonly database: Database.Database,
    private readonly clock: Clock,
  ) {}

  set(sessionId: string, session: Session, callback: (error?: unknown) => void): void {
    try {
      const storedSession = session as SessionWithCookie;
      const rawExpires = storedSession.cookie.expires;
      const expires =
        rawExpires === undefined || rawExpires === null
          ? new Date(this.clock.now().getTime() + SESSION_LIFETIME_MS)
          : new Date(rawExpires);
      this.database
        .prepare(
          `INSERT INTO admin_sessions (session_id, data_json, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             data_json = excluded.data_json,
             expires_at = excluded.expires_at`,
        )
        .run(sessionId, JSON.stringify(session), expires.toISOString());
      callback();
    } catch (error) {
      callback(error);
    }
  }

  get(
    sessionId: string,
    callback: (error: unknown, result?: Session | null) => void,
  ): void {
    try {
      const row = this.database
        .prepare("SELECT data_json, expires_at FROM admin_sessions WHERE session_id = ?")
        .get(sessionId) as { data_json: string; expires_at: string } | undefined;
      if (row === undefined) {
        callback(null, null);
        return;
      }
      if (row.expires_at <= this.clock.now().toISOString()) {
        this.database.prepare("DELETE FROM admin_sessions WHERE session_id = ?").run(sessionId);
        callback(null, null);
        return;
      }
      const session = JSON.parse(row.data_json) as SessionWithCookie;
      if (typeof session.cookie.expires === "string") {
        session.cookie.expires = new Date(session.cookie.expires);
      }
      callback(null, session);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sessionId: string, callback: (error?: unknown) => void): void {
    try {
      this.database.prepare("DELETE FROM admin_sessions WHERE session_id = ?").run(sessionId);
      callback();
    } catch (error) {
      callback(error);
    }
  }

  cleanupExpired(): number {
    return this.database
      .prepare("DELETE FROM admin_sessions WHERE expires_at <= ?")
      .run(this.clock.now().toISOString()).changes;
  }
}

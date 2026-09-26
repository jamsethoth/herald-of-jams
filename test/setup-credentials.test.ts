import { Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { verifyPassword } from "../src/web/auth.js";
import { runSetupCredentials } from "../src/runtime/setup-credentials.js";

async function invoke(password: string): Promise<string> {
  let output = "";
  const target = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  await runSetupCredentials(Readable.from([password]), target);
  return output;
}

describe("setup credential helper", () => {
  it("returns a password hash and a 32-byte Base64 session secret without echoing stdin", async () => {
    const password = "setup password that must not appear";
    const output = await invoke(password);
    const credentials = JSON.parse(output) as {
      passwordHash: string;
      sessionSecret: string;
    };

    expect(await verifyPassword(password, credentials.passwordHash)).toBe(true);
    expect(Buffer.from(credentials.sessionSecret, "base64")).toHaveLength(32);
    expect(output).not.toContain(password);
  });

  it("rejects empty stdin without writing credentials", async () => {
    await expect(invoke("")).rejects.toThrow(/password/i);
  });
});

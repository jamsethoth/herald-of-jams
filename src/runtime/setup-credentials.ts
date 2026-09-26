import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { pathToFileURL } from "node:url";

import { hashPassword } from "../web/auth.js";

export async function runSetupCredentials(input: Readable, output: Writable): Promise<void> {
  input.setEncoding("utf8");
  let password = "";
  for await (const chunk of input) password += chunk;
  password = password.replace(/\r?\n$/u, "");
  if (password.length === 0) throw new Error("Password must not be empty");

  const passwordHash = await hashPassword(password);
  password = "";
  const sessionSecret = randomBytes(32).toString("base64");
  output.write(`${JSON.stringify({ passwordHash, sessionSecret })}\n`);
}

async function main(): Promise<void> {
  await runSetupCredentials(process.stdin, process.stdout);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch((error: unknown) => {
    process.exitCode = 1;
    const name = error instanceof Error ? error.name : "UnknownError";
    process.stderr.write(`Credential setup failed: ${name}\n`);
  });
}

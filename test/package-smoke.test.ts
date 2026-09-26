import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { runPackageSmokeTest } from "../src/runtime/package-smoke.js";
import { resolveRuntimeResources } from "../src/runtime/resources.js";

const temporaryDirectories: string[] = [];

function treeDigest(root: string): readonly string[] {
  const entries: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
        entries.push(`${relative(root, path)}:${hash}`);
      }
    }
  };
  visit(root);
  return entries.sort();
}

function packagedAssets(): { applicationRoot: string; resources: ReturnType<typeof resolveRuntimeResources> } {
  const root = mkdtempSync(join(tmpdir(), "herald-package-"));
  temporaryDirectories.push(root);
  const applicationRoot = join(root, "Portable Apps", "Hérald の Jams", "app");
  const assets = join(applicationRoot, "assets");
  mkdirSync(assets, { recursive: true });
  cpSync(resolve("src", "db", "migrations"), join(assets, "migrations"), { recursive: true });
  cpSync(resolve("src", "web", "views"), join(assets, "views"), { recursive: true });
  cpSync(resolve("src", "web", "public"), join(assets, "public"), { recursive: true });
  return { applicationRoot, resources: resolveRuntimeResources(applicationRoot) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged runtime smoke test", () => {
  it("migrates and renders offline while confining writes to the data directory", async () => {
    const { applicationRoot, resources } = packagedAssets();
    const dataDirectory = mkdtempSync(join(tmpdir(), "herald-smoke-data-"));
    temporaryDirectories.push(dataDirectory);
    const before = treeDigest(applicationRoot);

    await runPackageSmokeTest({ dataDirectory, resources });

    expect(treeDigest(applicationRoot)).toEqual(before);
    const databasePath = join(dataDirectory, "package-smoke.sqlite");
    expect(existsSync(`${databasePath}-wal`)).toBe(false);
    expect(existsSync(`${databasePath}-shm`)).toBe(false);
    const database = new Database(databasePath, { readonly: true });
    expect(database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({
      version: 3,
    });
    database.close();
  });

  it("runs when the packaged application tree is read-only", async () => {
    const { applicationRoot, resources } = packagedAssets();
    const dataDirectory = mkdtempSync(join(tmpdir(), "herald-smoke-data-"));
    temporaryDirectories.push(dataDirectory);
    const before = treeDigest(applicationRoot);

    for (const entry of before) {
      chmodSync(join(applicationRoot, entry.slice(0, entry.indexOf(":"))), 0o444);
    }
    await runPackageSmokeTest({ dataDirectory, resources });

    expect(treeDigest(applicationRoot)).toEqual(before);
  });
});

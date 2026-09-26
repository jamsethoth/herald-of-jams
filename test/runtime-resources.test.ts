import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRuntimeResources } from "../src/runtime/resources.js";

describe("runtime resources", () => {
  it("resolves packaged assets from an application root containing spaces and Unicode", () => {
    const applicationRoot = join("C:\\Portable Apps", "Hérald の Jams", "app");

    expect(resolveRuntimeResources(applicationRoot)).toEqual({
      migrationsDirectory: join(applicationRoot, "assets", "migrations"),
      viewsDirectory: join(applicationRoot, "assets", "views"),
      publicDirectory: join(applicationRoot, "assets", "public"),
    });
  });
});

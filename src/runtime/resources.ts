import { join } from "node:path";

export interface RuntimeResources {
  readonly migrationsDirectory: string;
  readonly viewsDirectory: string;
  readonly publicDirectory: string;
}

export function resolveRuntimeResources(applicationRoot: string): RuntimeResources {
  const assetsDirectory = join(applicationRoot, "assets");
  return {
    migrationsDirectory: join(assetsDirectory, "migrations"),
    viewsDirectory: join(assetsDirectory, "views"),
    publicDirectory: join(assetsDirectory, "public"),
  };
}

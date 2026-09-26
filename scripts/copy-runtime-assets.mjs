import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const assetsDirectory = resolve("build", "app", "assets");
rmSync(assetsDirectory, { recursive: true, force: true });
mkdirSync(assetsDirectory, { recursive: true });

for (const [source, destination] of [
  [resolve("src", "db", "migrations"), resolve(assetsDirectory, "migrations")],
  [resolve("src", "web", "views"), resolve(assetsDirectory, "views")],
  [resolve("src", "web", "public"), resolve(assetsDirectory, "public")],
]) {
  cpSync(source, destination, { recursive: true });
}

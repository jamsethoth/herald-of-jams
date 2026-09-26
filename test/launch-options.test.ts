import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseLaunchOptions } from "../src/runtime/launch-options.js";

describe("parseLaunchOptions", () => {
  it("parses an absolute config path and desktop mode", () => {
    const configPath = resolve("config", "herald.env");

    expect(parseLaunchOptions(["--config", configPath, "--desktop"])).toEqual({
      configPath,
      desktop: true,
      smokeTest: false,
    });
  });

  it.each(["--config", "--data-dir"])("rejects a missing value for %s", (option) => {
    expect(() => parseLaunchOptions([option])).toThrow(new RegExp(option));
  });

  it("rejects relative config paths", () => {
    expect(() => parseLaunchOptions(["--config", "config.env"])).toThrow(/absolute/i);
  });

  it("rejects unknown and duplicate arguments", () => {
    expect(() => parseLaunchOptions(["--surprise"])).toThrow(/--surprise/);
    expect(() => parseLaunchOptions(["--desktop", "--desktop"])).toThrow(/duplicate.*--desktop/i);
  });
});

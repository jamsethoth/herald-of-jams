import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { installControlChannel } from "../src/runtime/control-channel.js";
import { RuntimeHealth } from "../src/runtime/health.js";
import { formatStartupError } from "../src/runtime/startup-error.js";

describe("desktop runtime control", () => {
  it("recognizes one fragmented shutdown command and ignores unknown input", async () => {
    const input = new PassThrough();
    const shutdown = vi.fn(async () => undefined);
    const dispose = installControlChannel(input, shutdown);

    input.write("status\nshut");
    input.write("down\r");
    input.write("\nshutdown\n");
    input.end();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(shutdown).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("does not interpret EOF as shutdown", async () => {
    const input = new PassThrough();
    const shutdown = vi.fn(async () => undefined);
    installControlChannel(input, shutdown);

    input.end();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(shutdown).not.toHaveBeenCalled();
  });
});

describe("runtime health", () => {
  it("tracks operational state and reports a later critical failure as degraded", () => {
    let critical = false;
    const health = new RuntimeHealth(() => critical);

    expect(health.snapshot()).toEqual({ status: "starting" });
    health.set("reconciling");
    expect(health.snapshot()).toEqual({ status: "reconciling" });
    health.set("ready");
    expect(health.snapshot()).toEqual({ status: "ready" });
    critical = true;
    expect(health.snapshot()).toEqual({ status: "degraded" });
  });
});

describe("startup error formatting", () => {
  it("exposes approved configuration field messages without their values", () => {
    const message = formatStartupError(
      new Error("Invalid configuration: ADMIN_PORT: expected number"),
    );
    expect(message).toContain("ADMIN_PORT");
  });

  it("exposes only an arbitrary error class and code", () => {
    const error = Object.assign(new Error("database path C:\\Users\\Private\\secret.sqlite"), {
      code: "EACCES",
    });
    const message = formatStartupError(error);

    expect(message).toContain("Error");
    expect(message).toContain("EACCES");
    expect(message).not.toContain("Private");
    expect(message).not.toContain("secret.sqlite");
    expect(message).not.toContain("at ");
  });
});

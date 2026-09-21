import { describe, expect, it, vi } from "vitest";

import { OutboxPump } from "../src/application/outbox-pump.js";

describe("OutboxPump", () => {
  it("drains all immediately available work after one wake", async () => {
    const results = [
      { kind: "delivered" as const, operationId: "one" },
      { kind: "delivered" as const, operationId: "two" },
      { kind: "idle" as const },
    ];
    const dispatchNext = vi.fn(async () => results.shift() ?? { kind: "idle" as const });
    const pump = new OutboxPump({ dispatchNext }, () => []);
    pump.start();
    pump.wake("channel-1");

    await vi.waitFor(() => expect(dispatchNext).toHaveBeenCalledTimes(3));
    await pump.stop();
  });

  it("retries scheduled work without waiting for another submission", async () => {
    const results = [
      {
        kind: "retry_scheduled" as const,
        operationId: "one",
        nextAttemptAt: new Date(Date.now() + 10).toISOString(),
      },
      { kind: "delivered" as const, operationId: "one" },
      { kind: "idle" as const },
    ];
    const dispatchNext = vi.fn(async () => results.shift() ?? { kind: "idle" as const });
    const pump = new OutboxPump({ dispatchNext }, () => []);
    pump.start();
    pump.wake("channel-1");

    await vi.waitFor(() => expect(dispatchNext).toHaveBeenCalledTimes(3));
    await pump.stop();
  });
});

import { describe, expect, it } from "vitest";

import { SerialExecutor } from "../src/application/serial-executor.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SerialExecutor", () => {
  it("runs work for one key strictly in enqueue order", async () => {
    const executor = new SerialExecutor();
    const firstGate = deferred<void>();
    const events: string[] = [];
    const first = executor.run("channel", async () => {
      events.push("first-start");
      await firstGate.promise;
      events.push("first-end");
      return 1;
    });
    const second = executor.run("channel", async () => {
      events.push("second-start");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    firstGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first-start", "first-end", "second-start"]);
    expect(executor.activeKeyCount).toBe(0);
  });

  it("allows different keys to run concurrently and survives rejected work", async () => {
    const executor = new SerialExecutor();
    const gate = deferred<void>();
    const slow = executor.run("one", async () => gate.promise);
    await expect(executor.run("two", async () => "done")).resolves.toBe("done");

    await expect(executor.run("errors", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(executor.run("errors", async () => "recovered")).resolves.toBe("recovered");
    gate.resolve();
    await slow;
  });
});

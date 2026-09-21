import type { DispatchResult } from "./outbox-dispatcher.js";

export class OutboxPump {
  private readonly queued = new Set<string>();
  private readonly retryTimers = new Map<string, NodeJS.Timeout>();
  private interval: NodeJS.Timeout | undefined;
  private draining: Promise<void> | undefined;
  private running = false;

  constructor(
    private readonly dispatcher: { dispatchNext(channelId: string): Promise<DispatchResult> },
    private readonly channelIds: () => readonly string[],
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.interval = setInterval(() => this.wakeAll(), 1_000);
    this.interval.unref();
    this.wakeAll();
  }

  wake(channelId: string): void {
    if (!this.running) return;
    const timer = this.retryTimers.get(channelId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.retryTimers.delete(channelId);
    }
    this.queued.add(channelId);
    this.scheduleDrain();
  }

  wakeAll(): void {
    for (const channelId of this.channelIds()) this.queued.add(channelId);
    this.scheduleDrain();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.interval !== undefined) clearInterval(this.interval);
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    await this.draining;
  }

  private scheduleDrain(): void {
    if (!this.running || this.draining !== undefined || this.queued.size === 0) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      this.scheduleDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.running && this.queued.size > 0) {
      const channelId = this.queued.values().next().value as string;
      this.queued.delete(channelId);
      let result: DispatchResult;
      try {
        result = await this.dispatcher.dispatchNext(channelId);
      } catch {
        this.scheduleRetry(channelId, Date.now() + 1_000);
        continue;
      }
      if (result.kind === "delivered") {
        this.queued.add(channelId);
      } else if (result.kind === "retry_scheduled") {
        this.scheduleRetry(channelId, new Date(result.nextAttemptAt).getTime());
      }
    }
  }

  private scheduleRetry(channelId: string, at: number): void {
    if (!this.running) return;
    const delay = Math.max(0, Math.min(300_000, at - Date.now()));
    const timer = setTimeout(() => {
      this.retryTimers.delete(channelId);
      this.wake(channelId);
    }, delay);
    timer.unref();
    this.retryTimers.set(channelId, timer);
  }
}

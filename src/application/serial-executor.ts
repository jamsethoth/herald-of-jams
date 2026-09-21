export class SerialExecutor {
  private readonly tails = new Map<string, Promise<void>>();

  get activeKeyCount(): number {
    return this.tails.size;
  }

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key);
    const result = previous === undefined ? work() : previous.then(work);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.finally(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    });
    return result;
  }

  async whenIdle(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all([...this.tails.values()]);
    }
  }
}

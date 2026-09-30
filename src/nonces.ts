import type { StacksNet } from './types.js';

// ponytail: serial broadcasts cap sponsored throughput at one transaction per network at a time.
export class NonceAllocator {
  private next = new Map<StacksNet, bigint>();
  private queue = new Map<StacksNet, Promise<unknown>>();

  constructor(private fetchNext: (net: StacksNet) => Promise<bigint>) {}

  run<T>(net: StacksNet, fn: (nonce: bigint) => Promise<{ commit: boolean; value: T }>): Promise<T> {
    const run = (this.queue.get(net) ?? Promise.resolve()).then(async () => {
      const nonce = this.next.get(net) ?? (await this.fetchNext(net));
      try {
        const result = await fn(nonce);
        if (result.commit) this.next.set(net, nonce + 1n);
        else this.next.delete(net);
        return result.value;
      } catch (error) {
        this.next.delete(net);
        throw error;
      }
    });
    this.queue.set(net, run.catch(() => undefined));
    return run;
  }
}

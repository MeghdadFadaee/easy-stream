export interface DistributedLease {
  release(): Promise<void>;
}

export interface DistributedLock {
  acquire(key: string, ttlMs: number): Promise<DistributedLease | undefined>;
}

export class SingleFlight {
  readonly #running = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.#running.get(key);
    if (existing !== undefined) return existing as Promise<T>;
    const promise = operation().finally(() => {
      if (this.#running.get(key) === promise) this.#running.delete(key);
    });
    this.#running.set(key, promise);
    return promise;
  }

  has(key: string): boolean {
    return this.#running.has(key);
  }

  get size(): number {
    return this.#running.size;
  }
}

export async function withDistributedSingleFlight<T>(
  lock: DistributedLock,
  key: string,
  ttlMs: number,
  operation: () => Promise<T>,
): Promise<T | undefined> {
  const lease = await lock.acquire(key, ttlMs);
  if (lease === undefined) return undefined;
  try {
    return await operation();
  } finally {
    await lease.release();
  }
}

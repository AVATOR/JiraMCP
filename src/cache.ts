// Fields, projects, spaces and the current user rarely change, so listings are reused for a while.
export const REFERENCE_CACHE_TTL_MS = 10 * 60_000;

export class ReferenceCache {
  private readonly entries = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(private readonly ttlMs: number = REFERENCE_CACHE_TTL_MS) {}

  // Caches the promise, so concurrent callers share one request; failures are not kept.
  get<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expires > Date.now()) {
      return hit.value as Promise<T>;
    }

    const value = load();
    if (this.ttlMs > 0) {
      const entry = { expires: Date.now() + this.ttlMs, value };
      this.entries.set(key, entry);
      value.catch(() => {
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
      });
    }

    return value;
  }
}

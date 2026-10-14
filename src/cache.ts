// Fields, projects, spaces and the current user rarely change, so listings are reused for a while.
export const REFERENCE_CACHE_TTL_MS = 10 * 60_000;

/**
 * TTL cache for reference data (fields, projects, spaces, current user).
 */
export class ReferenceCache {
  private readonly entries = new Map<string, { expires: number; value: Promise<unknown> }>();

  constructor(private readonly ttlMs: number = REFERENCE_CACHE_TTL_MS) {}

  /**
   * Caches the promise, so concurrent callers share one request; failures are not kept.
   *
   * @param key Cache key.
   * @param load Loader called on a miss.
   * @returns The cached or freshly loaded value.
   */
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

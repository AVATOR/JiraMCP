// Fields, projects, spaces and the current user rarely change, so listings are reused for a while.
export const REFERENCE_CACHE_TTL_MS = 10 * 60_000;
// Issues and comments change while people work on them, so they are only kept briefly: enough to
// answer repeated reads within one conversation without serving stale data for long.
export const ISSUE_CACHE_TTL_MS = 30_000;
// A long-running (HTTP) server must not grow without bound.
const MAX_ENTRIES = 500;

/**
 * TTL cache for reference data (fields, projects, spaces, current user) and short-lived issue reads.
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
      this.evict();
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

  /** Drops expired entries and, when still full, the oldest ones. */
  private evict(): void {
    if (this.entries.size < MAX_ENTRIES) {
      return;
    }

    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expires <= now) {
        this.entries.delete(key);
      }
    }

    // Maps iterate in insertion order, so the first keys are the oldest.
    for (const key of this.entries.keys()) {
      if (this.entries.size < MAX_ENTRIES) {
        break;
      }
      this.entries.delete(key);
    }
  }
}

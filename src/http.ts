import type { JsonValue } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const MAX_ERROR_BODY_CHARS = 1000;
// Safety cap when walking a paginated listing to its end.
export const MAX_LIST_PAGES = 20;

export type HttpConfig = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retry-After is either seconds or an HTTP date; fall back to exponential backoff.
export function retryDelayMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;

  if (Number.isFinite(seconds)) {
    return Math.min(seconds * 1000, 60_000);
  }

  const date = header ? Date.parse(header) : NaN;
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), 60_000);
  }

  return 1000 * 2 ** attempt;
}

// The single place that talks to Atlassian: GET only, with a timeout and retries on rate limiting.
export class AtlassianHttp {
  readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(
    config: HttpConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.authHeader = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  }

  async fetchWithRetry(url: URL, accept: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: accept,
          Authorization: `Basic ${this.authHeader}`
        },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        await response.body?.cancel();
        await sleep(retryDelayMs(response, attempt));
        continue;
      }

      return response;
    }
  }

  // The caller states the payload type it expects; the body is not validated at runtime.
  async get<T = JsonValue>(path: string, query?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await this.fetchWithRetry(url, "application/json");

    if (!response.ok) {
      // Error pages can be full HTML documents; keep only the start of them.
      const text = await response.text();
      const detail = text.length > MAX_ERROR_BODY_CHARS ? `${text.slice(0, MAX_ERROR_BODY_CHARS)}…` : text;
      throw new Error(`Jira request failed (${response.status} ${response.statusText}) for ${path}: ${detail}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    return (contentType.includes("application/json") ? await response.json() : await response.text()) as T;
  }
}

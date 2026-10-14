import { basicAuthHeader } from "./auth.js";
import type { JsonValue } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
// Rate limiting and transient gateway errors; everything else is returned to the caller as-is.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ERROR_BODY_CHARS = 1000;
// Attachments are buffered in memory, so very large files are refused up front.
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
// Safety cap when walking a paginated listing to its end.
export const MAX_LIST_PAGES = 20;

export type HttpConfig = {
  baseUrl: string;
  email: string;
  apiToken: string;
};

/**
 * Resolves after the given number of milliseconds.
 *
 * @param ms Delay in milliseconds.
 * @returns Promise that resolves after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry-After is either seconds or an HTTP date; fall back to exponential backoff.
 *
 * @param response The retryable (429/502/503/504) response.
 * @param attempt Zero-based retry number, used for exponential backoff.
 * @returns Delay in milliseconds, at most 60 s.
 */
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

/**
 * The single place that talks to Atlassian: GET only, with a timeout and retries on rate limiting.
 */
export class AtlassianHttp {
  readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(
    config: HttpConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.authHeader = basicAuthHeader(config.email, config.apiToken);
  }

  /**
   * Issues a GET, retrying on 429, 502, 503 and 504.
   *
   * @param url Request URL.
   * @param accept Accept header value.
   * @returns The response, after retrying on 429/502/503/504.
   */
  async fetchWithRetry(url: URL, accept: string): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: accept,
          Authorization: this.authHeader
        },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (RETRY_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
        await response.body?.cancel();
        await sleep(retryDelayMs(response, attempt));
        continue;
      }

      return response;
    }
  }

  /**
   * GETs a JSON endpoint and returns the parsed body; non-2xx responses throw. The payload type is not validated at runtime.
   *
   * @param path API path starting with /.
   * @param query Query parameters.
   * @returns Parsed JSON, or text for non-JSON responses.
   */
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

  /**
   * Downloads file content into memory, refusing files above the size limit. Atlassian redirects
   * attachment content to a signed media URL; fetch follows it and drops the Authorization header
   * cross-origin, which that URL does not need.
   *
   * @param path API path of the content endpoint.
   * @param label Name of the file used in error messages.
   * @returns File bytes and mime type.
   */
  async download(path: string, label: string): Promise<{ data: Buffer; mimeType: string }> {
    const response = await this.fetchWithRetry(new URL(`${this.baseUrl}${path}`), "*/*");

    if (!response.ok) {
      throw new Error(`Attachment download failed (${response.status} ${response.statusText}) for ${label}`);
    }

    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
      await response.body?.cancel();
      throw new Error(`Attachment ${label} is ${length} bytes, above the ${MAX_DOWNLOAD_BYTES}-byte limit`);
    }

    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType: (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim()
    };
  }
}

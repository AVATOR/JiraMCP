import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { basicAuthHeader } from "./auth.js";
import type { JsonValue } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
// Rate limiting and transient gateway errors; everything else is returned to the caller as-is.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const MAX_ERROR_BODY_CHARS = 1000;
// Very large files are refused up front, and cut off while streaming when the size was not announced.
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
   * Streams file content to disk, refusing files above the size limit. Atlassian redirects
   * attachment content to a signed media URL; fetch follows it and drops the Authorization header
   * cross-origin, which that URL does not need.
   *
   * @param path API path of the content endpoint.
   * @param label Name of the file used in error messages.
   * @param target File to write.
   * @param overwrite Replace an existing file; when false the download fails if the file exists.
   * @returns Number of bytes written and the mime type.
   */
  async downloadToFile(
    path: string,
    label: string,
    target: string,
    overwrite: boolean
  ): Promise<{ bytes: number; mimeType: string }> {
    const response = await this.fetchWithRetry(new URL(`${this.baseUrl}${path}`), "*/*");

    if (!response.ok) {
      throw new Error(`Attachment download failed (${response.status} ${response.statusText}) for ${label}`);
    }

    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
      await response.body?.cancel();
      throw new Error(`Attachment ${label} is ${length} bytes, above the ${MAX_DOWNLOAD_BYTES}-byte limit`);
    }

    const mimeType = (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
    let bytes = 0;

    // The announced length can be missing or wrong, so the limit is enforced on the stream too.
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        callback(
          bytes > MAX_DOWNLOAD_BYTES
            ? new Error(`Attachment ${label} is above the ${MAX_DOWNLOAD_BYTES}-byte limit`)
            : null,
          chunk
        );
      }
    });

    try {
      await pipeline(
        response.body ? Readable.fromWeb(response.body as WebReadableStream) : Readable.from([]),
        limiter,
        createWriteStream(target, { flags: overwrite ? "w" : "wx" })
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        throw new Error(`Refusing to overwrite existing file: ${target}`, { cause: error });
      }

      // Do not leave a truncated file behind.
      await unlink(target).catch(() => undefined);
      throw error;
    }

    return { bytes, mimeType };
  }
}

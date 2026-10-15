// Streamable HTTP transport: one shared server process for a team instead of stdio per machine.
// Stateless: every request gets its own MCP server and transport, so there are no sessions to
// track and nothing to clean up when a client disappears.

import { timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const MCP_PATH = "/mcp";
const HEALTH_PATH = "/healthz";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const RATE_WINDOW_MS = 60_000;
// Every request can fan out into several Jira calls and they all draw on one Atlassian quota.
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;

export type HttpServerOptions = {
  host: string;
  port: number;
  // Bearer token clients must send; required when listening on anything but loopback.
  token?: string;
  // Builds a fresh MCP server for one request.
  createServer: () => McpServer;
  // Requests per minute allowed from one client address; 0 disables the limit.
  rateLimitPerMinute?: number;
  // Clock, replaceable in tests.
  now?: () => number;
};

export type RunningHttpServer = {
  server: Server;
  port: number;
  close: () => Promise<void>;
};

/**
 * Whether the address only accepts connections from this machine.
 *
 * @param host Host or address the server binds to.
 * @returns True for loopback addresses.
 */
export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * Fixed-window request counter per client key.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Counts one request for the key.
   *
   * @param key Client identity, e.g. its remote address.
   * @returns 0 when the request is allowed, else the seconds until the window resets.
   */
  hit(key: string): number {
    if (this.limit <= 0) {
      return 0;
    }

    const now = this.now();
    const current = this.windows.get(key);

    if (!current || now - current.start >= RATE_WINDOW_MS) {
      // Drop expired windows so a stream of one-off clients cannot grow the map without bound.
      if (this.windows.size >= 1000) {
        for (const [other, window] of this.windows) {
          if (now - window.start >= RATE_WINDOW_MS) {
            this.windows.delete(other);
          }
        }
      }

      this.windows.set(key, { start: now, count: 1 });
      return 0;
    }

    current.count++;
    return current.count > this.limit ? Math.ceil((RATE_WINDOW_MS - (now - current.start)) / 1000) : 0;
  }
}

/**
 * Constant-time check of the Authorization header against the configured token.
 *
 * @param header Value of the Authorization header.
 * @param token Expected bearer token.
 * @returns True when the header carries the token.
 */
function hasToken(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.replace(/^Bearer\s+/i, "") ?? "");
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Sends a JSON-RPC style error body.
 *
 * @param res Response to write.
 * @param status HTTP status.
 * @param message Error message.
 * @param headers Extra response headers.
 */
function sendError(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/**
 * Reads and parses a JSON request body, refusing bodies above the limit.
 *
 * @param req Incoming request.
 * @returns Parsed JSON.
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("Request body too large"), { status: 413 });
    }
    chunks.push(chunk as Buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON body"), { status: 400 });
  }
}

/**
 * Handles one MCP request with a fresh server and transport.
 *
 * @param req Incoming request.
 * @param res Response to write.
 * @param options Server options.
 */
async function handleMcp(req: IncomingMessage, res: ServerResponse, options: HttpServerOptions) {
  if (req.method !== "POST") {
    // Stateless mode has no standalone SSE stream and no sessions to terminate.
    return sendError(res, 405, "Method not allowed", { Allow: "POST" });
  }

  const body = await readJson(req);
  const server = options.createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

/**
 * Starts the Streamable HTTP server.
 *
 * @param options Bind address, token and server factory.
 * @returns The running server, its port and a close function.
 */
export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  if (!options.token && !isLoopback(options.host)) {
    throw new Error(
      `Refusing to listen on ${options.host} without MCP_HTTP_TOKEN: the server answers with your Jira credentials.`
    );
  }

  const limiter = new RateLimiter(options.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE, options.now);

  const server = createHttpServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");

        if (url.pathname === HEALTH_PATH) {
          res.writeHead(200, { "Content-Type": "text/plain" });
          return void res.end("ok");
        }

        if (url.pathname !== MCP_PATH) {
          return sendError(res, 404, "Not found");
        }

        // A loopback server must not be reachable through a rebound DNS name.
        const hostName = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
        if (isLoopback(options.host) && hostName && !isLoopback(hostName)) {
          return sendError(res, 403, "Forbidden host");
        }

        if (options.token && !hasToken(req.headers.authorization, options.token)) {
          return sendError(res, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
        }

        // After authentication, so unauthenticated traffic cannot use up anyone's allowance.
        const retryAfter = limiter.hit(req.socket.remoteAddress ?? "unknown");
        if (retryAfter > 0) {
          return sendError(res, 429, "Too many requests", { "Retry-After": String(retryAfter) });
        }

        await handleMcp(req, res, options);
      } catch (error) {
        if (!res.headersSent) {
          const status = (error as { status?: number }).status ?? 500;
          sendError(res, status, status === 500 ? "Internal server error" : (error as Error).message);
        } else {
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });

  return {
    server,
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      })
  };
}

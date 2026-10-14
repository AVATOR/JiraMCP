// Shared harness for the MCP tool tests: a real MCP client talks to the server over an in-memory
// transport, and Jira/Confluence are replaced by a fake fetch serving canned JSON.
import { afterEach, beforeEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type JiraClientConfig } from "./server.js";

export const BASE_URL = "https://example.atlassian.net";

export type Route = (url: URL) => Response | Promise<Response>;

export const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) }
  });

// Routes are keyed by pathname; every request is recorded so tests can check URLs and headers.
function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: URL; init?: RequestInit }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const route = routes[url.pathname];
    return route ? route(url) : new Response("Not found", { status: 404, statusText: "Not Found" });
  }) as typeof fetch;

  return { fetchImpl, calls };
}

export let downloadDir: string;
let client: Client | undefined;

beforeEach(async () => {
  downloadDir = await mkdtemp(path.join(os.tmpdir(), "jira-mcp-test-"));
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await rm(downloadDir, { recursive: true, force: true });
});

export async function connect(routes: Record<string, Route>, config: Partial<JiraClientConfig> = {}) {
  const fake = fakeFetch(routes);
  const server = createServer(
    { baseUrl: `${BASE_URL}/`, email: "me@example.com", apiToken: "secret", customFields: [], ...config },
    { fetch: fake.fetchImpl, downloadDir }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls: fake.calls };
}

export async function call(c: Client, name: string, args: Record<string, unknown>) {
  const result: any = await c.callTool({ name, arguments: args });
  return { result, text: result.content?.[0]?.text as string };
}

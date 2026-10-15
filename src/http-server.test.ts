// The Streamable HTTP transport: a real MCP client over a real socket, with Jira faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { RateLimiter, startHttpServer, type RunningHttpServer } from "./http-server.js";
import { createCaches, createServer } from "./server.js";

const config = {
  baseUrl: "https://example.atlassian.net",
  email: "me@example.com",
  apiToken: "secret",
  customFields: []
};

async function start(options: { token?: string; host?: string; rateLimitPerMinute?: number } = {}) {
  const calls: URL[] = [];
  const fetchImpl = ((input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ key: "ABC-1", fields: { summary: "Over HTTP" } }), {
        headers: { "content-type": "application/json" }
      })
    );
  }) as typeof fetch;
  const caches = createCaches();
  const running: RunningHttpServer = await startHttpServer({
    host: options.host ?? "127.0.0.1",
    port: 0,
    token: options.token,
    rateLimitPerMinute: options.rateLimitPerMinute,
    createServer: () => createServer(config, { fetch: fetchImpl, caches, downloads: false })
  });
  return { running, calls, url: `http://127.0.0.1:${running.port}/mcp` };
}

test("serves tools over Streamable HTTP, without the download tools, and shares the cache between requests", async () => {
  const { running, calls, url } = await start();

  try {
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));

    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("jira_get_issue"));
    assert.ok(!names.includes("jira_download_attachment"));
    assert.ok(!names.includes("confluence_download_attachment"));

    for (let i = 0; i < 2; i++) {
      const result = (await client.callTool({ name: "jira_get_issue", arguments: { issueKey: "ABC-1" } })) as {
        content: { text: string }[];
      };
      assert.match(result.content[0].text, /Over HTTP/);
    }

    // Each request builds a new server, but the issue cache is shared: one Jira call for two reads.
    assert.equal(calls.filter((call) => call.pathname.includes("/issue/ABC-1")).length, 1);
    await client.close();
  } finally {
    await running.close();
  }
});

test("a token is required when configured and compared exactly", async () => {
  const { running, url } = await start({ token: "s3cret" });

  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

    const missing = await fetch(url, { method: "POST", headers, body });
    assert.equal(missing.status, 401);

    const wrong = await fetch(url, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body });
    assert.equal(wrong.status, 401);

    const ok = await fetch(url, { method: "POST", headers: { ...headers, authorization: "Bearer s3cret" }, body });
    assert.equal(ok.status, 200);
  } finally {
    await running.close();
  }
});

test("only POST /mcp is served: GET is 405, unknown paths 404, /healthz answers", async () => {
  const { running, url } = await start();

  try {
    assert.equal((await fetch(url)).status, 405);
    assert.equal((await fetch(url.replace("/mcp", "/other"))).status, 404);
    const health = await fetch(url.replace("/mcp", "/healthz"));
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok");
  } finally {
    await running.close();
  }
});

test("malformed bodies are 400 and a loopback server rejects foreign Host headers", async () => {
  const { running, url } = await start();

  try {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const bad = await fetch(url, { method: "POST", headers, body: "{not json" });
    assert.equal(bad.status, 400);

    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(url, { method: "POST", headers: { ...headers, host: "evil.example.com" } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end("{}");
    });
    assert.equal(status, 403);
  } finally {
    await running.close();
  }
});

test("refuses to listen beyond loopback without a token", async () => {
  await assert.rejects(
    startHttpServer({ host: "0.0.0.0", port: 0, createServer: () => createServer(config) }),
    /without MCP_HTTP_TOKEN/
  );
});

test("RateLimiter counts per key in fixed windows and 0 disables it", () => {
  let now = 0;
  const limiter = new RateLimiter(2, () => now);

  assert.equal(limiter.hit("a"), 0);
  assert.equal(limiter.hit("a"), 0);
  assert.equal(limiter.hit("a"), 60);
  assert.equal(limiter.hit("b"), 0);

  now = 45_000;
  assert.equal(limiter.hit("a"), 15);

  now = 60_000;
  assert.equal(limiter.hit("a"), 0);

  const off = new RateLimiter(0);
  for (let i = 0; i < 1000; i++) {
    assert.equal(off.hit("a"), 0);
  }
});

test("requests above the rate limit get 429 with Retry-After, the health check is exempt", async () => {
  const { running, url } = await start({ rateLimitPerMinute: 2 });

  try {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 200);
    assert.equal((await fetch(url, { method: "POST", headers, body })).status, 200);

    const limited = await fetch(url, { method: "POST", headers, body });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);

    assert.equal((await fetch(url.replace("/mcp", "/healthz"))).status, 200);
  } finally {
    await running.close();
  }
});

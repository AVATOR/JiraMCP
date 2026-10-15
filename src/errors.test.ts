// Error handling: Jira failures, retries, rate limits and argument validation through the MCP tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { call, connect, json } from "./test-support.js";

test("Jira errors surface as tool errors with status and a trimmed body", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/NOPE-1": () => new Response("x".repeat(5000), { status: 404, statusText: "Not Found" })
  });

  const { result, text } = await call(client, "jira_get_issue", { issueKey: "NOPE-1" });

  assert.equal(result.isError, true);
  assert.match(text, /Jira request failed \(404 Not Found\) for \/rest\/api\/3\/issue\/NOPE-1/);
  assert.ok(text.length < 1500, `error text is ${text.length} chars`);
});

test("rate-limited requests are retried", async () => {
  let attempts = 0;
  const { client, calls } = await connect({
    "/rest/api/3/issue/ABC-1": () =>
      ++attempts < 3
        ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
        : json({ key: "ABC-1", fields: { summary: "Finally" } })
  });

  const { text } = await call(client, "jira_get_issue", { issueKey: "ABC-1" });

  assert.match(text, /Finally/);
  assert.equal(calls.length, 3);
});

test("rate limiting gives up after the retry budget", async () => {
  const { client, calls } = await connect({
    "/rest/api/3/issue/ABC-1": () =>
      new Response("busy", { status: 503, statusText: "Service Unavailable", headers: { "retry-after": "0" } })
  });

  const { result } = await call(client, "jira_get_issue", { issueKey: "ABC-1" });

  assert.equal(result.isError, true);
  assert.equal(calls.length, 4);
});

test("invalid arguments are rejected before reaching Jira", async () => {
  const { client, calls } = await connect({});

  const response: any = await client
    .callTool({ name: "jira_search_issues", arguments: { jql: "x", maxResults: 1000 } })
    .catch((error) => ({ isError: true, content: [{ type: "text", text: String(error) }] }));

  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /maxResults/);
  assert.equal(calls.length, 0);
});

for (const status of [502, 504]) {
  test(`${status} responses are retried`, async () => {
    let attempts = 0;
    const { client, calls } = await connect({
      "/rest/api/3/issue/ABC-1": () =>
        ++attempts < 2
          ? new Response("bad gateway", { status, headers: { "retry-after": "0" } })
          : json({ key: "ABC-1", fields: { summary: "Recovered" } })
    });

    const { text } = await call(client, "jira_get_issue", { issueKey: "ABC-1" });

    assert.match(text, /Recovered/);
    assert.equal(calls.length, 2);
  });
}

test("a retry that would pass the request deadline is not waited for", async () => {
  const { AtlassianHttp } = await import("./http.js");
  let calls = 0;
  const fetchImpl = (() => {
    calls++;
    return Promise.resolve(new Response("busy", { status: 429, headers: { "retry-after": "50" } }));
  }) as typeof fetch;
  const http = new AtlassianHttp(
    { baseUrl: "https://example.atlassian.net", email: "a@b.c", apiToken: "t" },
    fetchImpl
  );

  const started = Date.now();
  await assert.rejects(http.get("/rest/api/3/myself"), /429/);

  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 5000);
});

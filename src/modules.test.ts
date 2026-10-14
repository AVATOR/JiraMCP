// Unit tests for the modules split out of server.ts; the MCP-level behaviour lives in server.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ReferenceCache } from "./cache.js";
import { AtlassianHttp } from "./http.js";
import { matchesQuery, toTextResult } from "./tools/shared.js";

test("ReferenceCache shares one in-flight load between concurrent callers", async () => {
  const cache = new ReferenceCache(60_000);
  let loads = 0;
  const load = () => Promise.resolve(++loads);

  const [a, b] = await Promise.all([cache.get("k", load), cache.get("k", load)]);

  assert.deepEqual([a, b, loads], [1, 1, 1]);
});

test("ReferenceCache reloads after the TTL and keeps keys apart", async (t) => {
  const now = t.mock.method(Date, "now", () => 1_000);
  const cache = new ReferenceCache(500);
  let loads = 0;

  assert.equal(await cache.get("a", () => Promise.resolve(++loads)), 1);
  assert.equal(await cache.get("b", () => Promise.resolve(++loads)), 2);
  assert.equal(await cache.get("a", () => Promise.resolve(++loads)), 1);

  now.mock.mockImplementation(() => 1_501);
  assert.equal(await cache.get("a", () => Promise.resolve(++loads)), 3);
});

test("ReferenceCache with TTL 0 never caches", async () => {
  const cache = new ReferenceCache(0);
  let loads = 0;

  await cache.get("k", () => Promise.resolve(++loads));
  await cache.get("k", () => Promise.resolve(++loads));

  assert.equal(loads, 2);
});

test("AtlassianHttp strips the trailing slash and returns plain text for non-JSON bodies", async () => {
  const seen: string[] = [];
  const fetchImpl = ((input: URL) => {
    seen.push(input.href);
    return Promise.resolve(new Response("plain body", { headers: { "content-type": "text/plain" } }));
  }) as unknown as typeof fetch;
  const http = new AtlassianHttp({ baseUrl: "https://x.atlassian.net/", email: "a@b.c", apiToken: "t" }, fetchImpl);

  assert.equal(await http.get<string>("/rest/api/3/thing", { a: "1" }), "plain body");
  assert.deepEqual(seen, ["https://x.atlassian.net/rest/api/3/thing?a=1"]);
});

test("AtlassianHttp only ever issues GET requests", async () => {
  const methods: (string | undefined)[] = [];
  const fetchImpl = ((_input: URL, init?: RequestInit) => {
    methods.push(init?.method);
    return Promise.resolve(new Response("{}", { headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
  const http = new AtlassianHttp({ baseUrl: "https://x.atlassian.net", email: "a@b.c", apiToken: "t" }, fetchImpl);

  await http.get("/a");
  await http.fetchWithRetry(new URL("https://x.atlassian.net/b"), "*/*");

  assert.deepEqual(methods, ["GET", "GET"]);
});

test("AtlassianHttp refuses POST to anything but the allowlisted read-only endpoints", async () => {
  const methods: (string | undefined)[] = [];
  const fetchImpl = ((_input: URL, init?: RequestInit) => {
    methods.push(init?.method);
    return Promise.resolve(new Response('{"count":3}', { headers: { "content-type": "application/json" } }));
  }) as unknown as typeof fetch;
  const http = new AtlassianHttp({ baseUrl: "https://x.atlassian.net", email: "a@b.c", apiToken: "t" }, fetchImpl);

  await assert.rejects(http.postRead("/rest/api/3/issue", { fields: {} }), /POST is not allowed/);
  assert.deepEqual(await http.postRead("/rest/api/3/search/approximate-count", { jql: "x" }), { count: 3 });
  assert.deepEqual(methods, ["POST"]);
});

test("matchesQuery is a case-insensitive substring match over all parts", () => {
  assert.equal(matchesQuery(undefined, "Anything"), true);
  assert.equal(matchesQuery("  ", "Anything"), true);
  assert.equal(matchesQuery("pro", "My Project", "MP"), true);
  assert.equal(matchesQuery("mp", "My Project", "MP"), true);
  assert.equal(matchesQuery("zzz", "My Project", undefined), false);
});

test("toTextResult adds custom field aliases to single issues and to search results", () => {
  const fields = [{ id: "customfield_1", alias: "impact" }];
  const issue = { key: "A-1", fields: { customfield_1: "High" }, renderedFields: { customfield_1: "<p>High</p>" } };
  const single = JSON.parse(toTextResult(structuredClone(issue), fields).content[0].text);
  const search = JSON.parse(toTextResult({ issues: [structuredClone(issue)] }, fields).content[0].text);

  assert.equal(single.fields.impact, "High");
  assert.equal(single.renderedFields.impact, "<p>High</p>");
  assert.equal(search.issues[0].fields.impact, "High");
});

test("toTextResult leaves payloads untouched without a custom field mapping", () => {
  const payload = { fields: { customfield_1: "x" } };
  assert.deepEqual(JSON.parse(toTextResult(payload).content[0].text), payload);
});

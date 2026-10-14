// End-to-end tests of the MCP tools: a real MCP client talks to the server over an in-memory
// transport, and Jira/Confluence are replaced by a fake fetch serving canned JSON.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type JiraClientConfig } from "./server.js";

const BASE_URL = "https://example.atlassian.net";

type Route = (url: URL) => Response | Promise<Response>;

const json = (body: unknown, init: ResponseInit = {}) =>
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

let downloadDir: string;
let client: Client | undefined;

beforeEach(async () => {
  downloadDir = await mkdtemp(path.join(os.tmpdir(), "jira-mcp-test-"));
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await rm(downloadDir, { recursive: true, force: true });
});

async function connect(routes: Record<string, Route>, config: Partial<JiraClientConfig> = {}) {
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

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const result: any = await c.callTool({ name, arguments: args });
  return { result, text: result.content?.[0]?.text as string };
}

test("lists every tool with an input schema", async () => {
  const { client } = await connect({});
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "confluence_get_page",
    "confluence_get_space_pages",
    "confluence_list_spaces",
    "confluence_search_pages",
    "jira_download_attachment",
    "jira_find_users",
    "jira_get_comments",
    "jira_get_current_user",
    "jira_get_issue",
    "jira_get_project_issues",
    "jira_list_attachments",
    "jira_list_fields",
    "jira_list_projects",
    "jira_search_issues"
  ]);

  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations?.openWorldHint, true, tool.name);
  }
});

test("custom fields are announced in the jira_get_issue description", async () => {
  const { client } = await connect({}, { customFields: [{ id: "customfield_1", alias: "impact" }] });
  const { tools } = await client.listTools();
  const getIssue = tools.find((tool) => tool.name === "jira_get_issue")!;
  assert.match(getIssue.description!, /impact \(customfield_1\)/);
});

test("jira_get_issue sends a GET with basic auth and returns Markdown", async () => {
  const { client, calls } = await connect(
    {
      "/rest/api/3/issue/ABC-1": () => json({ key: "ABC-1", fields: { summary: "Hello", customfield_1: "Yes" } })
    },
    { customFields: [{ id: "customfield_1", alias: "impact" }] }
  );

  const { result, text } = await call(client, "jira_get_issue", { issueKey: "ABC-1" });

  assert.notEqual(result.isError, true);
  assert.match(text, /^# ABC-1: Hello/);
  assert.match(text, /## impact \(customfield_1\)\nYes/);

  const [request] = calls;
  assert.equal(request.init?.method, "GET");
  assert.equal(
    (request.init?.headers as Record<string, string>).Authorization,
    `Basic ${Buffer.from("me@example.com:secret").toString("base64")}`
  );
  assert.ok(request.url.searchParams.get("fields")!.split(",").includes("customfield_1"));
  assert.equal(request.url.searchParams.get("expand"), null);
});

test("jira_get_issue raw returns JSON with rendered fields and aliases", async () => {
  const { client, calls } = await connect(
    { "/rest/api/3/issue/ABC-1": () => json({ key: "ABC-1", fields: { customfield_1: "Yes" } }) },
    { customFields: [{ id: "customfield_1", alias: "impact" }] }
  );

  const { text } = await call(client, "jira_get_issue", { issueKey: "ABC-1", raw: true });

  assert.equal(JSON.parse(text).fields.impact, "Yes");
  assert.equal(calls[0].url.searchParams.get("expand"), "renderedFields");
});

test("jira_search_issues passes JQL, page size and token through", async () => {
  const { client, calls } = await connect({
    "/rest/api/3/search/jql": () =>
      json({ issues: [{ key: "ABC-1", fields: { summary: "One" } }], nextPageToken: "next", isLast: false })
  });

  const { text } = await call(client, "jira_search_issues", {
    jql: "assignee = currentUser()",
    maxResults: 5,
    nextPageToken: "prev"
  });

  assert.match(text, /\| ABC-1 \| One \|/);
  assert.match(text, /nextPageToken: next/);
  const params = calls[0].url.searchParams;
  assert.equal(params.get("jql"), "assignee = currentUser()");
  assert.equal(params.get("maxResults"), "5");
  assert.equal(params.get("nextPageToken"), "prev");
});

test("jira_get_project_issues quotes the project key and falls back to the default project", async () => {
  const routes = { "/rest/api/3/search/jql": () => json({ issues: [] }) };

  const explicit = await connect(routes);
  await call(explicit.client, "jira_get_project_issues", { projectKey: 'A"B' });
  assert.equal(explicit.calls[0].url.searchParams.get("jql"), 'project = "A\\"B" ORDER BY updated DESC');
  await explicit.client.close();

  const fallback = await connect(routes, { defaultProject: "DEF" });
  await call(fallback.client, "jira_get_project_issues", {});
  assert.equal(fallback.calls[0].url.searchParams.get("jql"), 'project = "DEF" ORDER BY updated DESC');
});

test("jira_get_project_issues without any project is an error", async () => {
  const { client, calls } = await connect({});
  const { result, text } = await call(client, "jira_get_project_issues", {});

  assert.equal(result.isError, true);
  assert.match(text, /projectKey is required/);
  assert.equal(calls.length, 0);
});

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

test("jira_get_comments returns the newest comments by default", async () => {
  const { client, calls } = await connect({
    "/rest/api/3/issue/ABC-1/comment": () =>
      json({
        total: 2,
        comments: [
          { id: "2", created: "2026-02-01T00:00:00", author: { displayName: "B" }, body: "second" },
          { id: "1", created: "2026-01-01T00:00:00", author: { displayName: "A" }, body: "first" }
        ]
      })
  });

  const { text } = await call(client, "jira_get_comments", { issueKey: "ABC-1" });

  assert.match(text, /^ABC-1 — showing 2 of 2 comments \(newest first\)/);
  assert.ok(text.indexOf("id 2") < text.indexOf("id 1"));
  const params = calls[0].url.searchParams;
  assert.equal(params.get("orderBy"), "-created");
  assert.equal(params.get("maxResults"), "5");
});

test("jira_get_comments with since walks pages until older comments appear", async () => {
  const pages: Record<string, unknown> = {
    "0": {
      total: 150,
      comments: Array.from({ length: 100 }, (_, i) => ({
        id: String(200 - i),
        created: "2026-03-01T00:00:00",
        body: "new"
      }))
    },
    "100": {
      total: 150,
      comments: [
        { id: "100", created: "2026-02-15T00:00:00", body: "still new" },
        { id: "99", created: "2025-12-31T00:00:00", body: "old" }
      ]
    }
  };
  const { client, calls } = await connect({
    "/rest/api/3/issue/ABC-1/comment": (url) => json(pages[url.searchParams.get("startAt")!])
  });

  const { text } = await call(client, "jira_get_comments", {
    issueKey: "ABC-1",
    since: "2026-01-01",
    limit: 3,
    order: "asc"
  });

  assert.equal(calls.length, 2);
  assert.match(text, /showing 3 of 101 comments \(oldest first, since 2026-01-01\)/);
  assert.match(text, /id 100\n/);
  assert.doesNotMatch(text, /id 99\n/);
});

test("jira_get_comments rejects a bad since date", async () => {
  const { client } = await connect({});
  const { result, text } = await call(client, "jira_get_comments", { issueKey: "ABC-1", since: "not a date" });

  assert.equal(result.isError, true);
  assert.match(text, /Invalid since date/);
});

test("jira_get_comments with commentId returns that comment in full", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1/comment/42": () =>
      json({ id: "42", created: "2026-01-01T00:00:00", author: { displayName: "A" }, body: "y".repeat(5000) })
  });

  const { text } = await call(client, "jira_get_comments", { issueKey: "ABC-1", commentId: "42" });

  assert.match(text, /^ABC-1\n\n### .* · id 42/);
  assert.doesNotMatch(text, /truncated/);
});

test("jira_list_attachments renders the attachment table", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1": () =>
      json({ fields: { attachment: [{ id: "10", filename: "shot.png", mimeType: "image/png", size: 10 }] } })
  });

  const { text } = await call(client, "jira_list_attachments", { issueKey: "ABC-1" });
  assert.match(text, /## Attachments \(1\) — ABC-1/);
  assert.match(text, /\| 10 \| shot.png \| image\/png \| 10 B \|/);
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function attachmentRoutes(meta: Record<string, unknown>) {
  return {
    "/rest/api/3/attachment/10": () =>
      json({ id: "10", filename: "my shot.png", mimeType: "image/png", size: PNG.length, ...meta }),
    "/rest/api/3/attachment/content/10": () =>
      new Response(PNG, { headers: { "content-type": "image/png", "content-length": String(PNG.length) } })
  };
}

test("jira_download_attachment saves the file and inlines images", async () => {
  const { client } = await connect(attachmentRoutes({}));

  const { result, text } = await call(client, "jira_download_attachment", { attachmentId: "10" });
  const target = path.join(downloadDir, "10-my_shot.png");

  assert.match(text, /Saved my shot.png \(image\/png, 8 bytes\)/);
  assert.deepEqual(await readFile(target), PNG);
  assert.equal(result.content[1].type, "image");
  assert.equal(result.content[1].data, PNG.toString("base64"));
});

test("jira_download_attachment with inline:false returns only text", async () => {
  const { client } = await connect(attachmentRoutes({}));
  const { result } = await call(client, "jira_download_attachment", { attachmentId: "10", inline: false });
  assert.equal(result.content.length, 1);
});

test("jira_download_attachment never overwrites an explicit output file", async () => {
  const { client } = await connect(attachmentRoutes({}));
  const existing = path.join(downloadDir, "keep.txt");
  await writeFile(existing, "precious");

  const { result, text } = await call(client, "jira_download_attachment", { attachmentId: "10", outputPath: existing });

  assert.equal(result.isError, true);
  assert.match(text, /Refusing to overwrite/);
  assert.equal(await readFile(existing, "utf8"), "precious");
});

test("jira_download_attachment refuses oversized files before downloading", async () => {
  const { client, calls } = await connect(attachmentRoutes({ size: 200 * 1024 * 1024 }));

  const { result, text } = await call(client, "jira_download_attachment", { attachmentId: "10" });

  assert.equal(result.isError, true);
  assert.match(text, /above the .*-byte limit/);
  assert.ok(!calls.some((entry) => entry.url.pathname.includes("/content/")));
});

test("confluence_get_page converts storage format to Markdown", async () => {
  const { client, calls } = await connect({
    "/wiki/api/v2/pages/123": () =>
      json({
        id: "123",
        title: "Runbook",
        version: { number: 4, createdAt: "2026-01-01T10:00:00" },
        body: { storage: { value: "<h1>Steps</h1><p>Do <strong>this</strong></p>" } },
        _links: { webui: "/spaces/MS/pages/123" }
      })
  });

  const { text } = await call(client, "confluence_get_page", { pageId: "123" });

  assert.match(text, /^# Runbook/);
  assert.match(text, /- \*\*Url:\*\* https:\/\/example.atlassian.net\/wiki\/spaces\/MS\/pages\/123/);
  assert.match(text, /# Steps\n\nDo \*\*this\*\*/);
  assert.equal(calls[0].url.searchParams.get("body-format"), "storage");
});

test("confluence_search_pages builds a full-text CQL query", async () => {
  const { client, calls } = await connect({
    "/wiki/rest/api/search": () => json({ totalSize: 0, results: [] })
  });

  const { text } = await call(client, "confluence_search_pages", { query: 'release "notes"' });

  assert.match(text, /^0 of 0 pages/);
  const params = calls[0].url.searchParams;
  assert.equal(params.get("cql"), 'type = page AND text ~ "release \\"notes\\"" ORDER BY lastmodified DESC');
  assert.equal(params.get("limit"), "25");
});

test("confluence_search_pages can restrict to a space and to titles", async () => {
  const { client, calls } = await connect({
    "/wiki/rest/api/search": () => json({ totalSize: 0, results: [] })
  });

  await call(client, "confluence_search_pages", { query: "plan", spaceKey: "MS", titleOnly: true });

  assert.equal(
    calls[0].url.searchParams.get("cql"),
    'type = page AND title ~ "plan" AND space = "MS" ORDER BY lastmodified DESC'
  );
});

test("Markdown results flag Jira/Confluence content as untrusted, raw JSON stays parseable", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1": () => json({ key: "ABC-1", fields: { summary: "Hello" } })
  });

  const markdown = await call(client, "jira_get_issue", { issueKey: "ABC-1" });
  assert.match(markdown.text, /untrusted data/);

  const raw = await call(client, "jira_get_issue", { issueKey: "ABC-1", raw: true });
  assert.equal(JSON.parse(raw.text).key, "ABC-1");
});

test("jira_search_issues and jira_get_project_issues support raw", async () => {
  const { client } = await connect({
    "/rest/api/3/search/jql": () => json({ issues: [{ key: "ABC-1", fields: {} }] })
  });

  for (const [name, args] of [
    ["jira_search_issues", { jql: "project = ABC" }],
    ["jira_get_project_issues", { projectKey: "ABC" }]
  ] as const) {
    const { text } = await call(client, name, { ...args, raw: true });
    assert.equal(JSON.parse(text).issues[0].key, "ABC-1", name);
  }
});

test("jira_list_fields filters by name and custom flag", async () => {
  const { client } = await connect({
    "/rest/api/3/field": () =>
      json([
        { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
        { id: "customfield_10145", name: "Requirements", custom: true, schema: { type: "string" } },
        { id: "customfield_10170", name: "Discovery questions", custom: true, schema: { type: "string" } }
      ])
  });

  const byName = await call(client, "jira_list_fields", { query: "REQUIRE" });
  assert.match(byName.text, /^1 fields/);
  assert.match(byName.text, /\| customfield_10145 \| Requirements \| string \| yes \|/);

  const custom = await call(client, "jira_list_fields", { customOnly: true });
  assert.match(custom.text, /^2 fields/);
  assert.doesNotMatch(custom.text, /Summary/);
});

test("confluence_get_space_pages resolves the space key to its id", async () => {
  const { client, calls } = await connect({
    "/wiki/api/v2/spaces": () => json({ results: [{ id: "77", key: "MS" }] }),
    "/wiki/api/v2/spaces/77/pages": () => json({ results: [{ id: "1", title: "Home" }] })
  });

  const { text } = await call(client, "confluence_get_space_pages", { spaceKey: "MS", cursor: "c1" });

  assert.match(text, /^MS — 1 pages/);
  assert.equal(calls[0].url.searchParams.get("keys"), "MS");
  assert.equal(calls[1].url.searchParams.get("cursor"), "c1");
  assert.equal(calls[1].url.searchParams.get("limit"), "50");
});

test("confluence_get_space_pages reports an unknown space", async () => {
  const { client } = await connect({ "/wiki/api/v2/spaces": () => json({ results: [] }) });
  const { result, text } = await call(client, "confluence_get_space_pages", { spaceKey: "NOPE" });

  assert.equal(result.isError, true);
  assert.match(text, /Confluence space not found: NOPE/);
});

test("reference listings are cached between calls", async () => {
  const { client, calls } = await connect({
    "/rest/api/3/field": () => json([{ id: "summary", name: "Summary", custom: false }]),
    "/rest/api/3/myself": () => json({ accountId: "u1", displayName: "Me" })
  });

  await call(client, "jira_list_fields", {});
  await call(client, "jira_list_fields", { query: "summ" });
  await call(client, "jira_get_current_user", {});
  await call(client, "jira_get_current_user", {});

  assert.equal(calls.filter((entry) => entry.url.pathname === "/rest/api/3/field").length, 1);
  assert.equal(calls.filter((entry) => entry.url.pathname === "/rest/api/3/myself").length, 1);
});

test("a failed listing is not cached", async () => {
  let attempts = 0;
  const { client } = await connect({
    "/rest/api/3/field": () =>
      ++attempts === 1 ? new Response("boom", { status: 500, statusText: "Server Error" }) : json([])
  });

  const first = await call(client, "jira_list_fields", {});
  const second = await call(client, "jira_list_fields", {});

  assert.equal(first.result.isError, true);
  assert.notEqual(second.result.isError, true);
});

test("jira_list_projects walks every page and filters by name or key", async () => {
  const { client, calls } = await connect({
    "/rest/api/3/project/search": (url) =>
      url.searchParams.get("startAt") === "0"
        ? json({
            isLast: false,
            values: [{ key: "ABC", name: "Alpha", projectTypeKey: "software", style: "next-gen" }]
          })
        : json({ isLast: true, values: [{ key: "XYZ", name: "Beta Team", projectTypeKey: "business" }] })
  });

  const all = await call(client, "jira_list_projects", {});
  assert.match(all.text, /^2 projects/);
  assert.match(all.text, /\| ABC \| Alpha \| software \| next-gen \|/);

  const filtered = await call(client, "jira_list_projects", { query: "beta" });
  assert.match(filtered.text, /^1 projects/);
  assert.doesNotMatch(filtered.text, /Alpha/);

  const limited = await call(client, "jira_list_projects", { limit: 1 });
  assert.match(limited.text, /^1 of 2 projects/);
  assert.equal(calls.length, 2, "second page fetched once, the rest served from the cache");
});

test("jira_get_current_user and jira_find_users show account ids", async () => {
  const { client, calls } = await connect({
    "/rest/api/3/myself": () => json({ accountId: "u1", displayName: "Me", emailAddress: "me@example.com" }),
    "/rest/api/3/user/search": () =>
      json([{ accountId: "u2", displayName: "Anna", emailAddress: "anna@example.com", active: true }])
  });

  const me = await call(client, "jira_get_current_user", {});
  assert.match(me.text, /\*\*Account id:\*\* u1/);

  const found = await call(client, "jira_find_users", { query: "ann", limit: 5 });
  assert.match(found.text, /\| u2 \| Anna \| anna@example.com \| yes \|/);
  const search = calls.find((entry) => entry.url.pathname === "/rest/api/3/user/search")!;
  assert.equal(search.url.searchParams.get("query"), "ann");
  assert.equal(search.url.searchParams.get("maxResults"), "5");
});

test("confluence_list_spaces follows cursors and filters", async () => {
  const { client } = await connect({
    "/wiki/api/v2/spaces": (url) =>
      url.searchParams.get("cursor")
        ? json({ results: [{ id: "2", key: "~me", name: "My space", type: "personal", status: "current" }] })
        : json({
            results: [{ id: "1", key: "MS", name: "Main", type: "global", status: "current" }],
            _links: { next: "/wiki/api/v2/spaces?cursor=c2&limit=250" }
          })
  });

  const all = await call(client, "confluence_list_spaces", {});
  assert.match(all.text, /^2 spaces/);

  const personal = await call(client, "confluence_list_spaces", { type: "personal" });
  assert.match(personal.text, /^1 spaces/);
  assert.match(personal.text, /~me/);
  assert.doesNotMatch(personal.text, /Main/);
});

test("jira_search_issues fields adds extra columns and requests the fields from Jira", async () => {
  const { client, calls } = await connect(
    {
      "/rest/api/3/search/jql": () =>
        json({
          issues: [
            {
              key: "ABC-1",
              fields: {
                summary: "One",
                labels: ["a", "b"],
                customfield_7: { value: "High" },
                description: "x".repeat(300)
              }
            }
          ]
        })
    },
    { customFields: [{ id: "customfield_7", alias: "impact" }] }
  );

  const { text } = await call(client, "jira_search_issues", {
    jql: "project = ABC",
    fields: ["labels", "customfield_7", "description"]
  });

  assert.match(text, /\| Updated \| labels \| impact \| description \|/);
  assert.match(text, /\| ABC-1 \| One \|.*\| a, b \| High \| x{200}… \|/);
  assert.match(calls[0].url.searchParams.get("fields") ?? "", /^summary,.*,updated,labels,customfield_7,description$/);
});

test("confluence_search_pages escapes CQL operator characters", async () => {
  const { client, calls } = await connect({
    "/wiki/rest/api/search": () => json({ totalSize: 0, results: [] })
  });

  await call(client, "confluence_search_pages", { query: "C++ (v2)? a-b" });

  assert.equal(
    calls[0].url.searchParams.get("cql"),
    'type = page AND text ~ "C\\\\+\\\\+ \\\\(v2\\\\)\\\\? a\\\\-b" ORDER BY lastmodified DESC'
  );
});

test("confluence_search_pages passes the cursor through and shows the next one", async () => {
  const { client, calls } = await connect({
    "/wiki/rest/api/search": () =>
      json({ totalSize: 40, results: [], _links: { next: "/rest/api/search?cql=x&limit=1&cursor=abc%3D&start=1" } })
  });

  const { text } = await call(client, "confluence_search_pages", { query: "plan", cursor: "prev" });

  assert.equal(calls[0].url.searchParams.get("cursor"), "prev");
  assert.match(text, /cursor: abc=/);
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

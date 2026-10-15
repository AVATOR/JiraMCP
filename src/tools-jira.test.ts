// End-to-end tests of the Jira tools (and the cross-cutting result format) through an in-memory MCP client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { call, connect, downloadDir, json } from "./test-support.js";

test("lists every tool with an input schema", async () => {
  const { client } = await connect({});
  const { tools } = await client.listTools();

  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "confluence_download_attachment",
    "confluence_find_pages_for_issue",
    "confluence_get_page",
    "confluence_get_page_children",
    "confluence_get_page_comments",
    "confluence_get_page_issues",
    "confluence_get_page_versions",
    "confluence_get_space_pages",
    "confluence_list_attachments",
    "confluence_list_spaces",
    "confluence_search_pages",
    "jira_download_attachment",
    "jira_find_users",
    "jira_get_changelog",
    "jira_get_comments",
    "jira_get_current_user",
    "jira_get_issue",
    "jira_get_project",
    "jira_get_project_issues",
    "jira_get_remote_links",
    "jira_get_sprint_issues",
    "jira_get_worklogs",
    "jira_list_attachments",
    "jira_list_boards",
    "jira_list_fields",
    "jira_list_filters",
    "jira_list_metadata",
    "jira_list_projects",
    "jira_list_sprints",
    "jira_list_transitions",
    "jira_run_filter",
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

test("jira_search_issues includeTotal adds the approximate count via a read-only POST", async () => {
  const { client, calls } = await connect({
    "/rest/api/3/search/jql": () => json({ issues: [{ key: "ABC-1", fields: { summary: "One" } }], isLast: true }),
    "/rest/api/3/search/approximate-count": () => json({ count: 42 })
  });

  const without = await call(client, "jira_search_issues", { jql: "project = ABC" });
  assert.match(without.text, /^1 issues/);
  assert.ok(!calls.some((entry) => entry.url.pathname.endsWith("approximate-count")));

  const { text, result } = await call(client, "jira_search_issues", { jql: "project = ABC", includeTotal: true });
  assert.match(text, /^1 of ~42 issues/);

  const countCall = calls.find((entry) => entry.url.pathname.endsWith("approximate-count"));
  assert.deepEqual(JSON.parse(countCall?.init?.body as string), { jql: "project = ABC" });
  assert.equal(countCall?.init?.method, "POST");
  assert.equal(result.isError, undefined);

  const raw = await call(client, "jira_search_issues", { jql: "project = ABC", includeTotal: true, raw: true });
  assert.equal(JSON.parse(raw.text).approximateTotal, 42);
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

test("jira_download_attachment refuses an output path outside the download directory", async () => {
  const { client, calls } = await connect(attachmentRoutes({}));
  const outside = path.join(os.tmpdir(), `jira-mcp-outside-${process.pid}.txt`);

  for (const outputPath of [outside, "../escape.txt", "/etc/jira-mcp-test"]) {
    const { result, text } = await call(client, "jira_download_attachment", { attachmentId: "10", outputPath });
    assert.equal(result.isError, true);
    assert.match(text, /outputPath must be inside/);
  }

  assert.ok(!calls.some((entry) => entry.url.pathname.includes("/content/")));
});

test("jira_download_attachment resolves a relative output path inside the download directory", async () => {
  const { client } = await connect(attachmentRoutes({}));

  const { result } = await call(client, "jira_download_attachment", {
    attachmentId: "10",
    outputPath: "nested/shot.png",
    inline: false
  });

  assert.notEqual(result.isError, true);
  assert.deepEqual(await readFile(path.join(downloadDir, "nested", "shot.png")), PNG);
});

test("jira_download_attachment accepts directories listed in JIRA_ATTACHMENT_ROOTS", async (t) => {
  const extra = await mkdtemp(path.join(os.tmpdir(), "jira-mcp-root-"));
  process.env.JIRA_ATTACHMENT_ROOTS = extra;
  t.after(async () => {
    delete process.env.JIRA_ATTACHMENT_ROOTS;
    await rm(extra, { recursive: true, force: true });
  });
  const { client } = await connect(attachmentRoutes({}));

  const { result } = await call(client, "jira_download_attachment", {
    attachmentId: "10",
    outputPath: extra,
    inline: false
  });

  assert.notEqual(result.isError, true);
  assert.deepEqual(await readFile(path.join(extra, "10-my_shot.png")), PNG);
});

test("structured results carry the untrusted mark when they hold third-party text", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1": () => json({ key: "ABC-1", fields: { summary: "Hello" } }),
    "/rest/api/3/field": () => json([{ id: "summary", name: "Summary" }])
  });

  const issue = await call(client, "jira_get_issue", { issueKey: "ABC-1" });
  assert.equal(issue.result.structuredContent.untrusted, true);

  const fields = await call(client, "jira_list_fields", {});
  assert.equal(fields.result.structuredContent.untrusted, undefined);
});

test("jira_download_attachment refuses oversized files before downloading", async () => {
  const { client, calls } = await connect(attachmentRoutes({ size: 200 * 1024 * 1024 }));

  const { result, text } = await call(client, "jira_download_attachment", { attachmentId: "10" });

  assert.equal(result.isError, true);
  assert.match(text, /above the .*-byte limit/);
  assert.ok(!calls.some((entry) => entry.url.pathname.includes("/content/")));
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

test("jira_get_changelog lists changes newest first and filters by field", async () => {
  const { client, calls } = await connect({
    "/rest/api/3/issue/ABC-1/changelog": () =>
      json({
        isLast: true,
        total: 2,
        values: [
          {
            id: "1",
            created: "2026-09-01T10:00:00.000+0000",
            author: { displayName: "Ann" },
            items: [{ field: "status", fromString: "To Do", toString: "In Progress" }]
          },
          {
            id: "2",
            created: "2026-09-02T10:00:00.000+0000",
            author: { displayName: "Bob" },
            items: [
              { field: "assignee", fromString: null, toString: "Bob" },
              { field: "status", fromString: "In Progress", toString: "Done" }
            ]
          }
        ]
      })
  });

  const all = await call(client, "jira_get_changelog", { issueKey: "ABC-1" });
  assert.match(all.text, /showing 2 of 2 changes \(newest first\)/);
  assert.ok(all.text.indexOf("Bob") < all.text.indexOf("Ann"), "newest change comes first");
  assert.match(all.text, /- assignee: ∅ → Bob/);

  const status = await call(client, "jira_get_changelog", { issueKey: "ABC-1", field: "Status", limit: 1 });
  assert.match(status.text, /showing 1 of 2 changes \(newest first, field "Status"\)/);
  assert.match(status.text, /In Progress → Done/);
  assert.doesNotMatch(status.text, /assignee/);
  assert.equal(calls[0].url.searchParams.get("startAt"), "0");
});

test("jira_get_worklogs sums the logged time", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1/worklog": () =>
      json({
        total: 2,
        worklogs: [
          {
            started: "2026-09-01T09:00:00.000+0000",
            author: { displayName: "Ann" },
            timeSpent: "1h",
            timeSpentSeconds: 3600
          },
          {
            started: "2026-09-02T09:00:00.000+0000",
            author: { displayName: "Bob" },
            timeSpent: "30m",
            timeSpentSeconds: 1800,
            comment: {
              type: "doc",
              version: 1,
              content: [{ type: "paragraph", content: [{ type: "text", text: "review" }] }]
            }
          }
        ]
      })
  });

  const { text } = await call(client, "jira_get_worklogs", { issueKey: "ABC-1" });

  assert.match(text, /2 worklogs, 1.5 h in total/);
  assert.match(text, /\| 2026-09-02 09:00 \| Bob \| 30m \| review \|/);
});

test("jira_list_transitions shows target statuses", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1/transitions": () =>
      json({ transitions: [{ id: "31", name: "Start", to: { name: "In Progress" } }] })
  });

  const { text } = await call(client, "jira_list_transitions", { issueKey: "ABC-1" });

  assert.match(text, /1 available transitions/);
  assert.match(text, /\| 31 \| Start \| In Progress \|/);
});

test("jira_list_metadata lists and filters statuses, issue types and priorities", async () => {
  const { client, calls } = await connect({
    "/rest/api/3/status": () =>
      json([
        { id: "1", name: "To Do", statusCategory: { name: "To Do" } },
        { id: "2", name: "Done", statusCategory: { name: "Done" } }
      ]),
    "/rest/api/3/issuetype": () => json([{ id: "10", name: "Sub-task", subtask: true, description: "Part of a task" }]),
    "/rest/api/3/priority": () => json([{ id: "3", name: "High" }])
  });

  const statuses = await call(client, "jira_list_metadata", { kind: "statuses", query: "do" });
  assert.match(statuses.text, /2 statuses/);
  const filtered = await call(client, "jira_list_metadata", { kind: "statuses", query: "done" });
  assert.match(filtered.text, /1 statuses/);
  assert.doesNotMatch(filtered.text, /To Do/);
  assert.equal(calls.filter((entry) => entry.url.pathname === "/rest/api/3/status").length, 1, "cached");

  const types = await call(client, "jira_list_metadata", { kind: "issueTypes" });
  assert.match(types.text, /\| 10 \| Sub-task \| subtask \| Part of a task \|/);
  const priorities = await call(client, "jira_list_metadata", { kind: "priorities" });
  assert.match(priorities.text, /\| 3 \| High \|/);
});

test("jira_get_project shows issue types, components and versions", async () => {
  const { client } = await connect({
    "/rest/api/3/project/ABC": () =>
      json({
        key: "ABC",
        name: "Alpha",
        lead: { displayName: "Ann" },
        issueTypes: [{ name: "Bug" }, { name: "Story" }],
        components: [{ name: "API", lead: { displayName: "Bob" } }],
        versions: [
          { name: "1.0", released: true, releaseDate: "2026-06-01" },
          { name: "2.0", released: false }
        ]
      })
  });

  const { text } = await call(client, "jira_get_project", { projectKey: "ABC" });

  assert.match(text, /# ABC: Alpha/);
  assert.match(text, /Bug, Story/);
  assert.match(text, /- API \(lead: Bob\)/);
  assert.match(text, /- 1.0 \[released, 2026-06-01\]/);
  assert.match(text, /- 2.0 \[unreleased\]/);
});

test("jira_get_project falls back to the default project and fails without one", async () => {
  const withDefault = await connect(
    { "/rest/api/3/project/DEF": () => json({ key: "DEF", name: "Default" }) },
    { defaultProject: "DEF" }
  );
  assert.match((await call(withDefault.client, "jira_get_project", {})).text, /# DEF: Default/);

  await withDefault.client.close();
  const without = await connect({});
  const { result } = await call(without.client, "jira_get_project", {});
  assert.equal(result.isError, true);
});

test("jira_list_filters searches by name and jira_run_filter runs the filter's JQL", async () => {
  const { client, calls } = await connect({
    "/rest/api/3/filter/search": () =>
      json({ values: [{ id: "7", name: "My bugs", jql: "type = Bug", owner: { displayName: "Ann" } }] }),
    "/rest/api/3/filter/7": () => json({ id: "7", name: "My bugs", jql: "type = Bug" }),
    "/rest/api/3/search/jql": () => json({ issues: [{ key: "ABC-1", fields: { summary: "Crash" } }] })
  });

  const list = await call(client, "jira_list_filters", { query: "bugs" });
  assert.match(list.text, /\| 7 \| My bugs \| Ann \| type = Bug \|/);
  assert.equal(calls[0].url.searchParams.get("filterName"), "bugs");

  const run = await call(client, "jira_run_filter", { filterId: "7" });
  assert.match(run.text, /Filter My bugs: type = Bug/);
  assert.match(run.text, /\| ABC-1 \| Crash \|/);
  assert.equal(calls.at(-1)?.url.searchParams.get("jql"), "type = Bug");
});

test("jira_get_remote_links lists link titles and targets", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1/remotelink": () =>
      json([
        {
          relationship: "mentioned in",
          application: { name: "GitHub" },
          object: { url: "https://github.com/o/r/pull/1", title: "PR 1" }
        }
      ])
  });

  const { text } = await call(client, "jira_get_remote_links", { issueKey: "ABC-1" });

  assert.match(text, /1 remote links/);
  assert.match(text, /- mentioned in: \[PR 1\]\(https:\/\/github.com\/o\/r\/pull\/1\) \(GitHub\)/);
});

test("Agile tools list boards, sprints and sprint issues with paging", async () => {
  const { client, calls } = await connect({
    "/rest/agile/1.0/board": () =>
      json({ values: [{ id: 3, name: "Alpha board", type: "scrum", location: { projectKey: "ABC" } }] }),
    "/rest/agile/1.0/board/3/sprint": () =>
      json({
        isLast: true,
        values: [{ id: 9, name: "Sprint 9", state: "active", startDate: "2026-09-01T00:00:00.000Z", goal: "Ship" }]
      }),
    "/rest/agile/1.0/sprint/9/issue": () =>
      json({ startAt: 0, maxResults: 1, total: 3, issues: [{ key: "ABC-1", fields: { summary: "One" } }] })
  });

  const boards = await call(client, "jira_list_boards", { projectKey: "ABC" });
  assert.match(boards.text, /\| 3 \| Alpha board \| scrum \| ABC \|/);
  assert.equal(calls[0].url.searchParams.get("projectKeyOrId"), "ABC");

  const sprints = await call(client, "jira_list_sprints", { boardId: "3", state: "active" });
  assert.match(sprints.text, /\| 9 \| Sprint 9 \| active \| 2026-09-01 00:00 \| — \| Ship \|/);
  assert.equal(calls[1].url.searchParams.get("state"), "active");

  const issues = await call(client, "jira_get_sprint_issues", { sprintId: "9", limit: 1 });
  assert.match(issues.text, /\| ABC-1 \| One \|/);
  assert.match(issues.text, /nextStartAt: 1/);
});

test("jira_download_attachment stops a stream that outgrows the limit and leaves no partial file", async () => {
  const chunk = Buffer.alloc(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
      sent += 1;
    }
  });
  const { client } = await connect({
    "/rest/api/3/attachment/10": () => json({ id: "10", filename: "big.bin", mimeType: "application/octet-stream" }),
    // No content-length, so only the streaming limit can catch this.
    "/rest/api/3/attachment/content/10": () =>
      new Response(body, { headers: { "content-type": "application/octet-stream" } })
  });

  const { result, text } = await call(client, "jira_download_attachment", { attachmentId: "10" });

  assert.equal(result.isError, true);
  assert.match(text, /above the .*-byte limit/);
  assert.ok(sent < 200, "the download was cut off early");
  await assert.rejects(readFile(path.join(downloadDir, "10-big.bin")));
});

test("tools return compact structuredContent matching their outputSchema, in both Markdown and raw mode", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1": () =>
      json({
        key: "ABC-1",
        fields: { summary: "One", status: { name: "Open" }, labels: ["x"], assignee: { displayName: "Ann" } }
      })
  });
  const { tools } = await client.listTools();
  assert.ok(tools.find((tool) => tool.name === "jira_get_issue")?.outputSchema, "outputSchema is declared");

  const markdown = await call(client, "jira_get_issue", { issueKey: "ABC-1" });
  assert.equal(markdown.result.structuredContent.key, "ABC-1");
  assert.equal(markdown.result.structuredContent.status, "Open");
  assert.deepEqual(markdown.result.structuredContent.labels, ["x"]);
  assert.equal(markdown.result.structuredContent.assignee.displayName, "Ann");

  const raw = await call(client, "jira_get_issue", { issueKey: "ABC-1", raw: true });
  assert.equal(raw.result.structuredContent.summary, "One");
  assert.equal(JSON.parse(raw.text).key, "ABC-1");
});

test("repeated issue and comment reads are served from the short cache, and the cache can be disabled", async () => {
  const routes = {
    "/rest/api/3/issue/ABC-1": () => json({ key: "ABC-1", fields: { summary: "Cached" } }),
    "/rest/api/3/issue/ABC-1/comment": () => json({ comments: [], total: 0 })
  };
  const { client, calls } = await connect(routes);

  for (let i = 0; i < 3; i++) {
    await call(client, "jira_get_issue", { issueKey: "ABC-1" });
    await call(client, "jira_get_comments", { issueKey: "ABC-1" });
  }
  assert.equal(calls.length, 2);

  // Rendered fields are a different request, so raw does not reuse the plain read.
  await call(client, "jira_get_issue", { issueKey: "ABC-1", raw: true });
  assert.equal(calls.length, 3);
});

test("issueCacheTtlMs 0 sends every read to Jira", async () => {
  const { client, calls } = await connect(
    { "/rest/api/3/issue/ABC-1": () => json({ key: "ABC-1", fields: { summary: "Fresh" } }) },
    {},
    { issueCacheTtlMs: 0 }
  );

  await call(client, "jira_get_issue", { issueKey: "ABC-1" });
  await call(client, "jira_get_issue", { issueKey: "ABC-1" });

  assert.equal(calls.length, 2);
});

test("long Markdown results are cut by JIRA_MAX_RESPONSE_CHARS, raw JSON is not", async () => {
  const previous = process.env.JIRA_MAX_RESPONSE_CHARS;
  process.env.JIRA_MAX_RESPONSE_CHARS = "500";

  try {
    const { client } = await connect({
      "/rest/api/3/search/jql": () =>
        json({
          issues: Array.from({ length: 40 }, (_, i) => ({
            key: `ABC-${i + 1}`,
            fields: { summary: `A fairly long summary to fill the table row number ${i + 1}` }
          }))
        })
    });

    const markdown = await call(client, "jira_search_issues", { jql: "project = ABC" });
    assert.match(markdown.text, /\[Truncated: showing \d+ of \d+ characters/);
    assert.match(markdown.text, /untrusted data/);
    assert.ok(markdown.text.length < 1200);

    const raw = await call(client, "jira_search_issues", { jql: "project = ABC", raw: true });
    assert.equal(JSON.parse(raw.text).issues.length, 40);
  } finally {
    if (previous === undefined) {
      delete process.env.JIRA_MAX_RESPONSE_CHARS;
    } else {
      process.env.JIRA_MAX_RESPONSE_CHARS = previous;
    }
  }
});

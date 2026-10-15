// JIRA_ALLOWED_PROJECTS and CONFLUENCE_ALLOWED_SPACES: limits the server enforces itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAllowlist, projectOfIssue, scopeJql } from "./access.js";
import { call, connect, json } from "./test-support.js";

test("parseAllowlist trims, drops blanks and duplicates, and is undefined when empty", () => {
  assert.deepEqual(parseAllowlist(" ABC, XYZ ,,ABC"), ["ABC", "XYZ"]);
  assert.equal(parseAllowlist(undefined), undefined);
  assert.equal(parseAllowlist(" , "), undefined);
});

test("projectOfIssue takes the part before the last dash", () => {
  assert.equal(projectOfIssue("ABC-12"), "ABC");
  assert.equal(projectOfIssue("A-B-7"), "A-B");
  assert.equal(projectOfIssue("nope"), undefined);
});

test("scopeJql ANDs the project list in front of the query and keeps ORDER BY at the end", () => {
  assert.equal(scopeJql("status = Open", ["ABC", "XYZ"]), 'project in ("ABC", "XYZ") AND (status = Open)');
  assert.equal(
    scopeJql("assignee = currentUser() order by updated DESC", ["ABC"]),
    'project in ("ABC") AND (assignee = currentUser()) order by updated DESC'
  );
  assert.equal(scopeJql("ORDER BY created", ["ABC"]), 'project in ("ABC") ORDER BY created');
  assert.equal(scopeJql("", ["ABC"]), 'project in ("ABC")');
  // "order by" inside a string is data, not the clause.
  assert.equal(scopeJql('summary ~ "order by me"', ["ABC"]), 'project in ("ABC") AND (summary ~ "order by me")');
});

test("scopeJql refuses queries that could close the group or leave a quote open", () => {
  assert.throws(() => scopeJql("a = 1) OR (project = SECRET", ["ABC"]), /unbalanced/);
  assert.throws(() => scopeJql("(a = 1", ["ABC"]), /unterminated/);
  assert.throws(() => scopeJql('summary ~ "open', ["ABC"]), /unterminated/);
});

const jiraOnly = { allowedProjects: ["ABC"] };

test("with JIRA_ALLOWED_PROJECTS issues of other projects are refused before any request", async () => {
  const { client, calls } = await connect({}, jiraOnly);

  for (const [name, args] of [
    ["jira_get_issue", { issueKey: "SECRET-1" }],
    ["jira_get_comments", { issueKey: "SECRET-1" }],
    ["jira_list_attachments", { issueKey: "SECRET-1" }],
    ["jira_get_project", { projectKey: "SECRET" }],
    ["jira_get_project_issues", { projectKey: "SECRET" }]
  ] as const) {
    const { result, text } = await call(client, name, args);
    assert.equal(result.isError, true, name);
    assert.match(text, /not allowed by JIRA_ALLOWED_PROJECTS/, name);
  }

  assert.equal(calls.length, 0);
});

test("allowed issues work, and an issue that moved to another project is refused by its answered key", async () => {
  const { client } = await connect(
    {
      "/rest/api/3/issue/ABC-1": () => json({ key: "ABC-1", fields: { summary: "Fine" } }),
      "/rest/api/3/issue/ABC-2": () => json({ key: "SECRET-9", fields: { summary: "Moved" } })
    },
    jiraOnly
  );

  assert.match((await call(client, "jira_get_issue", { issueKey: "ABC-1" })).text, /Fine/);

  const moved = await call(client, "jira_get_issue", { issueKey: "ABC-2" });
  assert.equal(moved.result.isError, true);
  assert.match(moved.text, /SECRET/);
});

test("searches are restricted to the allowed projects, counts too", async () => {
  const { client, calls } = await connect(
    {
      "/rest/api/3/search/jql": () => json({ issues: [] }),
      "/rest/api/3/search/approximate-count": () => json({ count: 3 })
    },
    { allowedProjects: ["ABC", "XYZ"] }
  );

  await call(client, "jira_search_issues", { jql: "status = Open ORDER BY created", includeTotal: true });

  assert.equal(calls[0].url.searchParams.get("jql"), 'project in ("ABC", "XYZ") AND (status = Open) ORDER BY created');
  const body = JSON.parse(calls[1].init?.body as string);
  assert.equal(body.jql, 'project in ("ABC", "XYZ") AND (status = Open) ORDER BY created');

  const { result } = await call(client, "jira_search_issues", { jql: "x = 1) OR (project = SECRET" });
  assert.equal(result.isError, true);
});

test("project listings and boards only show allowed projects", async () => {
  const { client } = await connect(
    {
      "/rest/api/3/project/search": () =>
        json({
          values: [
            { key: "ABC", name: "Allowed" },
            { key: "SECRET", name: "Hidden" }
          ],
          isLast: true
        }),
      "/rest/agile/1.0/board": () =>
        json({
          values: [
            { id: 1, name: "Mine", type: "scrum", location: { projectKey: "ABC" } },
            { id: 2, name: "Theirs", type: "scrum", location: { projectKey: "SECRET" } },
            { id: 3, name: "Unknown", type: "kanban" }
          ]
        })
    },
    jiraOnly
  );

  const projects = await call(client, "jira_list_projects", {});
  assert.match(projects.text, /Allowed/);
  assert.doesNotMatch(projects.text, /Hidden/);

  const boards = await call(client, "jira_list_boards", {});
  assert.match(boards.text, /Mine/);
  assert.doesNotMatch(boards.text, /Theirs|Unknown/);
});

test("jira_download_attachment needs the issue and checks the attachment belongs to it", async () => {
  const { client, calls } = await connect(
    {
      "/rest/api/3/issue/ABC-1": () => json({ key: "ABC-1", fields: { attachment: [{ id: "10", filename: "a.txt" }] } })
    },
    jiraOnly
  );

  const missing = await call(client, "jira_download_attachment", { attachmentId: "10" });
  assert.equal(missing.result.isError, true);
  assert.match(missing.text, /issueKey is required/);

  const foreign = await call(client, "jira_download_attachment", { attachmentId: "99", issueKey: "ABC-1" });
  assert.equal(foreign.result.isError, true);
  assert.match(foreign.text, /does not belong to ABC-1/);

  assert.ok(!calls.some((entry) => entry.url.pathname.includes("/attachment/")));
});

const spaces = () =>
  json({
    results: [
      { id: "100", key: "DOCS", name: "Docs" },
      { id: "200", key: "HR", name: "HR" }
    ]
  });

test("with CONFLUENCE_ALLOWED_SPACES pages of other spaces are refused", async () => {
  const { client } = await connect(
    {
      "/wiki/api/v2/spaces": spaces,
      "/wiki/api/v2/pages/1": () => json({ id: "1", title: "Public", spaceId: "100", body: {} }),
      "/wiki/api/v2/pages/2": () => json({ id: "2", title: "Payroll", spaceId: "200", body: {} }),
      "/wiki/api/v2/pages/2/children": () => json({ results: [{ id: "3", title: "Leak" }] })
    },
    { allowedSpaces: ["docs"] }
  );

  assert.match((await call(client, "confluence_get_page", { pageId: "1" })).text, /Public/);

  for (const [name, args] of [
    ["confluence_get_page", { pageId: "2" }],
    ["confluence_get_page_children", { pageId: "2" }]
  ] as const) {
    const { result, text } = await call(client, name, args);
    assert.equal(result.isError, true, name);
    assert.match(text, /CONFLUENCE_ALLOWED_SPACES/, name);
    assert.doesNotMatch(text, /Leak/);
  }
});

test("confluence searches and listings are limited to allowed spaces", async () => {
  const { client, calls } = await connect(
    {
      "/wiki/api/v2/spaces": spaces,
      "/wiki/rest/api/search": () => json({ totalSize: 0, results: [] })
    },
    { allowedSpaces: ["DOCS"] }
  );

  await call(client, "confluence_search_pages", { query: "runbook" });
  const cql = calls.find((entry) => entry.url.pathname === "/wiki/rest/api/search")?.url.searchParams.get("cql");
  assert.match(cql ?? "", /AND space in \("DOCS"\) ORDER BY/);

  const other = await call(client, "confluence_search_pages", { query: "pay", spaceKey: "HR" });
  assert.equal(other.result.isError, true);

  const listing = await call(client, "confluence_list_spaces", {});
  assert.match(listing.text, /Docs/);
  assert.doesNotMatch(listing.text, /HR/);

  const pages = await call(client, "confluence_get_space_pages", { spaceKey: "HR" });
  assert.equal(pages.result.isError, true);
});

test("a Confluence attachment is checked through its page", async () => {
  const { client } = await connect(
    {
      "/wiki/api/v2/spaces": spaces,
      "/wiki/api/v2/attachments/a1": () => json({ id: "a1", pageId: "2", title: "x.png", downloadLink: "/d/a1" }),
      "/wiki/api/v2/attachments/a2": () => json({ id: "a2", title: "orphan.png", downloadLink: "/d/a2" }),
      "/wiki/api/v2/pages/2": () => json({ id: "2", spaceId: "200" })
    },
    { allowedSpaces: ["DOCS"] }
  );

  for (const id of ["a1", "a2"]) {
    const { result } = await call(client, "confluence_download_attachment", { attachmentId: id });
    assert.equal(result.isError, true, id);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatAttachments,
  formatComments,
  formatConfluenceSearch,
  formatConfluenceSpacePages,
  formatIssue,
  formatSearch
} from "./compact.js";

const adf = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }]
});

test("formatIssue renders meta, links, description and aliased custom fields", () => {
  const md = formatIssue(
    {
      key: "ABC-1",
      fields: {
        summary: "Broken login",
        status: { name: "In Progress" },
        assignee: { displayName: "Ann", emailAddress: "ann@example.com" },
        labels: ["auth", "web"],
        created: "2026-09-18T11:12:13.000+0000",
        issuelinks: [
          {
            type: { outward: "blocks" },
            outwardIssue: { key: "ABC-2", fields: { summary: "Other", status: { name: "Done" } } }
          }
        ],
        description: adf("Steps here"),
        customfield_1: { value: "High" }
      }
    },
    [{ id: "customfield_1", alias: "impact" }]
  );

  assert.match(md, /^# ABC-1: Broken login/);
  assert.match(md, /- \*\*Status:\*\* In Progress/);
  assert.match(md, /- \*\*Assignee:\*\* Ann <ann@example.com>/);
  assert.match(md, /- \*\*Labels:\*\* auth, web/);
  assert.match(md, /- \*\*Created:\*\* 2026-09-18 11:12/);
  assert.match(md, /## Links\n- blocks: ABC-2 — Other \[Done\]/);
  assert.match(md, /## Description\nSteps here/);
  assert.match(md, /## impact \(customfield_1\)\nHigh/);
  assert.doesNotMatch(md, /Priority/);
});

test("formatIssue marks an empty description", () => {
  assert.match(formatIssue({ key: "ABC-1", fields: {} }, []), /## Description\n_\(empty\)_/);
});

test("formatSearch shows a table and the next page token", () => {
  const md = formatSearch({
    issues: [{ key: "ABC-1", fields: { summary: "a | b", status: { name: "Open" }, updated: "2026-01-02T03:04:05" } }],
    nextPageToken: "tok",
    isLast: false
  });

  assert.match(md, /^1 issues \(more available\)/);
  assert.match(md, /\| ABC-1 \| a \\\| b \| Open \|/);
  assert.match(md, /nextPageToken: tok$/);
  assert.doesNotMatch(formatSearch({ issues: [], nextPageToken: "tok", isLast: true }), /nextPageToken/);
});

test("formatAttachments lists files with human sizes", () => {
  assert.equal(formatAttachments([], "ABC-1"), "## Attachments (0) — ABC-1\n\n_(none)_");
  const md = formatAttachments([{ id: "10", filename: "shot.png", mimeType: "image/png", size: 2048 }], "ABC-1");
  assert.match(md, /\| 10 \| shot.png \| image\/png \| 2.0 KB \| — \| — \|/);
});

test("formatComments truncates long bodies and points at the full view", () => {
  const md = formatComments(
    [{ id: "7", created: "2026-01-01T00:00:00", author: { displayName: "Bob" }, body: adf("x".repeat(300)) }],
    { issueKey: "ABC-1", total: 3, order: "desc", maxLength: 100, full: false }
  );

  assert.match(md, /^ABC-1 — showing 1 of 3 comments \(newest first\)/);
  assert.match(md, /### 2026-01-01 00:00 — Bob · id 7/);
  assert.match(md, /… \[truncated 200 chars; full:true, commentId:7\]/);
});

test("Confluence search and space listings", () => {
  const search = formatConfluenceSearch({
    totalSize: 5,
    results: [
      {
        content: { id: "1", title: "Home" },
        resultGlobalContainer: { displayUrl: "/spaces/MS" },
        lastModified: "2026-02-03T04:05:06"
      }
    ]
  });
  assert.match(search, /^1 of 5 pages/);
  assert.match(search, /\| 1 \| Home \| MS \| 2026-02-03 04:05 \|/);

  const space = formatConfluenceSpacePages(
    {
      results: [{ id: "2", title: "Child", parentId: "1" }],
      _links: { next: "/wiki/api/v2/spaces/9/pages?cursor=abc&limit=1" }
    },
    "MS"
  );
  assert.match(space, /^MS — 1 pages/);
  assert.match(space, /cursor: abc$/);
});

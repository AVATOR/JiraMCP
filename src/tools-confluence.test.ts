// End-to-end tests of the Confluence tools through an in-memory MCP client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { BASE_URL, call, connect, json } from "./test-support.js";

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

test("confluence_get_page shows labels and the page path", async () => {
  const { client, calls } = await connect({
    "/wiki/api/v2/pages/123": () =>
      json({ id: "123", title: "Runbook", labels: { results: [{ name: "ops" }, { name: "oncall" }] }, body: {} }),
    "/wiki/api/v2/pages/123/ancestors": () =>
      json({
        results: [
          { id: "1", title: "Home" },
          { id: "2", title: "Teams" }
        ]
      })
  });

  const { text } = await call(client, "confluence_get_page", { pageId: "123" });

  assert.match(text, /- \*\*Path:\*\* Home \(1\) › Teams \(2\)/);
  assert.match(text, /- \*\*Labels:\*\* ops, oncall/);
  assert.equal(calls[0].url.searchParams.get("include-labels"), "true");
});

test("confluence_get_page accepts a URL and a title with spaceKey", async () => {
  const { client, calls } = await connect({
    "/wiki/api/v2/pages/555": () => json({ id: "555", title: "From URL" }),
    "/wiki/api/v2/spaces": () => json({ results: [{ id: "88", key: "MS" }] }),
    "/wiki/api/v2/pages": () => json({ results: [{ id: "555", title: "From title" }] })
  });

  const byUrl = await call(client, "confluence_get_page", {
    pageId: `${BASE_URL}/wiki/spaces/MS/pages/555/Some+Title`
  });
  assert.match(byUrl.text, /^# From URL/);

  const byTitle = await call(client, "confluence_get_page", { pageId: "Release notes", spaceKey: "MS" });
  assert.match(byTitle.text, /^# From URL/);
  const lookup = calls.find((entry) => entry.url.pathname === "/wiki/api/v2/pages");
  assert.equal(lookup?.url.searchParams.get("title"), "Release notes");
  assert.equal(lookup?.url.searchParams.get("space-id"), "88");
});

test("confluence_get_page reports ambiguous and unknown titles", async () => {
  const ambiguous = await connect({
    "/wiki/api/v2/pages": () => json({ results: [{ id: "1" }, { id: "2" }] })
  });
  const first = await call(ambiguous.client, "confluence_get_page", { pageId: "Dup" });
  assert.equal(first.result.isError, true);
  assert.match(first.text, /Several pages are titled "Dup"/);

  await ambiguous.client.close();
  const missing = await connect({ "/wiki/api/v2/pages": () => json({ results: [] }) });
  const second = await call(missing.client, "confluence_get_page", { pageId: "Nope" });
  assert.match(second.text, /No Confluence page titled "Nope"/);
});

test("confluence_get_page_children lists children with a cursor", async () => {
  const { client, calls } = await connect({
    "/wiki/api/v2/pages/10/children": () =>
      json({ results: [{ id: "11", title: "Child A" }], _links: { next: "/wiki/api/v2/pages/10/children?cursor=c2" } })
  });

  const { text } = await call(client, "confluence_get_page_children", { pageId: "10", limit: 5, cursor: "c1" });

  assert.match(text, /1 child pages/);
  assert.match(text, /\| 11 \| Child A \|/);
  assert.match(text, /cursor: c2/);
  assert.equal(calls[0].url.searchParams.get("cursor"), "c1");
  assert.equal(calls[0].url.searchParams.get("limit"), "5");
});

test("confluence_get_page_comments renders footer and inline comments", async () => {
  const { client, calls } = await connect({
    "/wiki/api/v2/pages/10/footer-comments": () =>
      json({
        results: [
          {
            id: "c1",
            version: { createdAt: "2026-09-01T10:00:00.000Z", authorId: "u1" },
            body: { storage: { value: "<p>Looks <strong>good</strong></p>" } }
          }
        ]
      }),
    "/wiki/api/v2/pages/10/inline-comments": () =>
      json({
        results: [{ id: "c2", resolutionStatus: "resolved", body: { storage: { value: "<p>Typo</p>" } } }]
      })
  });

  const footer = await call(client, "confluence_get_page_comments", { pageId: "10" });
  assert.match(footer.text, /1 footer comments/);
  assert.match(footer.text, /Looks \*\*good\*\*/);
  assert.equal(calls[0].url.searchParams.get("body-format"), "storage");

  const inline = await call(client, "confluence_get_page_comments", { pageId: "10", kind: "inline" });
  assert.match(inline.text, /1 inline comments/);
  assert.match(inline.text, /resolved/);
});

test("confluence_list_attachments and confluence_get_page_versions render tables", async () => {
  const { client } = await connect({
    "/wiki/api/v2/pages/10/attachments": () =>
      json({
        results: [
          {
            id: "att1",
            title: "diagram.png",
            mediaType: "image/png",
            fileSize: 2048,
            createdAt: "2026-09-01T10:00:00Z"
          }
        ]
      }),
    "/wiki/api/v2/pages/10/versions": () =>
      json({
        results: [
          { number: 3, createdAt: "2026-09-03T10:00:00Z", authorId: "u1", message: "fix typo", minorEdit: true },
          { number: 2, createdAt: "2026-09-02T10:00:00Z", authorId: "u2" }
        ]
      })
  });

  const attachments = await call(client, "confluence_list_attachments", { pageId: "10" });
  assert.match(attachments.text, /\| att1 \| diagram.png \| image\/png \| 2.0 KB \|/);

  const versions = await call(client, "confluence_get_page_versions", { pageId: "10" });
  assert.match(versions.text, /2 versions \(newest first\)/);
  assert.match(versions.text, /\| 3 \| 2026-09-03 10:00 \| u1 \| \(minor\) fix typo \|/);
});

test("confluence_download_attachment saves the file via its download link", async () => {
  const bytes = Buffer.from("hello");
  const { client, calls } = await connect({
    "/wiki/api/v2/attachments/att1": () =>
      json({
        id: "att1",
        title: "notes.txt",
        mediaType: "text/plain",
        fileSize: 5,
        downloadLink: "/download/attachments/10/notes.txt?version=1"
      }),
    "/wiki/download/attachments/10/notes.txt": () => new Response(bytes, { headers: { "content-type": "text/plain" } })
  });

  const { text } = await call(client, "confluence_download_attachment", { attachmentId: "att1" });

  assert.match(text, /Saved notes.txt \(text\/plain, 5 bytes\)/);
  const savedPath = text.match(/to (.+)$/m)?.[1] ?? "";
  assert.equal(await readFile(savedPath, "utf8"), "hello");
  assert.equal(calls.at(-1)?.url.searchParams.get("version"), "1");
});

test("confluence_download_attachment refuses oversized files before downloading", async () => {
  const { client, calls } = await connect({
    "/wiki/api/v2/attachments/big": () =>
      json({
        id: "big",
        title: "big.bin",
        fileSize: 200 * 1024 * 1024,
        downloadLink: "/download/attachments/10/big.bin"
      })
  });

  const { result, text } = await call(client, "confluence_download_attachment", { attachmentId: "big" });

  assert.equal(result.isError, true);
  assert.match(text, /above the 104857600-byte limit/);
  assert.equal(calls.length, 1);
});

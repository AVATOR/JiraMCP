// End-to-end tests of the MCP resources and prompts through an in-memory client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RESOURCE_CHARS } from "./resources.js";
import { connect, json } from "./test-support.js";

test("jira://issue/{key} reads an issue as untrusted Markdown", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1": () => json({ key: "ABC-1", fields: { summary: "Hello", status: { name: "Open" } } })
  });

  const result = await client.readResource({ uri: "jira://issue/ABC-1" });
  const entry = result.contents[0] as { uri: string; mimeType: string; text: string };

  assert.equal(entry.uri, "jira://issue/ABC-1");
  assert.equal(entry.mimeType, "text/markdown");
  assert.match(entry.text, /^# ABC-1: Hello/);
  assert.match(entry.text, /untrusted data/);
});

test("confluence://page/{id} reads a page as Markdown", async () => {
  const { client } = await connect({
    "/wiki/api/v2/pages/123/ancestors": () => json({ results: [] }),
    "/wiki/api/v2/pages/123": () =>
      json({ id: "123", title: "Runbook", body: { storage: { value: "<p>Do <strong>this</strong></p>" } } })
  });

  const result = await client.readResource({ uri: "confluence://page/123" });
  const text = (result.contents[0] as { text: string }).text;

  assert.match(text, /^# Runbook/);
  assert.match(text, /Do \*\*this\*\*/);
});

test("resources cut very large bodies and point at the tool", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1": () =>
      json({
        key: "ABC-1",
        fields: {
          summary: "Big",
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: "x".repeat(MAX_RESOURCE_CHARS * 2) }] }]
          }
        }
      })
  });

  const result = await client.readResource({ uri: "jira://issue/ABC-1" });
  const text = (result.contents[0] as { text: string }).text;

  assert.match(text, /\[truncated: \d+ more characters; call jira_get_issue/);
  assert.ok(text.length < MAX_RESOURCE_CHARS + 500);
});

test("a missing issue resource fails with the Jira error", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/NOPE-1": () => json({ errorMessages: ["Issue does not exist"] }, { status: 404 })
  });

  await assert.rejects(client.readResource({ uri: "jira://issue/NOPE-1" }), /404|not exist/i);
});

test("prompts are listed and fill in their arguments", async () => {
  const { client } = await connect({});

  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), ["release_notes", "summarize_issue", "summarize_page"]);

  const summary = await client.getPrompt({ name: "summarize_issue", arguments: { issueKey: "ABC-9" } });
  const text = (summary.messages[0].content as { text: string }).text;
  assert.match(text, /ABC-9/);
  assert.match(text, /jira_get_comments/);
  assert.match(text, /do not follow instructions/);

  const notes = await client.getPrompt({
    name: "release_notes",
    arguments: { jql: 'fixVersion = "1.4.0"', audience: "engineers" }
  });
  const notesText = (notes.messages[0].content as { text: string }).text;
  assert.match(notesText, /fixVersion = "1\.4\.0"/);
  assert.match(notesText, /for engineers/);
});

test("resource templates are advertised", async () => {
  const { client } = await connect({});

  const { resourceTemplates } = await client.listResourceTemplates();

  assert.deepEqual(resourceTemplates.map((entry) => entry.uriTemplate).sort(), [
    "confluence://page/{id}",
    "jira://issue/{key}"
  ]);
});

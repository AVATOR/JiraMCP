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

test("resources serve very large bodies in parts that name the next offset", async () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1": () =>
      json({
        key: "ABC-1",
        fields: {
          summary: "Big",
          description: {
            type: "doc",
            version: 1,
            content: lines.map((text) => ({ type: "paragraph", content: [{ type: "text", text }] }))
          }
        }
      })
  });

  const read = async (uri: string) => ((await client.readResource({ uri })).contents[0] as { text: string }).text;

  const first = await read("jira://issue/ABC-1");
  assert.ok(first.length < MAX_RESOURCE_CHARS + 600);
  assert.match(first, /\[Characters 0-\d+ of \d+\. Next part: jira:\/\/issue\/ABC-1\/offset\/\d+\]/);
  assert.match(first, /untrusted data/);

  // Following the pointers reads the whole body, each line exactly once.
  let text = first;
  let collected = first.split("\n\n[Characters")[0];
  for (let guard = 0; guard < 10; guard++) {
    const next = text.match(/Next part: (\S+?)\]/)?.[1];
    if (!next) {
      break;
    }
    text = await read(next);
    collected += "\n" + text.split("\n\n[Characters")[0];
  }

  assert.match(text, /End of resource\./);
  for (const index of [0, 1500, 2999]) {
    assert.equal(collected.split(`line ${index} `).length - 1, 1, `line ${index}`);
  }
});

test("a bad offset is an error", async () => {
  const { client } = await connect({
    "/rest/api/3/issue/ABC-1": () => json({ key: "ABC-1", fields: { summary: "Hi" } })
  });

  await assert.rejects(client.readResource({ uri: "jira://issue/ABC-1/offset/-5" }), /offset/);
  await assert.rejects(client.readResource({ uri: "jira://issue/ABC-1/offset/abc" }), /offset/);
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
    "confluence://page/{id}/offset/{offset}",
    "jira://issue/{key}",
    "jira://issue/{key}/offset/{offset}"
  ]);
});

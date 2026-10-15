import { test } from "node:test";
import assert from "node:assert/strict";
import { jqlString, parseCustomFields, retryDelayMs, sanitizeFileName } from "./server.js";

test("jqlString quotes and escapes backslashes and quotes", () => {
  assert.equal(jqlString("ABC"), '"ABC"');
  assert.equal(jqlString('say "hi"'), '"say \\"hi\\""');
  assert.equal(jqlString("a\\b"), '"a\\\\b"');
});

test("sanitizeFileName keeps safe characters, replaces the rest, caps length", () => {
  assert.equal(sanitizeFileName("screen shot (1).png"), "screen_shot_1_.png");
  assert.equal(sanitizeFileName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(sanitizeFileName(""), "attachment");
  assert.equal(sanitizeFileName("a".repeat(150)).length, 100);
});

test("parseCustomFields handles aliases, blanks and duplicates", () => {
  assert.deepEqual(parseCustomFields(undefined), []);
  assert.deepEqual(parseCustomFields("  "), []);
  assert.deepEqual(parseCustomFields("customfield_1:requirements, customfield_2 ,,customfield_1:dup, :x"), [
    { id: "customfield_1", alias: "requirements" },
    { id: "customfield_2", alias: "customfield_2" }
  ]);
});

test("retryDelayMs honours Retry-After seconds and dates, else backs off", () => {
  const withHeader = (value?: string) =>
    new Response(null, { status: 429, headers: value ? { "retry-after": value } : {} });

  assert.equal(retryDelayMs(withHeader("2"), 0), 2000);
  assert.equal(retryDelayMs(withHeader("600"), 0), 60_000);
  assert.equal(retryDelayMs(withHeader(new Date(Date.now() - 5000).toUTCString()), 0), 0);
  const fromDate = retryDelayMs(withHeader(new Date(Date.now() + 10_000).toUTCString()), 0);
  assert.ok(fromDate > 8000 && fromDate <= 10_000, `got ${fromDate}`);
  assert.equal(retryDelayMs(withHeader(), 0), 1000);
  assert.equal(retryDelayMs(withHeader(), 2), 4000);
});

test("truncateMarkdown cuts at a line, closes an open code fence and points at narrower requests", async () => {
  const { truncateMarkdown } = await import("./tools/shared.js");
  const text = ["intro", "```", ...Array.from({ length: 50 }, (_, i) => `line ${i}`), "```"].join("\n");

  assert.equal(truncateMarkdown(text, 0), text);
  assert.equal(truncateMarkdown(text, text.length), text);

  const cut = truncateMarkdown(text, 100);
  assert.ok(cut.startsWith("intro\n```\nline 0"));
  assert.match(cut, /\n```\n\n\[Truncated: showing \d+ of \d+ characters\./);
  assert.match(cut, /`limit`/);
  assert.ok(!cut.includes("line 49"));
});

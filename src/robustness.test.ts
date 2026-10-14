// Jira and Confluence content is written by third parties, so the converters must turn any
// input into text instead of throwing: one hostile comment must not make a page unreadable.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adfToMarkdown } from "./adf.js";
import { formatIssue, formatSearch } from "./compact/index.js";
import { storageToMarkdown } from "./storage.js";

/**
 * Small deterministic PRNG (mulberry32), so a failing fuzz case can be reproduced.
 *
 * @param seed Initial state.
 * @returns Function returning numbers in [0, 1).
 */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("storage: out-of-range numeric entities are kept as text instead of throwing", () => {
  assert.equal(storageToMarkdown("<p>a &#99999999; b</p>"), "a &#99999999; b");
  assert.equal(storageToMarkdown("<p>&#xFFFFFFFF;</p>"), "&#xFFFFFFFF;");
  assert.equal(storageToMarkdown("<p>&#65; &#x42;</p>"), "A B");
});

test("storage: deep nesting is flattened and keeps its text", () => {
  assert.match(storageToMarkdown("<div>".repeat(20000) + "deep text"), /deep text/);
  // Realistic nesting (here 150 lists) is untouched.
  assert.match(storageToMarkdown("<ul><li>".repeat(150) + "item"), /item/);
  assert.doesNotThrow(() => storageToMarkdown("<ul><li>".repeat(1000) + "item"));
});

test("adf: malformed nodes render as text", () => {
  const heading = {
    type: "doc",
    content: [{ type: "heading", attrs: { level: -1 }, content: [{ type: "text", text: "h" }] }]
  };
  assert.equal(adfToMarkdown(heading), "# h");
  assert.equal(adfToMarkdown({ type: "doc", content: "abc" }), "");
  assert.equal(adfToMarkdown({ type: "doc", content: [null, 1, { type: "table", content: [null] }] }), "");
  assert.equal(
    adfToMarkdown({ type: "heading", attrs: { level: "x" }, content: [{ type: "text", text: "h" }] }),
    "# h"
  );
});

test("adf: deep nesting is cut off without overflowing the stack", () => {
  let node: unknown = { type: "text", text: "bottom" };
  for (let i = 0; i < 50000; i++) {
    node = { type: "bulletList", content: [{ type: "listItem", content: [node] }] };
  }

  const text = adfToMarkdown({ type: "doc", content: [node] }, { full: true });

  assert.match(text, /nested content omitted/);
});

test("compact formatters tolerate null entries in lists", () => {
  const issue = formatIssue(
    { key: "A-1", fields: { labels: null, issuelinks: [null], subtasks: [null], attachment: [null] } } as never,
    []
  );
  assert.match(issue, /^# A-1/);
  assert.match(formatSearch({ issues: [null] } as never), /^0 issues/);
});

test("fuzz: random ADF trees and storage strings never throw", () => {
  const next = random(20261014);
  const types = ["doc", "paragraph", "heading", "bulletList", "listItem", "table", "tableRow", "panel", "text", "x"];
  const junk = [null, 0, -1, "s", [], {}, true];

  const node = (depth: number): unknown => {
    if (next() < 0.1) {
      return junk[Math.floor(next() * junk.length)];
    }

    return {
      type: types[Math.floor(next() * types.length)],
      text: next() < 0.3 ? "t" : junk[Math.floor(next() * junk.length)],
      attrs: next() < 0.3 ? { level: junk[Math.floor(next() * junk.length)] } : junk[Math.floor(next() * junk.length)],
      content:
        depth > 6 || next() < 0.2
          ? junk[Math.floor(next() * junk.length)]
          : Array.from({ length: Math.floor(next() * 4) }, () => node(depth + 1))
    };
  };

  const pieces = [
    "<p>",
    "</p>",
    "<ul>",
    "<li>",
    "</li>",
    "<table>",
    "<td>",
    "&#",
    "&amp;",
    "<![CDATA[",
    "]]>",
    "<ac:",
    "x",
    ' a="',
    "<",
    ">"
  ];

  for (let i = 0; i < 300; i++) {
    assert.doesNotThrow(() => adfToMarkdown(node(0), { full: next() < 0.5 }), `adf case ${i}`);
    const source = Array.from({ length: 30 }, () => pieces[Math.floor(next() * pieces.length)]).join("");
    assert.doesNotThrow(() => storageToMarkdown(source), `storage case ${i}: ${source}`);
  }
});

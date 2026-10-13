import { test } from "node:test";
import assert from "node:assert/strict";
import { storageToMarkdown } from "./storage.js";

test("paragraphs, headings, marks, entities", () => {
  assert.equal(
    storageToMarkdown("<h1>Site ID</h1><p>BM &rarr; <strong>Merchant Tools</strong> &amp; <em>more</em><br />next</p>"),
    "# Site ID\n\nBM → **Merchant Tools** & *more*\nnext"
  );
});

test("info panel, code macro and image with caption", () => {
  const md = storageToMarkdown(
    '<ac:structured-macro ac:name="info" ac:schema-version="1"><ac:rich-text-body><p>Read below</p></ac:rich-text-body></ac:structured-macro>' +
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[const a = "<b>";]]></ac:plain-text-body></ac:structured-macro>' +
      '<ac:image ac:alt="x.png"><ri:attachment ri:filename="x.png" /><ac:caption><p>DY Site ID</p></ac:caption></ac:image>'
  );
  assert.equal(md, '> **info:** Read below\n\n```js\nconst a = "<b>";\n```\n\n[image: x.png — DY Site ID]');
});

test("nested lists with paragraphs and a task list", () => {
  const md = storageToMarkdown(
    '<ol start="1"><li><p>one</p><ul><li><p>a</p></li></ul></li><li><p>two</p><p>more</p></li></ol>' +
      "<ac:task-list><ac:task><ac:task-status>complete</ac:task-status><ac:task-body>done</ac:task-body></ac:task>" +
      "<ac:task><ac:task-status>incomplete</ac:task-status><ac:task-body>todo</ac:task-body></ac:task></ac:task-list>"
  );
  assert.equal(md, "1. one\n  - a\n2. two\n  more\n\n- [x] done\n- [ ] todo");
});

test("table, links and unmatched tags keep text", () => {
  const md = storageToMarkdown(
    '<table><tbody><tr><th>A</th><th>B</th></tr><tr><td><p>1|2</p></td><td><a href="https://x">link</a></td></tr></tbody></table>' +
      '<p><ac:link><ri:page ri:content-title="Home" /></ac:link> <span>open <b>tag</p>'
  );
  assert.equal(md, "| A | B |\n| --- | --- |\n| 1\\|2 | [link](https://x) |\n\n[page: Home] open **tag**");
});

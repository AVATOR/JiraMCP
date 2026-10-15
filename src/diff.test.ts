import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, formatDiff } from "./diff.js";

test("diffLines keeps common lines and reports additions and removals in order", () => {
  const changes = diffLines(["a", "b", "c", "d"], ["a", "c", "x", "d", "e"]);

  assert.deepEqual(
    changes.map((line) => `${line.op}${line.text}`),
    [" a", "-b", " c", "+x", " d", "+e"]
  );
});

test("diffLines of equal texts has no changes and formatDiff is empty", () => {
  const changes = diffLines(["a", "b"], ["a", "b"]);

  assert.ok(changes.every((line) => line.op === " "));
  assert.equal(formatDiff(changes), "");
});

test("formatDiff keeps context around changes and counts the skipped stretches", () => {
  const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const after = [...before];
  after[10] = "changed";

  const text = formatDiff(diffLines(before, after), 1);

  assert.equal(
    text,
    ["@@ 9 unchanged lines @@", " line 9", "-line 10", "+changed", " line 11", "@@ 8 unchanged lines @@"].join("\n")
  );
});

test("a middle part too large to compare falls back to one removed and one added block", () => {
  const before = Array.from({ length: 3000 }, (_, i) => `a${i}`);
  const after = Array.from({ length: 3000 }, (_, i) => `b${i}`);

  const changes = diffLines(["head", ...before, "tail"], ["head", ...after, "tail"]);

  assert.equal(changes.filter((line) => line.op === "-").length, 3000);
  assert.equal(changes.filter((line) => line.op === "+").length, 3000);
  assert.equal(changes[0].text, "head");
  assert.equal(changes.at(-1)?.text, "tail");
});

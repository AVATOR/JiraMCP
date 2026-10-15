export type DiffLine = { op: " " | "+" | "-"; text: string };

// The middle part left after trimming equal ends is compared with an LCS table of this many cells at most.
const MAX_CELLS = 4_000_000;

/**
 * Line diff of two texts: equal ends are trimmed, the changed middle is compared with a longest
 * common subsequence. A middle too large for that is reported as one removed and one added block.
 *
 * @param before Lines of the old text.
 * @param after Lines of the new text.
 * @returns Lines tagged as kept, added or removed, in order.
 */
export function diffLines(before: string[], after: string[]): DiffLine[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) {
    start++;
  }

  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }

  const head = before.slice(0, start).map((text) => ({ op: " " as const, text }));
  const tail = before.slice(endBefore).map((text) => ({ op: " " as const, text }));
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);

  if (a.length * b.length > MAX_CELLS) {
    return [
      ...head,
      ...a.map((text) => ({ op: "-" as const, text })),
      ...b.map((text) => ({ op: "+" as const, text })),
      ...tail
    ];
  }

  // lcs[i][j] = length of the common subsequence of a[i..] and b[j..].
  const width = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? lcs[(i + 1) * width + j + 1] + 1 : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
    }
  }

  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      middle.push({ op: " ", text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      middle.push({ op: "-", text: a[i++] });
    } else {
      middle.push({ op: "+", text: b[j++] });
    }
  }
  while (i < a.length) {
    middle.push({ op: "-", text: a[i++] });
  }
  while (j < b.length) {
    middle.push({ op: "+", text: b[j++] });
  }

  return [...head, ...middle, ...tail];
}

/**
 * Renders a diff as hunks: changed lines with `context` unchanged lines around them, and a marker for
 * each skipped stretch.
 *
 * @param lines Result of diffLines.
 * @param context Unchanged lines to keep around a change.
 * @returns Text with `+`/`-` prefixes; empty when nothing changed.
 */
export function formatDiff(lines: DiffLine[], context = 2): string {
  const keep = new Array<boolean>(lines.length).fill(false);

  lines.forEach((line, index) => {
    if (line.op !== " ") {
      for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) {
        keep[k] = true;
      }
    }
  });

  const out: string[] = [];
  let skipped = 0;

  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped) {
        out.push(`@@ ${skipped} unchanged lines @@`);
        skipped = 0;
      }
      out.push(`${line.op}${line.text}`);
    } else {
      skipped++;
    }
  });

  if (skipped && out.length) {
    out.push(`@@ ${skipped} unchanged lines @@`);
  }

  return out.join("\n");
}

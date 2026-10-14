// Converts Atlassian Document Format (ADF) trees into compact Markdown.

export type AdfOptions = {
  // Code blocks / paragraphs that look like JSON or XML and exceed this size are collapsed.
  maxBlockChars?: number;
  // How many characters of a collapsed block are kept as a preview.
  previewChars?: number;
  // Disables collapsing (used when the caller asked for the full content).
  full?: boolean;
  // Included in the collapse hint so the agent knows how to expand it.
  commentId?: string;
};

type AdfNode = {
  type?: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, any>;
  marks?: { type: string; attrs?: Record<string, any> }[];
};

// Documents come from third parties, so nesting beyond this is cut off instead of overflowing the stack.
const MAX_DEPTH = 100;

const DEFAULT_MAX_BLOCK_CHARS = 500;
const DEFAULT_PREVIEW_CHARS = 300;

/**
 * Whether the value is an Atlassian Document Format document (root node of type "doc").
 *
 * @param value Value to check.
 * @returns True when the value is an ADF document (type guard).
 */
export function isAdf(value: unknown): value is AdfNode {
  return !!value && typeof value === "object" && (value as AdfNode).type === "doc";
}

/**
 * Converts an ADF document to Markdown; plain strings pass through and empty values give "".
 *
 * @param node ADF document or fragment, a plain string, or null.
 * @param options Limits for collapsing large payloads.
 * @returns Trimmed Markdown; empty string for null or undefined.
 */
export function adfToMarkdown(node: unknown, options: AdfOptions = {}): string {
  if (node === null || node === undefined) {
    return "";
  }

  if (typeof node === "string") {
    return node;
  }

  const root = sanitize(node);

  if (!root) {
    return "";
  }

  return renderBlock(root, options, 0)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Whether the value is a non-null, non-array object.
 *
 * @param value Value to check.
 * @returns True for plain objects.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Copies the tree into well-formed nodes: content is always an array of objects, attrs an object,
 * and nesting is capped. Iterative, so a hostile document cannot overflow the stack here either.
 *
 * @param value Untrusted ADF value.
 * @returns A safe root node, or null when the value is not an object.
 */
function sanitize(value: unknown): AdfNode | null {
  if (!isObject(value)) {
    return null;
  }

  const copy = (source: Record<string, unknown>): AdfNode => ({
    type: typeof source.type === "string" ? source.type : undefined,
    text: typeof source.text === "string" ? source.text : undefined,
    attrs: isObject(source.attrs) ? source.attrs : undefined,
    marks: Array.isArray(source.marks)
      ? source.marks.filter(isObject).map((mark) => ({
          type: typeof mark.type === "string" ? mark.type : "",
          attrs: isObject(mark.attrs) ? mark.attrs : undefined
        }))
      : undefined
  });

  const root = copy(value);
  const pending: { source: Record<string, unknown>; target: AdfNode; depth: number }[] = [
    { source: value, target: root, depth: 0 }
  ];

  while (pending.length) {
    const { source, target, depth } = pending.pop()!;

    if (!Array.isArray(source.content)) {
      continue;
    }

    if (depth >= MAX_DEPTH) {
      target.content = [{ type: "text", text: "[nested content omitted]" }];
      continue;
    }

    target.content = [];
    for (const entry of source.content) {
      if (isObject(entry)) {
        const node = copy(entry);
        target.content.push(node);
        pending.push({ source: entry, target: node, depth: depth + 1 });
      }
    }
  }

  return root;
}

/**
 * Renders the child blocks of a node and joins the non-empty results.
 *
 * @param node Parent node.
 * @param options Rendering options.
 * @param depth List nesting depth.
 * @param separator String placed between rendered children.
 * @returns Non-empty rendered children joined with the separator.
 */
function renderChildren(node: AdfNode, options: AdfOptions, depth: number, separator = "\n\n"): string {
  return (node.content ?? [])
    .map((child) => renderBlock(child, options, depth))
    .filter((part) => part !== "")
    .join(separator);
}

/**
 * Renders a run of inline nodes (text, mentions, emoji) into one string.
 *
 * @param nodes Inline nodes, may be undefined.
 * @returns Concatenated inline Markdown.
 */
function renderInline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(renderInlineNode).join("");
}

/**
 * Renders a single inline node.
 *
 * @param node Inline node.
 * @returns Markdown for the node.
 */
function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks);
    case "hardBreak":
      return "\n";
    case "mention":
      return `@${String(node.attrs?.text ?? node.attrs?.displayName ?? "user").replace(/^@/, "")}`;
    case "emoji":
      return node.attrs?.text ?? node.attrs?.shortName ?? "";
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return node.attrs?.url ?? "";
    case "status":
      return `[${node.attrs?.text ?? ""}]`;
    case "date":
      return node.attrs?.timestamp ? new Date(Number(node.attrs.timestamp)).toISOString().slice(0, 10) : "";
    case "media":
    case "mediaInline":
      return mediaLabel(node);
    default:
      return renderInline(node.content);
  }
}

/**
 * Media nodes carry the media-service id, not the Jira attachment id, so the label points at jira_list_attachments / jira_download_attachment instead of the raw id.
 *
 * @param node Media or media wrapper node.
 * @returns Placeholder pointing at the attachment tools, or the inline content.
 */
function mediaLabel(node: AdfNode): string {
  if (node.type !== "media" && node.type !== "mediaInline") {
    return renderInline(node.content);
  }

  const name = node.attrs?.alt || node.attrs?.filename;
  return `[attachment${name ? `: ${name}` : ""} — use jira_list_attachments / jira_download_attachment]`;
}

/**
 * Wraps text in Markdown for ADF marks (bold, italic, code, strike, link).
 *
 * @param text Text to decorate.
 * @param marks ADF marks applied to the text.
 * @returns Text wrapped in the matching Markdown syntax.
 */
function applyMarks(text: string, marks: AdfNode["marks"]): string {
  let result = text;

  for (const mark of marks ?? []) {
    switch (mark.type) {
      case "strong":
        result = `**${result}**`;
        break;
      case "em":
        result = `*${result}*`;
        break;
      case "code":
        result = `\`${result}\``;
        break;
      case "strike":
        result = `~~${result}~~`;
        break;
      case "link":
        if (mark.attrs?.href && mark.attrs.href !== text) {
          result = `[${result}](${mark.attrs.href})`;
        }
        break;
    }
  }

  return result;
}

/**
 * Renders a block node; unknown node types fall back to their text content.
 *
 * @param node ADF node.
 * @param options Rendering options.
 * @param depth List nesting depth.
 * @returns Markdown for the block.
 */
function renderBlock(node: AdfNode, options: AdfOptions, depth: number): string {
  switch (node.type) {
    case "doc":
      return renderChildren(node, options, depth);
    case "paragraph":
      return collapseIfPayload(renderInline(node.content), options);
    case "heading":
      return `${"#".repeat(Math.max(1, Math.min(Number(node.attrs?.level) || 1, 6)))} ${renderInline(node.content)}`;
    case "bulletList":
    case "orderedList":
    case "taskList":
    case "decisionList":
      return renderList(node, options, depth);
    case "codeBlock": {
      const code = collapseIfPayload(renderInline(node.content), options, true);
      return `\`\`\`${node.attrs?.language ?? ""}\n${code}\n\`\`\``;
    }
    case "blockquote":
      return prefixLines(renderChildren(node, options, depth), "> ");
    case "panel":
      return prefixLines(`**${node.attrs?.panelType ?? "note"}:** ${renderChildren(node, options, depth)}`, "> ");
    case "rule":
      return "---";
    case "table":
      return renderTable(node, options);
    case "mediaSingle":
    case "mediaGroup":
      return (node.content ?? []).map(mediaLabel).join(" ") || "[attachment]";
    case "expand":
    case "nestedExpand":
      return [node.attrs?.title ? `**${node.attrs.title}**` : "", renderChildren(node, options, depth)]
        .filter(Boolean)
        .join("\n\n");
    case "text":
    case "hardBreak":
    case "mention":
    case "emoji":
    case "inlineCard":
    case "blockCard":
    case "embedCard":
    case "status":
    case "date":
    case "media":
      return renderInlineNode(node);
    default:
      // Unknown node: keep whatever text it contains rather than failing. Inline-only
      // children must not be split into separate paragraphs.
      if (!node.content) {
        return node.text ?? "";
      }
      return node.content.every(isInline) ? renderInline(node.content) : renderChildren(node, options, depth);
  }
}

const INLINE_TYPES = new Set([
  "text",
  "hardBreak",
  "mention",
  "emoji",
  "inlineCard",
  "status",
  "date",
  "mediaInline",
  "placeholder"
]);

/**
 * Whether the node holds inline content instead of nested blocks.
 *
 * @param node ADF node.
 * @returns True for inline node types.
 */
function isInline(node: AdfNode): boolean {
  return INLINE_TYPES.has(node.type ?? "");
}

const NESTED_LIST_TYPES = new Set(["bulletList", "orderedList", "taskList", "decisionList"]);

/**
 * Returns the bullet for a list item: number, task checkbox, decision mark or dash.
 *
 * @param node The list node.
 * @param item The list item.
 * @param index Item number, used by ordered lists.
 * @returns Bullet or number prefix, e.g. "-", "3." or "- [x]".
 */
function listBullet(node: AdfNode, item: AdfNode, index: number): string {
  switch (node.type) {
    case "orderedList":
      return `${index}.`;
    case "taskList":
      return item.attrs?.state === "DONE" ? "- [x]" : "- [ ]";
    case "decisionList":
      return "- ✓";
    default:
      return "-";
  }
}

/**
 * Renders a bullet, ordered, task or decision list, nesting by depth.
 *
 * @param node List node.
 * @param options Rendering options.
 * @param depth Nesting depth, two spaces of indent per level.
 * @returns Markdown list.
 */
function renderList(node: AdfNode, options: AdfOptions, depth: number): string {
  const indent = "  ".repeat(depth);
  let index = Number(node.attrs?.order ?? 1);

  return (node.content ?? [])
    .map((item) => {
      const bullet = listBullet(node, item, index++);
      const children = item.content ?? [];
      // taskItem / decisionItem hold inline content directly instead of paragraphs.
      const parts = children.every(isInline)
        ? [renderInline(children)]
        : children.map((child) =>
            NESTED_LIST_TYPES.has(child.type ?? "")
              ? renderList(child, options, depth + 1)
              : indentTail(renderBlock(child, options, depth + 1), `${indent}  `)
          );
      const [first = "", ...rest] = parts;
      // Continuation blocks (a second paragraph, a code block) stay indented under their bullet.
      const continued = rest.map((part, i) =>
        NESTED_LIST_TYPES.has(children[i + 1]?.type ?? "") ? part : `${indent}  ${part}`
      );
      return [`${indent}${bullet} ${first}`, ...continued].join("\n");
    })
    .join("\n");
}

/**
 * Renders an ADF table as a Markdown table, using the first row as the header.
 *
 * @param node Table node.
 * @param options Rendering options.
 * @returns Markdown table, empty string when there are no rows.
 */
function renderTable(node: AdfNode, options: AdfOptions): string {
  const rows = (node.content ?? []).map((row) =>
    (row.content ?? []).map((cell) => renderChildren(cell, options, 0, " ").replace(/\n+/g, " ").replace(/\|/g, "\\|"))
  );

  if (!rows.length) {
    return "";
  }

  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;

  return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

/**
 * Indents every line but the first, which follows the bullet or the caller's own indent.
 *
 * @param text Multi-line text.
 * @param prefix Indent added after each line break.
 * @returns Text with the continuation lines indented.
 */
function indentTail(text: string, prefix: string): string {
  return text.replace(/\n/g, `\n${prefix}`);
}

/**
 * Adds a prefix to every line of the text.
 *
 * @param text Multi-line text.
 * @param prefix String put in front of each line.
 * @returns Text with every line prefixed.
 */
function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

/**
 * Whether the text starts like pasted JSON or XML.
 *
 * @param text Text to inspect.
 * @returns True when the trimmed text starts with a JSON bracket or an XML tag.
 */
function looksLikePayload(text: string): boolean {
  const trimmed = text.trim();
  return /^[[{]/.test(trimmed) || /^<[?a-zA-Z]/.test(trimmed);
}

/**
 * Pasted request/response payloads dominate comment size; keep a preview only.
 *
 * @param text Block text.
 * @param options Size limits and the full flag.
 * @param isCode Collapse any long text, not only JSON/XML-looking ones.
 * @returns The original text, or a short preview with the omitted size.
 */
function collapseIfPayload(text: string, options: AdfOptions, isCode = false): string {
  const maxChars = options.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;

  if (options.full || text.length <= maxChars || (!isCode && !looksLikePayload(text))) {
    return text;
  }

  const preview = text.slice(0, options.previewChars ?? DEFAULT_PREVIEW_CHARS);
  const expandHint = options.commentId ? `full:true, commentId:${options.commentId}` : "full:true";
  return `${preview}\n… [collapsed ${text.length - preview.length} chars; ${expandHint}]`;
}

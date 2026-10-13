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

const DEFAULT_MAX_BLOCK_CHARS = 500;
const DEFAULT_PREVIEW_CHARS = 300;

export function isAdf(value: unknown): value is AdfNode {
  return !!value && typeof value === "object" && (value as AdfNode).type === "doc";
}

export function adfToMarkdown(node: unknown, options: AdfOptions = {}): string {
  if (node === null || node === undefined) {
    return "";
  }

  if (typeof node === "string") {
    return node;
  }

  return renderBlock(node, options, 0)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderChildren(node: AdfNode, options: AdfOptions, depth: number, separator = "\n\n"): string {
  return (node.content ?? [])
    .map((child) => renderBlock(child, options, depth))
    .filter((part) => part !== "")
    .join(separator);
}

function renderInline(nodes: AdfNode[] | undefined): string {
  return (nodes ?? []).map(renderInlineNode).join("");
}

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

// Media nodes carry the media-service id, not the Jira attachment id, so the label
// points at jira_list_attachments / jira_download_attachment instead of the raw id.
function mediaLabel(node: AdfNode): string {
  if (node.type !== "media" && node.type !== "mediaInline") {
    return renderInline(node.content);
  }

  const name = node.attrs?.alt || node.attrs?.filename;
  return `[attachment${name ? `: ${name}` : ""} — use jira_list_attachments / jira_download_attachment]`;
}

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

function renderBlock(node: AdfNode, options: AdfOptions, depth: number): string {
  switch (node.type) {
    case "doc":
      return renderChildren(node, options, depth);
    case "paragraph":
      return collapseIfPayload(renderInline(node.content), options);
    case "heading":
      return `${"#".repeat(Math.min(Number(node.attrs?.level ?? 1), 6))} ${renderInline(node.content)}`;
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

function isInline(node: AdfNode): boolean {
  return INLINE_TYPES.has(node.type ?? "");
}

const NESTED_LIST_TYPES = new Set(["bulletList", "orderedList", "taskList", "decisionList"]);

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

// Indents every line but the first, which follows the bullet or the caller's own indent.
function indentTail(text: string, prefix: string): string {
  return text.replace(/\n/g, `\n${prefix}`);
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function looksLikePayload(text: string): boolean {
  const trimmed = text.trim();
  return /^[[{]/.test(trimmed) || /^<[?a-zA-Z]/.test(trimmed);
}

// Pasted request/response payloads dominate comment size; keep a preview only.
function collapseIfPayload(text: string, options: AdfOptions, isCode = false): string {
  const maxChars = options.maxBlockChars ?? DEFAULT_MAX_BLOCK_CHARS;

  if (options.full || text.length <= maxChars || (!isCode && !looksLikePayload(text))) {
    return text;
  }

  const preview = text.slice(0, options.previewChars ?? DEFAULT_PREVIEW_CHARS);
  const expandHint = options.commentId ? `full:true, commentId:${options.commentId}` : "full:true";
  return `${preview}\n… [collapsed ${text.length - preview.length} chars; ${expandHint}]`;
}

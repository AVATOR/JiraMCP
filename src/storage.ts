// Converts Confluence storage format (XHTML with ac:/ri: macro elements) into compact Markdown.

type StorageNode = {
  tag?: string;
  attrs: Record<string, string>;
  children: StorageNode[];
  text?: string;
};

const VOID_TAGS = new Set(["br", "hr", "img", "col", "input", "meta", "link"]);
const BLOCK_TAGS = new Set(["p", "div", "section", "article", "ac:layout", "ac:layout-section", "ac:layout-cell"]);
const LIST_TAGS = new Set(["ul", "ol", "ac:task-list"]);
const PANEL_MACROS = new Set(["info", "note", "warning", "tip", "panel"]);
const SILENT_MACROS = new Set([
  "toc",
  "anchor",
  "children",
  "pagetree",
  "recently-updated",
  "attachments",
  "contributors"
]);

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  rarr: "→",
  larr: "←",
  harr: "↔",
  uarr: "↑",
  darr: "↓",
  bull: "•",
  middot: "·",
  times: "×",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€"
};

/**
 * Decodes named and numeric HTML entities; unknown ones are left as they are.
 *
 * @param text Text that may contain HTML entities.
 * @returns Text with entities replaced by characters.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }

    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

const TOKEN =
  /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\/([\w:-]+)\s*>|<([\w:-]+)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>|([^<]+)|</g;
const ATTR = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;

/**
 * Tolerant parser: storage is meant to be well-formed XML, but unmatched tags must not lose text.
 *
 * @param source Confluence storage-format XML.
 * @returns Root node of the parsed tree.
 */
function parse(source: string): StorageNode {
  const root: StorageNode = { tag: "#root", attrs: {}, children: [] };
  const stack: StorageNode[] = [root];

  for (const match of source.matchAll(TOKEN)) {
    const [whole, cdata, closing, opening, rawAttrs, selfClosing, text] = match;
    const parent = stack[stack.length - 1];

    if (cdata !== undefined) {
      parent.children.push({ attrs: {}, children: [], text: cdata });
    } else if (closing) {
      const name = closing.toLowerCase();
      const index = stack.map((node) => node.tag).lastIndexOf(name);
      if (index > 0) {
        stack.length = index;
      }
    } else if (opening) {
      const attrs: Record<string, string> = {};
      for (const [, key, double, single, bare] of (rawAttrs ?? "").matchAll(ATTR)) {
        attrs[key.toLowerCase()] = decodeEntities(double ?? single ?? bare ?? "");
      }

      const node: StorageNode = { tag: opening.toLowerCase(), attrs, children: [] };
      parent.children.push(node);
      if (!selfClosing && !VOID_TAGS.has(node.tag!)) {
        stack.push(node);
      }
    } else if (text !== undefined || whole === "<") {
      parent.children.push({ attrs: {}, children: [], text: decodeEntities(text ?? whole) });
    }
  }

  return root;
}

/**
 * Returns the first direct child with the given tag.
 *
 * @param node Parent node.
 * @param tag Tag name to find.
 * @returns First matching child, or undefined.
 */
function child(node: StorageNode, tag: string): StorageNode | undefined {
  return node.children.find((entry) => entry.tag === tag);
}

/**
 * Returns the text of a macro parameter (ac:parameter) by name.
 *
 * @param node Macro node.
 * @param name Parameter name.
 * @returns Parameter text, or undefined.
 */
function macroParam(node: StorageNode, name: string): string | undefined {
  const param = node.children.find((entry) => entry.tag === "ac:parameter" && entry.attrs["ac:name"] === name);
  return param ? textContent(param) : undefined;
}

/**
 * Concatenates the plain text of a node and all its descendants.
 *
 * @param node Any node.
 * @returns Concatenated plain text.
 */
function textContent(node: StorageNode): string {
  return node.text ?? node.children.map(textContent).join("");
}

/**
 * Renders all children of a node and concatenates them.
 *
 * @param node Parent node.
 * @param depth List nesting depth.
 * @returns Rendered children, concatenated.
 */
function renderChildren(node: StorageNode, depth: number): string {
  return node.children.map((entry) => render(entry, depth)).join("");
}

/**
 * Wraps text as a paragraph-level block, or returns "" when it is blank.
 *
 * @param text Text to wrap.
 * @returns Text surrounded by blank lines, or an empty string.
 */
function block(text: string): string {
  const trimmed = text.trim();
  return trimmed ? `\n\n${trimmed}\n\n` : "";
}

/**
 * Wraps text in an inline marker such as ** or _, keeping edge whitespace outside it.
 *
 * @param text Text to decorate.
 * @param marker Markdown marker such as ** or *.
 * @returns Text with the marker around its trimmed content.
 */
function wrap(text: string, marker: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  // Keep surrounding spaces outside the markers, or Markdown stops recognizing them.
  const lead = text.match(/^\s*/)![0];
  const trail = text.match(/\s*$/)![0];
  return `${lead}${marker}${trimmed}${marker}${trail}`;
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
 * Renders one storage node (element or text) as Markdown.
 *
 * @param node Element or text node.
 * @param depth List nesting depth.
 * @returns Markdown for the node.
 */
function render(node: StorageNode, depth: number): string {
  if (node.text !== undefined) {
    return node.text.replace(/\s+/g, " ");
  }

  const tag = node.tag ?? "";

  if (/^h[1-6]$/.test(tag)) {
    return block(`${"#".repeat(Number(tag[1]))} ${renderChildren(node, depth).trim()}`);
  }

  if (LIST_TAGS.has(tag)) {
    return `\n\n${renderList(node, depth)}\n\n`;
  }

  if (BLOCK_TAGS.has(tag)) {
    return block(renderChildren(node, depth));
  }

  switch (tag) {
    case "#root":
      return renderChildren(node, depth);
    case "br":
      return "\n";
    case "hr":
      return "\n\n---\n\n";
    case "strong":
    case "b":
      return wrap(renderChildren(node, depth), "**");
    case "em":
    case "i":
      return wrap(renderChildren(node, depth), "*");
    case "s":
    case "del":
      return wrap(renderChildren(node, depth), "~~");
    case "code":
      return wrap(renderChildren(node, depth), "`");
    case "pre":
      return block(`\`\`\`\n${textContent(node).trim()}\n\`\`\``);
    case "blockquote":
      return block(prefixLines(renderChildren(node, depth).trim(), "> "));
    case "a": {
      const label = renderChildren(node, depth).trim();
      const href = node.attrs.href;
      return href && href !== label ? `[${label || href}](${href})` : label;
    }
    case "img":
      return `[image${node.attrs.alt ? `: ${node.attrs.alt}` : ""}]`;
    case "time":
      return node.attrs.datetime ?? renderChildren(node, depth);
    case "table":
      return block(renderTable(node));
    case "ac:structured-macro":
    case "ac:macro":
      return renderMacro(node, depth);
    case "ac:image":
      return renderImage(node);
    case "ac:link":
      return renderLink(node);
    case "ac:emoticon":
      return node.attrs["ac:emoji-fallback"] ?? "";
    case "ac:parameter":
    case "ac:placeholder":
    case "ri:attachment":
    case "ri:page":
    case "ri:user":
    case "ri:url":
    case "colgroup":
      return "";
    default:
      // Unknown or purely presentational element (span, u, ac:inline-comment-marker…): keep its text.
      return renderChildren(node, depth);
  }
}

/**
 * Renders an ac:structured-macro: code, panels, expand and others by name.
 *
 * @param node ac:structured-macro element.
 * @param depth List nesting depth.
 * @returns Markdown for the macro; empty for ones without useful content.
 */
function renderMacro(node: StorageNode, depth: number): string {
  const name = node.attrs["ac:name"] ?? "";
  const body = child(node, "ac:rich-text-body");
  const plainBody = child(node, "ac:plain-text-body");

  if (name === "code" || name === "noformat") {
    const language = macroParam(node, "language") ?? "";
    return block(`\`\`\`${language}\n${(plainBody ? textContent(plainBody) : "").replace(/^\n+|\s+$/g, "")}\n\`\`\``);
  }

  if (PANEL_MACROS.has(name)) {
    const title = macroParam(node, "title");
    const content = body ? renderChildren(body, depth).trim() : "";
    return block(prefixLines(`**${title ?? name}:** ${content}`, "> "));
  }

  if (name === "expand") {
    const title = macroParam(node, "title");
    return block(
      [title ? `**${title}**` : "", body ? renderChildren(body, depth).trim() : ""].filter(Boolean).join("\n\n")
    );
  }

  if (name === "jira") {
    return macroParam(node, "key") ?? "[jira issues]";
  }

  if (name === "status") {
    return `[${macroParam(node, "title") ?? ""}]`;
  }

  if (SILENT_MACROS.has(name)) {
    return "";
  }

  if (body) {
    return block(renderChildren(body, depth));
  }

  if (plainBody) {
    return block(`\`\`\`\n${textContent(plainBody).trim()}\n\`\`\``);
  }

  return `[macro: ${name}]`;
}

/**
 * Page images live in Confluence, not on a Jira issue, so they are only labelled.
 *
 * @param node ac:image element.
 * @returns Placeholder such as "[image: name — caption]".
 */
function renderImage(node: StorageNode): string {
  const attachment = child(node, "ri:attachment");
  const url = child(node, "ri:url");
  const caption = child(node, "ac:caption");
  const source = attachment?.attrs["ri:filename"] ?? url?.attrs["ri:value"] ?? node.attrs["ac:alt"] ?? "";
  const captionText = caption ? textContent(caption).trim() : "";
  return `[image${source ? `: ${source}` : ""}${captionText ? ` — ${captionText}` : ""}]`;
}

/**
 * Renders an ac:link to a page, attachment, user or anchor as its label.
 *
 * @param node ac:link element.
 * @returns The link label, or a bracketed placeholder.
 */
function renderLink(node: StorageNode): string {
  const body = child(node, "ac:link-body") ?? child(node, "ac:plain-text-link-body");
  const label = body ? textContent(body).trim() : "";
  const page = child(node, "ri:page");
  const attachment = child(node, "ri:attachment");

  if (page) {
    return label || `[page: ${page.attrs["ri:content-title"] ?? ""}]`;
  }

  if (attachment) {
    return label || `[attachment: ${attachment.attrs["ri:filename"] ?? ""}]`;
  }

  if (child(node, "ri:user")) {
    // Storage only carries the account id, which means nothing to a reader.
    return label ? `@${label}` : "@user";
  }

  return label || (node.attrs["ac:anchor"] ? `#${node.attrs["ac:anchor"]}` : "");
}

/**
 * Renders ul, ol and task lists, nesting by depth.
 *
 * @param node ul, ol or task-list element.
 * @param depth Nesting depth.
 * @returns Markdown list.
 */
function renderList(node: StorageNode, depth: number): string {
  const indent = "  ".repeat(depth);
  const items = node.children.filter((entry) => entry.tag === "li" || entry.tag === "ac:task");
  let index = Number(node.attrs.start ?? 1);

  return items
    .map((item) => {
      let bullet = node.tag === "ol" ? `${index++}.` : "-";
      let children = item.children;

      if (item.tag === "ac:task") {
        const status = child(item, "ac:task-status");
        bullet = status && textContent(status).trim() === "complete" ? "- [x]" : "- [ ]";
        children = child(item, "ac:task-body")?.children ?? [];
      }

      // Split the item into runs of inline/paragraph content and nested lists, so nested
      // lists keep their own indentation while text continuation lines stay under the bullet.
      const parts: string[] = [];
      let text = "";
      const flush = () => {
        const cleaned = text
          .replace(/[ \t]*\n[ \t]*/g, "\n")
          .replace(/\n{2,}/g, "\n")
          .trim();
        if (cleaned) {
          parts.push(cleaned.replace(/\n/g, `\n${indent}  `));
        }
        text = "";
      };

      for (const entry of children) {
        if (entry.tag && LIST_TAGS.has(entry.tag)) {
          flush();
          parts.push(`\u0000${renderList(entry, depth + 1)}`);
        } else {
          text += render(entry, depth + 1);
        }
      }
      flush();

      const [first = "", ...rest] = parts;
      const head = first.startsWith("\u0000") ? `${indent}${bullet}\n${first.slice(1)}` : `${indent}${bullet} ${first}`;
      return [head, ...rest.map((part) => (part.startsWith("\u0000") ? part.slice(1) : `${indent}  ${part}`))].join(
        "\n"
      );
    })
    .join("\n");
}

/**
 * Renders a storage table as a Markdown table, using the first row as the header.
 *
 * @param node table element.
 * @returns Markdown table, empty string when there are no rows.
 */
function renderTable(node: StorageNode): string {
  const rows: string[][] = [];

  const collect = (entry: StorageNode) => {
    if (entry.tag === "tr") {
      rows.push(
        entry.children
          .filter((cell) => cell.tag === "td" || cell.tag === "th")
          .map((cell) =>
            renderChildren(cell, 0)
              .replace(/\s*\n\s*/g, " ")
              .trim()
              .replace(/\|/g, "\\|")
          )
      );
    } else {
      entry.children.forEach(collect);
    }
  };
  collect(node);

  if (!rows.length) {
    return "";
  }

  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) => `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  return [line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

/**
 * Converts Confluence storage format (XHTML with ac:/ri: tags) to Markdown.
 *
 * @param source Confluence storage-format body.
 * @returns Trimmed Markdown.
 */
export function storageToMarkdown(source: string): string {
  return render(parse(source), 0)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

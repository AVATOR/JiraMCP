import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatConfluenceAttachments,
  formatConfluenceChildren,
  formatConfluenceComments,
  formatConfluenceVersions,
  formatConfluencePage,
  formatConfluenceSearch,
  formatConfluenceSpacePages,
  formatConfluenceSpaces,
  formatConfluenceTree,
  buildPageTree
} from "../compact/index.js";
import type { ConfluenceClient } from "../confluence-client.js";
import {
  childrenData,
  childrenOutput,
  confluenceAttachmentsData,
  confluenceAttachmentsOutput,
  confluenceCommentsData,
  confluenceCommentsOutput,
  confluenceSearchData,
  confluenceSearchOutput,
  pageData,
  pageDiffOutput,
  pageOutput,
  spacePagesData,
  spacePagesOutput,
  spacesData,
  spacesOutput,
  spaceTreeOutput,
  versionsData,
  versionsOutput
} from "../structured.js";
import { diffLines, formatDiff } from "../diff.js";
import { nextCursor } from "../query.js";
import { storageToMarkdown } from "../storage.js";
import { limitParam, matchesQuery, rawFlag, READ_ONLY_ANNOTATIONS, respond } from "./shared.js";

/**
 * Registers the read-only Confluence tools.
 *
 * @param server MCP server to add the tools to.
 * @param client Confluence client the tools read through.
 */
export function registerConfluenceTools(server: McpServer, client: ConfluenceClient) {
  const pageIdParam = z
    .string()
    .min(1)
    .describe("Page id, page URL (…/pages/123/Title), or exact title (then pass spaceKey).");
  const spaceKeyParam = z.string().min(1).optional().describe("Space key, to look a page up by title.");
  const cursorParam = z.string().optional().describe("Cursor from the previous result, to fetch the next page.");

  server.registerTool(
    "confluence_get_page",
    {
      title: "Get Confluence page",
      description:
        "Fetch a Confluence page as Markdown in read-only mode, with its labels and path. The page can be given " +
        "by id, by URL or by exact title (with spaceKey).",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: pageOutput,
      inputSchema: {
        pageId: pageIdParam,
        spaceKey: spaceKeyParam,
        raw: rawFlag
      }
    },
    async ({ pageId, spaceKey, raw }) => {
      const id = await client.resolvePageId(pageId, spaceKey);
      const page = await client.getPage(id);

      // The path is a nicety: a failure here must not hide the page itself.
      const ancestors = await client.getAncestors(id).catch(() => []);
      return respond(raw, page, (value) => formatConfluencePage(value, client.baseUrl, ancestors), {
        structured: pageData(page, client.baseUrl, ancestors)
      });
    }
  );

  server.registerTool(
    "confluence_get_page_children",
    {
      title: "Get Confluence child pages",
      description: "List the direct child pages of a page (to walk the page tree).",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: childrenOutput,
      inputSchema: {
        pageId: pageIdParam,
        spaceKey: spaceKeyParam,
        limit: limitParam(250, 50, "pages"),
        cursor: cursorParam,
        raw: rawFlag
      }
    },
    async ({ pageId, spaceKey, limit, cursor, raw }) => {
      const id = await client.resolvePageId(pageId, spaceKey);
      const result = await client.getChildren(id, limit ?? 50, cursor);
      return respond(raw, result, (page) => formatConfluenceChildren(page, id), {
        structured: childrenData(result, id)
      });
    }
  );

  server.registerTool(
    "confluence_get_page_comments",
    {
      title: "Get Confluence page comments",
      description: "Comments of a page as Markdown: footer (default) or inline (anchored to text) comments.",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: confluenceCommentsOutput,
      inputSchema: {
        pageId: pageIdParam,
        spaceKey: spaceKeyParam,
        kind: z.enum(["footer", "inline"]).optional().describe("footer (default) or inline comments."),
        limit: limitParam(100, 25, "comments"),
        cursor: cursorParam,
        raw: rawFlag
      }
    },
    async ({ pageId, spaceKey, kind, limit, cursor, raw }) => {
      const id = await client.resolvePageId(pageId, spaceKey);
      const resolvedKind = kind ?? "footer";
      const result = await client.getComments(id, resolvedKind, limit ?? 25, cursor);

      const view = { pageId: id, kind: resolvedKind, cursor: nextCursor(result?._links) };
      return respond(raw, result, (page) => formatConfluenceComments(page?.results ?? [], view), {
        structured: confluenceCommentsData(result?.results ?? [], view)
      });
    }
  );

  server.registerTool(
    "confluence_list_attachments",
    {
      title: "List Confluence attachments",
      description: "List the files attached to a page, with the ids needed by confluence_download_attachment.",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: confluenceAttachmentsOutput,
      inputSchema: {
        pageId: pageIdParam,
        spaceKey: spaceKeyParam,
        limit: limitParam(250, 50, "attachments"),
        cursor: cursorParam,
        raw: rawFlag
      }
    },
    async ({ pageId, spaceKey, limit, cursor, raw }) => {
      const id = await client.resolvePageId(pageId, spaceKey);
      const result = await client.getAttachments(id, limit ?? 50, cursor);
      return respond(raw, result, (page) => formatConfluenceAttachments(page, id), {
        structured: confluenceAttachmentsData(result, id)
      });
    }
  );

  server.registerTool(
    "confluence_get_page_versions",
    {
      title: "Get Confluence page versions",
      description: "Version history of a page: number, date, author id and change message, newest first.",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: versionsOutput,
      inputSchema: {
        pageId: pageIdParam,
        spaceKey: spaceKeyParam,
        limit: limitParam(100, 25, "versions"),
        cursor: cursorParam,
        raw: rawFlag
      }
    },
    async ({ pageId, spaceKey, limit, cursor, raw }) => {
      const id = await client.resolvePageId(pageId, spaceKey);
      const result = await client.getVersions(id, limit ?? 25, cursor);
      return respond(raw, result, (page) => formatConfluenceVersions(page, id), {
        structured: versionsData(result, id)
      });
    }
  );

  server.registerTool(
    "confluence_search_pages",
    {
      title: "Search Confluence pages",
      description:
        "Full-text search of Confluence pages (title and body), newest first. Use titleOnly to match titles only, " +
        "spaceKey to stay within one space, labels to require page labels and contributor (an account id from " +
        "jira_find_users) to find pages somebody edited. At least one of query, labels, contributor is needed.",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: confluenceSearchOutput,
      inputSchema: {
        query: z.string().min(1).optional().describe("Words to look for in the page title or body"),
        labels: z.array(z.string().min(1)).max(10).optional().describe("Page labels; a page must carry all of them."),
        contributor: z.string().min(1).optional().describe("Account id of a user who created or edited the page."),
        spaceKey: z.string().min(1).optional().describe("Only search this space (e.g., 'MS')."),
        titleOnly: z.boolean().optional().describe("Match page titles only, not the body."),
        limit: limitParam(100, 25, "pages"),
        cursor: cursorParam,
        raw: rawFlag
      }
    },
    async ({ query, labels, contributor, spaceKey, titleOnly, limit, cursor, raw }) => {
      const result = await client.searchPages({
        query,
        labels,
        contributor,
        spaceKey,
        titleOnly,
        limit: limit ?? 25,
        cursor
      });
      return respond(raw, result, formatConfluenceSearch, { structured: confluenceSearchData(result) });
    }
  );

  server.registerTool(
    "confluence_get_space_tree",
    {
      title: "Get Confluence space page tree",
      description:
        "The page hierarchy of a space as an indented list with page ids, built in one call from the parent ids " +
        "(instead of walking confluence_get_page_children page by page).",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: spaceTreeOutput,
      inputSchema: {
        spaceKey: z.string().min(1).describe("The space key (e.g., 'MS')"),
        depth: z.number().int().min(1).max(10).optional().describe("Levels to show (default 3)."),
        maxPages: z.number().int().min(1).max(1000).optional().describe("Read at most this many pages (default 300)."),
        raw: rawFlag
      }
    },
    async ({ spaceKey, depth, maxPages, raw }) => {
      const { pages, truncated } = await client.getSpaceTree(spaceKey, maxPages ?? 300);
      const tree = buildPageTree(pages, depth ?? 3);
      return respond(raw, pages, () => formatConfluenceTree(tree, { spaceKey, truncated }), {
        structured: {
          spaceKey,
          truncated,
          hidden: tree.hidden,
          pages: tree.nodes
        }
      });
    }
  );

  server.registerTool(
    "confluence_get_page_diff",
    {
      title: "Compare Confluence page versions",
      description:
        "What changed between two versions of a page, as a line diff of the Markdown text. Defaults to the latest " +
        "version against the one before it; list versions with confluence_get_page_versions.",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: pageDiffOutput,
      inputSchema: {
        pageId: pageIdParam,
        spaceKey: spaceKeyParam,
        fromVersion: z.number().int().min(1).optional().describe("Older version (default: the one before toVersion)."),
        toVersion: z.number().int().min(1).optional().describe("Newer version (default: the latest)."),
        context: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe("Unchanged lines kept around changes (default 2)."),
        raw: rawFlag
      }
    },
    async ({ pageId, spaceKey, fromVersion, toVersion, context, raw }) => {
      const id = await client.resolvePageId(pageId, spaceKey);
      const latest = await client.getPage(id);
      const to = toVersion ?? latest.version?.number ?? 1;
      const from = fromVersion ?? to - 1;

      if (from < 1 || from >= to) {
        throw new Error(`Nothing to compare: fromVersion must be at least 1 and lower than toVersion (${to})`);
      }

      const [older, newer] = await Promise.all([
        client.getPageVersion(id, from),
        to === latest.version?.number ? latest : client.getPageVersion(id, to)
      ]);
      const lines = (page: typeof latest) => storageToMarkdown(page.body?.storage?.value ?? "").split("\n");
      const changes = diffLines(lines(older), lines(newer));
      const added = changes.filter((line) => line.op === "+").length;
      const removed = changes.filter((line) => line.op === "-").length;
      const body = formatDiff(changes, context ?? 2);
      const data = {
        pageId: id,
        title: newer.title,
        fromVersion: from,
        toVersion: to,
        added,
        removed,
        diff: body
      };
      const meta = (page: typeof latest, number: number) =>
        `v${number}${page.version?.createdAt ? ` (${page.version.createdAt.slice(0, 10)}${page.version.authorId ? `, ${page.version.authorId}` : ""})` : ""}`;
      const render = () =>
        [
          `${newer.title ?? id} (${id}): ${meta(older, from)} → ${meta(newer, to)} — +${added} −${removed} lines`,
          ...(newer.version?.message ? [`Change message: ${newer.version.message}`] : []),
          "",
          body ? `\`\`\`\`diff\n${body}\n\`\`\`\`` : "_No textual changes._"
        ].join("\n");

      return respond(raw, data, render, { structured: data });
    }
  );

  server.registerTool(
    "confluence_get_space_pages",
    {
      title: "Get Confluence space pages",
      description: "List pages in a Confluence space, most recently modified first.",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: spacePagesOutput,
      inputSchema: {
        spaceKey: z.string().min(1).describe("The space key (e.g., 'MS')"),
        limit: limitParam(250, 50, "pages"),
        cursor: cursorParam,
        raw: rawFlag
      }
    },
    async ({ spaceKey, limit, cursor, raw }) => {
      const result = await client.getSpacePages(spaceKey, limit ?? 50, cursor);
      return respond(raw, result, (page) => formatConfluenceSpacePages(page, spaceKey), {
        structured: spacePagesData(result, spaceKey)
      });
    }
  );

  server.registerTool(
    "confluence_list_spaces",
    {
      title: "List Confluence spaces",
      description:
        "List the Confluence spaces the user can see, with their keys (for confluence_get_space_pages and " +
        "confluence_search_pages). Filter by name or key with query.",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: spacesOutput,
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive text the space name or key must contain."),
        type: z.enum(["global", "personal"]).optional().describe("Only spaces of this type."),
        limit: limitParam(200, 50, "spaces"),
        raw: rawFlag
      }
    },
    async ({ query, type, limit, raw }) => {
      const matches = (await client.getSpaces()).filter(
        (space) => (!type || space.type === type) && matchesQuery(query, space.name, space.key)
      );
      const shown = matches.slice(0, limit ?? 50);
      return respond(raw, shown, (items) => formatConfluenceSpaces(items, matches.length), {
        untrusted: false,
        structured: spacesData(shown, matches.length)
      });
    }
  );
}

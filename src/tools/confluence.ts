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
  formatConfluenceSpaces
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
  pageOutput,
  spacePagesData,
  spacePagesOutput,
  spacesData,
  spacesOutput,
  versionsData,
  versionsOutput
} from "../structured.js";
import { nextCursor } from "../query.js";
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
        "Full-text search of Confluence pages (title and body), newest first. Use titleOnly to match titles only " +
        "and spaceKey to stay within one space.",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: confluenceSearchOutput,
      inputSchema: {
        query: z.string().min(1).describe("Words to look for in the page title or body"),
        spaceKey: z.string().min(1).optional().describe("Only search this space (e.g., 'MS')."),
        titleOnly: z.boolean().optional().describe("Match page titles only, not the body."),
        limit: limitParam(100, 25, "pages"),
        cursor: cursorParam,
        raw: rawFlag
      }
    },
    async ({ query, spaceKey, titleOnly, limit, cursor, raw }) => {
      const result = await client.searchPages({ query, spaceKey, titleOnly, limit: limit ?? 25, cursor });
      return respond(raw, result, formatConfluenceSearch, { structured: confluenceSearchData(result) });
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

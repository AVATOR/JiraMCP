import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatConfluencePage,
  formatConfluenceSearch,
  formatConfluenceSpacePages,
  formatConfluenceSpaces
} from "../compact.js";
import type { ConfluenceClient } from "../confluence-client.js";
import { matchesQuery, rawFlag, READ_ONLY_ANNOTATIONS, toMarkdownResult, toTextResult } from "./shared.js";

/**
 * Registers the read-only Confluence tools.
 *
 * @param server MCP server to add the tools to.
 * @param client Confluence client the tools read through.
 */
export function registerConfluenceTools(server: McpServer, client: ConfluenceClient) {
  server.registerTool(
    "confluence_get_page",
    {
      title: "Get Confluence page",
      description: "Fetch a Confluence page by ID as Markdown in read-only mode.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        pageId: z.string().min(1).describe("The ID of the Confluence page"),
        raw: rawFlag
      }
    },
    async ({ pageId, raw }) => {
      const page = await client.getPage(pageId);
      return raw ? toTextResult(page) : toMarkdownResult(formatConfluencePage(page, client.baseUrl));
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
      inputSchema: {
        query: z.string().min(1).describe("Words to look for in the page title or body"),
        spaceKey: z.string().min(1).optional().describe("Only search this space (e.g., 'MS')."),
        titleOnly: z.boolean().optional().describe("Match page titles only, not the body."),
        limit: z.number().int().min(1).max(100).optional().describe("Max pages to return (default 25)."),
        raw: rawFlag
      }
    },
    async ({ query, spaceKey, titleOnly, limit, raw }) => {
      const result = await client.searchPages({ query, spaceKey, titleOnly, limit: limit ?? 25 });
      return raw ? toTextResult(result) : toMarkdownResult(formatConfluenceSearch(result));
    }
  );

  server.registerTool(
    "confluence_get_space_pages",
    {
      title: "Get Confluence space pages",
      description: "List pages in a Confluence space, most recently modified first.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        spaceKey: z.string().min(1).describe("The space key (e.g., 'MS')"),
        limit: z.number().int().min(1).max(250).optional().describe("Max pages to return (default 50)."),
        cursor: z.string().optional().describe("Cursor from the previous result, to fetch the next page."),
        raw: rawFlag
      }
    },
    async ({ spaceKey, limit, cursor, raw }) => {
      const result = await client.getSpacePages(spaceKey, limit ?? 50, cursor);
      return raw ? toTextResult(result) : toMarkdownResult(formatConfluenceSpacePages(result, spaceKey));
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
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive text the space name or key must contain."),
        type: z.enum(["global", "personal"]).optional().describe("Only spaces of this type."),
        limit: z.number().int().min(1).max(200).optional().describe("Max spaces to return (default 50)."),
        raw: rawFlag
      }
    },
    async ({ query, type, limit, raw }) => {
      const matches = (await client.getSpaces()).filter(
        (space) => (!type || space.type === type) && matchesQuery(query, space.name, space.key)
      );
      const shown = matches.slice(0, limit ?? 50);
      return raw
        ? toTextResult(shown)
        : toMarkdownResult(formatConfluenceSpaces(shown, matches.length), { untrusted: false });
    }
  );
}

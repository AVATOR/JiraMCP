import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatChangelog, formatComments, formatIssue, formatRemoteLinks } from "../compact/index.js";
import type { ConfluenceClient } from "../confluence-client.js";
import type { JiraClient } from "../jira-client.js";
import { clip } from "../compact/common.js";
import { storageToMarkdown } from "../storage.js";
import {
  changelogData,
  changelogOutput,
  commentsData,
  commentsOutput,
  issueData,
  issueOutput,
  remoteLinksData,
  remoteLinksOutput
} from "../structured.js";
import type { JiraIssue } from "../types.js";
import { READ_ONLY_ANNOTATIONS, toMarkdownResult } from "./shared.js";

const SECTIONS = ["comments", "history", "links", "pages"] as const;
const PAGE_EXCERPT_CHARS = 700;

const contextOutput = {
  untrusted: z.boolean().optional(),
  issue: z.object(issueOutput),
  comments: z.object(commentsOutput).optional(),
  history: z.object(changelogOutput).optional(),
  remoteLinks: z.object(remoteLinksOutput).optional(),
  pages: z
    .array(z.object({ id: z.string(), title: z.string().optional(), url: z.string().optional(), excerpt: z.string() }))
    .optional(),
  notes: z.array(z.string())
};

/**
 * Finds the ids of Confluence pages that a text links to, in the order they first appear.
 *
 * @param text Any text, such as the JSON of an issue.
 * @param host Host of the Confluence site; links to other hosts are ignored.
 * @returns Distinct page ids.
 */
export function pageIdsIn(text: string, host: string): string[] {
  const ids: string[] = [];

  for (const match of text.matchAll(/https?:\/\/([^/\s"'\\)]+)\/wiki\/[^\s"'\\)]*?\/pages\/(\d+)/gi)) {
    if (match[1].toLowerCase() === host.toLowerCase() && !ids.includes(match[2])) {
      ids.push(match[2]);
    }
  }

  return ids;
}

/**
 * Registers the tool that gathers an issue with its discussion, history, links and linked wiki pages.
 *
 * @param server MCP server to add the tool to.
 * @param jira Jira client the tool reads through.
 * @param confluence Confluence client used for the pages the issue links to.
 */
export function registerContextTools(server: McpServer, jira: JiraClient, confluence: ConfluenceClient) {
  server.registerTool(
    "jira_get_issue_context",
    {
      title: "Get Jira issue with its context",
      description:
        "Everything needed to work on an issue in one call: the issue, its newest comments, recent history, " +
        "remote links (pull requests, documents) and an excerpt of the Confluence pages it links to. " +
        "Use `include` to leave sections out; use the single-purpose tools to read any part in full.",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: contextOutput,
      inputSchema: {
        issueKey: z.string().min(2),
        include: z
          .array(z.enum(SECTIONS))
          .optional()
          .describe("Sections to add to the issue: comments, history, links, pages (default: all)."),
        commentLimit: z.number().int().min(1).max(50).optional().describe("Newest comments to show (default 5)."),
        historyLimit: z.number().int().min(1).max(50).optional().describe("Latest changes to show (default 10)."),
        maxPages: z.number().int().min(1).max(5).optional().describe("Confluence pages to excerpt (default 3).")
      }
    },
    async ({ issueKey, include, commentLimit, historyLimit, maxPages }) => {
      const wanted = new Set(include ?? SECTIONS);
      const issue: JiraIssue = await jira.getIssue(issueKey);
      const notes: string[] = [];
      const parts = [formatIssue(issue, jira.customFields)];
      const structured: Record<string, unknown> = { issue: issueData(issue, jira.customFields) };

      /** Runs one optional section; a failure becomes a note instead of failing the whole call. */
      const section = async <T>(name: string, load: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await load();
        } catch (error) {
          notes.push(`${name} unavailable: ${(error as Error).message}`);
          return undefined;
        }
      };

      let remoteLinks: Awaited<ReturnType<JiraClient["getRemoteLinks"]>> = [];
      let commentsText = "";

      if (wanted.has("comments")) {
        const found = await section("Comments", () =>
          jira.findComments(issueKey, { limit: commentLimit ?? 5, order: "desc" })
        );

        if (found) {
          const view = { issueKey, total: found.total, order: "desc" as const, maxLength: 1500, full: false };
          parts.push("## Comments", formatComments(found.comments, view));
          structured.comments = commentsData(found.comments, view);
          commentsText = JSON.stringify(found.comments);
        }
      }

      if (wanted.has("history")) {
        const entries = await section("History", () => jira.getChangelog(issueKey));

        if (entries) {
          const matching = entries.filter((entry) => entry.items?.length).reverse();
          const shown = matching.slice(0, historyLimit ?? 10);
          parts.push("## History", formatChangelog(shown, { issueKey, total: matching.length }));
          structured.history = changelogData(shown, issueKey, matching.length);
        }
      }

      if (wanted.has("links") || wanted.has("pages")) {
        remoteLinks = (await section("Remote links", () => jira.getRemoteLinks(issueKey))) ?? [];

        if (wanted.has("links")) {
          parts.push("## Remote links", formatRemoteLinks(remoteLinks, issueKey));
          structured.remoteLinks = remoteLinksData(remoteLinks, issueKey);
        }
      }

      if (wanted.has("pages")) {
        const host = new URL(confluence.baseUrl).host;
        const text = JSON.stringify(remoteLinks) + JSON.stringify(issue.fields?.description ?? "") + commentsText;
        const ids = pageIdsIn(text, host).slice(0, maxPages ?? 3);
        const pages: { id: string; title?: string; url?: string; excerpt: string }[] = [];

        for (const id of ids) {
          const page = await section(`Page ${id}`, () => confluence.getPage(id));

          if (page) {
            const excerpt = clip(storageToMarkdown(page.body?.storage?.value ?? ""), PAGE_EXCERPT_CHARS);
            const url = page._links?.webui ? `${confluence.baseUrl}${page._links.webui}` : undefined;
            pages.push({ id, title: page.title, url, excerpt });
          }
        }

        if (pages.length) {
          parts.push(
            "## Linked Confluence pages",
            ...pages.map(
              (page) =>
                `### ${page.title ?? page.id} (${page.id})\n${page.url ?? ""}\n\n${page.excerpt}\n\n` +
                `_Excerpt: read the whole page with confluence_get_page._`
            )
          );
          structured.pages = pages;
        }
      }

      if (notes.length) {
        parts.push("## Notes", ...notes.map((note) => `- ${note}`));
      }

      structured.notes = notes;
      return { ...toMarkdownResult(parts.join("\n\n")), structuredContent: { ...structured, untrusted: true } };
    }
  );
}

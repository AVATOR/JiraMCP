import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { table } from "../compact/common.js";
import type { ConfluenceClient } from "../confluence-client.js";
import type { JiraClient } from "../jira-client.js";
import { READ_ONLY_ANNOTATIONS, rawFlag, respond } from "./shared.js";

const ISSUE_KEY = "[A-Z][A-Z0-9_]+-\\d+";
const MAX_PAGE_ISSUES = 50;

/**
 * Finds the Jira issue keys a Confluence page refers to, in order of appearance: keys of Jira issue
 * macros and /browse/ links are taken as they are, while keys that only appear in running text must
 * belong to a known project (otherwise "UTF-8" or "ISO-27001" would count as issues).
 *
 * @param storage Page body in storage format.
 * @param projectKeys Keys of the Jira projects that exist.
 * @returns Distinct issue keys.
 */
export function issueKeysIn(storage: string, projectKeys: ReadonlySet<string>): string[] {
  const found: { index: number; key: string }[] = [];
  const add = (pattern: RegExp, trusted: boolean) => {
    for (const match of storage.matchAll(pattern)) {
      const key = match[1];
      if (trusted || projectKeys.has(key.slice(0, key.lastIndexOf("-")))) {
        found.push({ index: match.index ?? 0, key });
      }
    }
  };

  add(new RegExp(`<ac:parameter[^>]*ac:name="key"[^>]*>\\s*(${ISSUE_KEY})\\s*</ac:parameter>`, "g"), true);
  add(new RegExp(`/browse/(${ISSUE_KEY})`, "g"), true);
  add(new RegExp(`\\b(${ISSUE_KEY})\\b`, "g"), false);

  return [...new Set(found.sort((a, b) => a.index - b.index).map((entry) => entry.key))];
}

const pageIssuesOutput = {
  untrusted: z.boolean().optional(),
  pageId: z.string(),
  title: z.string().optional(),
  issues: z.array(z.object({ key: z.string(), summary: z.string().optional(), status: z.string().optional() })),
  unresolved: z.array(z.string()),
  truncated: z.boolean()
};

/**
 * Registers the tools that connect Confluence pages to the Jira issues they mention.
 *
 * @param server MCP server to add the tool to.
 * @param jira Jira client used to resolve the issue keys.
 * @param confluence Confluence client the page is read through.
 */
export function registerLinkTools(server: McpServer, jira: JiraClient, confluence: ConfluenceClient) {
  server.registerTool(
    "confluence_get_page_issues",
    {
      title: "Get Jira issues a Confluence page refers to",
      description:
        "The Jira issues mentioned on a Confluence page (Jira issue macros, /browse/ links and issue keys in the " +
        "text) with their summary and status, so a spec or release page can be followed back to its tickets.",
      annotations: READ_ONLY_ANNOTATIONS,
      outputSchema: pageIssuesOutput,
      inputSchema: {
        pageId: z.string().min(1).describe("Page id, page URL, or exact title (then pass spaceKey)."),
        spaceKey: z.string().min(1).optional().describe("Space key, to look a page up by title."),
        raw: rawFlag
      }
    },
    async ({ pageId, spaceKey, raw }) => {
      const id = await confluence.resolvePageId(pageId, spaceKey);
      const page = await confluence.getPage(id);
      const projectKeys = new Set((await jira.getProjects()).map((project) => project.key ?? ""));
      const keys = issueKeysIn(page.body?.storage?.value ?? "", projectKeys);
      const shown = keys.slice(0, MAX_PAGE_ISSUES);
      let issues: { key: string; summary?: string; status?: string }[] = [];
      let unresolved: string[] = [];

      if (shown.length) {
        try {
          const result = await jira.searchIssues({
            jql: `key in (${shown.map((key) => `"${key}"`).join(", ")})`,
            maxResults: MAX_PAGE_ISSUES
          });
          issues = (result.issues ?? []).map((issue) => ({
            key: issue.key ?? "",
            summary: issue.fields?.summary,
            status: issue.fields?.status?.name
          }));
          const seen = new Set(issues.map((issue) => issue.key));
          unresolved = shown.filter((key) => !seen.has(key));
        } catch {
          // One key that no longer exists makes Jira refuse the whole query; the keys are still useful.
          unresolved = shown;
        }
      }

      const data = { pageId: id, title: page.title, issues, unresolved, truncated: keys.length > shown.length };
      const render = () =>
        [
          `${page.title ?? id} (${id}) — ${issues.length + unresolved.length} Jira issues referenced` +
            (data.truncated ? `, first ${MAX_PAGE_ISSUES} of ${keys.length}` : ""),
          ...(issues.length
            ? [
                "",
                table(
                  ["Key", "Summary", "Status"],
                  issues.map((issue) => [issue.key, issue.summary, issue.status])
                )
              ]
            : []),
          ...(unresolved.length ? ["", `Not found or not readable: ${unresolved.join(", ")}`] : [])
        ].join("\n");

      return respond(raw, data, render, { structured: data });
    }
  );
}

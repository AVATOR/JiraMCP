import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatAttachments,
  formatComment,
  formatComments,
  formatCurrentUser,
  formatFields,
  formatIssue,
  formatProjects,
  formatSearch,
  formatUsers
} from "../compact.js";
import type { JiraClient } from "../jira-client.js";
import {
  matchesQuery,
  nextPageTokenParam,
  rawFlag,
  READ_ONLY_ANNOTATIONS,
  toMarkdownResult,
  toTextResult
} from "./shared.js";

export function registerJiraTools(server: McpServer, client: JiraClient) {
  const customFieldsHint = client.customFields.length
    ? ` Returns these configured custom fields: ${client.customFields
        .map((field) => (field.alias === field.id ? field.id : `${field.alias} (${field.id})`))
        .join(", ")}.`
    : "";

  server.registerTool(
    "jira_get_issue",
    {
      title: "Get Jira issue",
      description: `Fetch a Jira issue by key in read-only mode.${customFieldsHint}`,
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        issueKey: z.string().min(2),
        raw: rawFlag
      }
    },
    async ({ issueKey, raw }) =>
      raw
        ? toTextResult(await client.getIssue(issueKey, true), client.customFields)
        : toMarkdownResult(formatIssue(await client.getIssue(issueKey), client.customFields))
  );

  server.registerTool(
    "jira_search_issues",
    {
      title: "Search Jira issues",
      description: "Run a JQL search against Jira in read-only mode.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        jql: z.string().min(1),
        maxResults: z.number().int().min(1).max(100).optional(),
        nextPageToken: nextPageTokenParam,
        raw: rawFlag
      }
    },
    async ({ jql, maxResults, nextPageToken, raw }) => {
      const result = await client.searchIssues({ jql, maxResults, nextPageToken });
      return raw ? toTextResult(result, client.customFields) : toMarkdownResult(formatSearch(result));
    }
  );

  server.registerTool(
    "jira_get_project_issues",
    {
      title: "Get Jira project issues",
      description: "List issues from a Jira project ordered by last update.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        projectKey: z.string().min(1).optional(),
        maxResults: z.number().int().min(1).max(100).optional(),
        nextPageToken: nextPageTokenParam,
        raw: rawFlag
      }
    },
    async ({ projectKey, maxResults, nextPageToken, raw }) => {
      const resolvedProject = projectKey ?? client.defaultProject;

      if (!resolvedProject) {
        throw new Error("projectKey is required when JIRA_DEFAULT_PROJECT is not set");
      }

      const result = await client.getProjectIssues(resolvedProject, maxResults, nextPageToken);
      return raw ? toTextResult(result, client.customFields) : toMarkdownResult(formatSearch(result));
    }
  );

  server.registerTool(
    "jira_get_comments",
    {
      title: "Get Jira comments",
      description:
        "Fetch comments for a Jira issue as Markdown. Defaults to the 5 newest; long comments are truncated and " +
        "pasted JSON/XML payloads collapsed — expand one with commentId + full:true.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        issueKey: z.string().min(2),
        limit: z.number().int().min(1).max(100).optional().describe("How many comments to return (default 5)."),
        order: z.enum(["desc", "asc"]).optional().describe("desc = newest first (default), asc = oldest first."),
        since: z.string().optional().describe("ISO date/time; only comments created at or after it."),
        maxLength: z.number().int().min(100).optional().describe("Per-comment character limit (default 2000)."),
        full: z.boolean().optional().describe("Disable truncation and payload collapsing."),
        commentId: z.string().optional().describe("Return just this comment, in full."),
        raw: rawFlag
      }
    },
    async ({ issueKey, limit, order, since, maxLength, full, commentId, raw }) => {
      if (raw) {
        return toTextResult(
          commentId ? await client.getComment(issueKey, commentId) : await client.getComments(issueKey)
        );
      }

      if (commentId) {
        const comment = await client.getComment(issueKey, commentId);
        return toMarkdownResult(`${issueKey}\n\n${formatComment(comment, { maxLength: 0, full: true })}`);
      }

      const sinceDate = since ? new Date(since) : undefined;
      if (sinceDate && Number.isNaN(sinceDate.getTime())) {
        throw new Error(`Invalid since date: ${since}`);
      }

      const resolvedOrder = order ?? "desc";
      const { comments, total } = await client.findComments(issueKey, {
        limit: limit ?? 5,
        order: resolvedOrder,
        since: sinceDate
      });

      return toMarkdownResult(
        formatComments(comments, {
          issueKey,
          total,
          order: resolvedOrder,
          since,
          maxLength: maxLength ?? 2000,
          full: full ?? false
        })
      );
    }
  );

  server.registerTool(
    "jira_list_attachments",
    {
      title: "List Jira attachments",
      description:
        "List every file attached to a Jira issue — both files on the description and images pasted into " +
        "comments — with the attachment ids needed by jira_download_attachment.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        issueKey: z.string().min(2),
        raw: rawFlag
      }
    },
    async ({ issueKey, raw }) => {
      const attachments = await client.getAttachments(issueKey);
      return raw ? toTextResult(attachments) : toMarkdownResult(formatAttachments(attachments, issueKey));
    }
  );

  server.registerTool(
    "jira_list_fields",
    {
      title: "List Jira fields",
      description:
        "List Jira fields with their ids, to find customfield_* ids by name (e.g. for JIRA_CUSTOM_FIELDS or JQL). " +
        "Filter by name with query.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive text the field name or id must contain."),
        customOnly: z.boolean().optional().describe("Only custom fields (customfield_*)."),
        raw: rawFlag
      }
    },
    async ({ query, customOnly, raw }) => {
      const fields = (await client.getFields()).filter(
        (field) => (!customOnly || field.custom === true) && matchesQuery(query, field.name, field.id)
      );
      return raw ? toTextResult(fields) : toMarkdownResult(formatFields(fields), { untrusted: false });
    }
  );

  server.registerTool(
    "jira_list_projects",
    {
      title: "List Jira projects",
      description:
        "List the Jira projects the user can browse, with their keys (for JQL and JIRA_DEFAULT_PROJECT). " +
        "Filter by name or key with query.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive text the project name or key must contain."),
        limit: z.number().int().min(1).max(200).optional().describe("Max projects to return (default 50)."),
        raw: rawFlag
      }
    },
    async ({ query, limit, raw }) => {
      const matches = (await client.getProjects()).filter((project) => matchesQuery(query, project.name, project.key));
      const shown = matches.slice(0, limit ?? 50);
      return raw ? toTextResult(shown) : toMarkdownResult(formatProjects(shown, matches.length), { untrusted: false });
    }
  );

  server.registerTool(
    "jira_get_current_user",
    {
      title: "Get current Jira user",
      description: "Return the Jira user the server authenticates as (accountId, name, time zone).",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: { raw: rawFlag }
    },
    async ({ raw }) => {
      const user = await client.getCurrentUser();
      return raw ? toTextResult(user) : toMarkdownResult(formatCurrentUser(user), { untrusted: false });
    }
  );

  server.registerTool(
    "jira_find_users",
    {
      title: "Find Jira users",
      description:
        'Find Jira users by name or email to get the accountId needed in JQL (e.g. assignee = "<accountId>").',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        query: z.string().min(1).describe("Part of the display name or email address."),
        limit: z.number().int().min(1).max(50).optional().describe("Max users to return (default 10)."),
        raw: rawFlag
      }
    },
    async ({ query, limit, raw }) => {
      const users = await client.findUsers(query, limit ?? 10);
      return raw ? toTextResult(users) : toMarkdownResult(formatUsers(users), { untrusted: false });
    }
  );
}

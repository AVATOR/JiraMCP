import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  formatAttachments,
  formatBoards,
  formatChangelog,
  formatFilters,
  formatProjectDetail,
  formatReference,
  formatRemoteLinks,
  formatSprints,
  formatTransitions,
  formatWorklogs,
  formatComment,
  formatComments,
  formatCurrentUser,
  formatFields,
  formatIssue,
  formatProjects,
  formatSearch,
  formatUsers
} from "../compact/index.js";
import type { JiraClient } from "../jira-client.js";
import {
  limitParam,
  matchesQuery,
  nextPageTokenParam,
  rawFlag,
  READ_ONLY_ANNOTATIONS,
  respond,
  toMarkdownResult,
  toTextResult
} from "./shared.js";

/**
 * Registers the read-only Jira tools.
 *
 * @param server MCP server to add the tools to.
 * @param client Jira client the tools read through.
 */
export function registerJiraTools(server: McpServer, client: JiraClient) {
  /**
   * Picks the explicit project key or the configured default.
   *
   * @param projectKey Key given by the caller, if any.
   * @returns The project key to use.
   */
  const resolveProject = (projectKey: string | undefined): string => {
    const resolved = projectKey ?? client.defaultProject;

    if (!resolved) {
      throw new Error("projectKey is required when JIRA_DEFAULT_PROJECT is not set");
    }

    return resolved;
  };

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
        fields: z
          .array(z.string().min(1))
          .max(20)
          .optional()
          .describe(
            "Extra field ids to return in addition to the default columns (e.g. labels, description, " +
              "customfield_10145). Shown as extra table columns, clipped to 200 characters."
          ),
        raw: rawFlag
      }
    },
    async ({ jql, maxResults, nextPageToken, fields, raw }) => {
      const result = await client.searchIssues({ jql, maxResults, nextPageToken, fields });
      return raw
        ? toTextResult(result, client.customFields)
        : toMarkdownResult(formatSearch(result, fields, client.customFields));
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
      const result = await client.getProjectIssues(resolveProject(projectKey), maxResults, nextPageToken);
      return respond(raw, result, formatSearch, { customFields: client.customFields });
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
      return respond(raw, attachments, (items) => formatAttachments(items, issueKey));
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
      return respond(raw, fields, formatFields, { untrusted: false });
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
        limit: limitParam(200, 50, "projects"),
        raw: rawFlag
      }
    },
    async ({ query, limit, raw }) => {
      const matches = (await client.getProjects()).filter((project) => matchesQuery(query, project.name, project.key));
      const shown = matches.slice(0, limit ?? 50);
      return respond(raw, shown, (items) => formatProjects(items, matches.length), { untrusted: false });
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
      return respond(raw, user, formatCurrentUser, { untrusted: false });
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
        limit: limitParam(50, 10, "users"),
        raw: rawFlag
      }
    },
    async ({ query, limit, raw }) => {
      const users = await client.findUsers(query, limit ?? 10);
      return respond(raw, users, formatUsers, { untrusted: false });
    }
  );

  server.registerTool(
    "jira_get_changelog",
    {
      title: "Get Jira issue history",
      description:
        "Who changed what and when on an issue (status, assignee, fields), newest first. Filter to one " +
        "field such as status with field.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        issueKey: z.string().min(2),
        field: z.string().optional().describe("Only changes of this field name, e.g. status or assignee."),
        limit: limitParam(200, 20, "changes"),
        raw: rawFlag
      }
    },
    async ({ issueKey, field, limit, raw }) => {
      const needle = field?.trim().toLowerCase();
      const matching = (await client.getChangelog(issueKey))
        .map((entry) => ({
          ...entry,
          items: (entry.items ?? []).filter((item) => !needle || item.field?.toLowerCase() === needle)
        }))
        .filter((entry) => entry.items.length)
        .reverse();
      const shown = matching.slice(0, limit ?? 20);
      return respond(raw, shown, (entries) => formatChangelog(entries, { issueKey, total: matching.length, field }));
    }
  );

  server.registerTool(
    "jira_get_worklogs",
    {
      title: "Get Jira worklogs",
      description: "Time logged on an issue: who, when, how long, with the total.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: { issueKey: z.string().min(2), raw: rawFlag }
    },
    async ({ issueKey, raw }) => {
      const worklogs = await client.getWorklogs(issueKey);
      return respond(raw, worklogs, (items) => formatWorklogs(items, issueKey));
    }
  );

  server.registerTool(
    "jira_list_transitions",
    {
      title: "List Jira transitions",
      description:
        "Workflow transitions currently available for an issue (id, name, target status). Read only: " +
        "transitions cannot be executed with this server.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: { issueKey: z.string().min(2), raw: rawFlag }
    },
    async ({ issueKey, raw }) => {
      const transitions = await client.getTransitions(issueKey);
      return respond(raw, transitions, (items) => formatTransitions(items, issueKey), { untrusted: false });
    }
  );

  server.registerTool(
    "jira_list_metadata",
    {
      title: "List Jira statuses, issue types or priorities",
      description:
        "Reference lists for writing JQL: all statuses (with category), issue types or priorities. " +
        "Filter by name with query.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        kind: z.enum(["statuses", "issueTypes", "priorities"]).describe("Which list to return."),
        query: z.string().optional().describe("Case-insensitive text the name must contain."),
        limit: limitParam(500, 100, "items"),
        raw: rawFlag
      }
    },
    async ({ kind, query, limit, raw }) => {
      const matches = (await client.getReference(kind)).filter((item) => matchesQuery(query, item.name));
      const shown = matches.slice(0, limit ?? 100);
      return respond(raw, shown, (items) => formatReference(items, kind, matches.length), { untrusted: false });
    }
  );

  server.registerTool(
    "jira_get_project",
    {
      title: "Get Jira project",
      description: "Project details: lead, issue types, components and versions/releases.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: { projectKey: z.string().min(1).optional(), raw: rawFlag }
    },
    async ({ projectKey, raw }) => {
      const project = await client.getProject(resolveProject(projectKey));
      return respond(raw, project, formatProjectDetail);
    }
  );

  server.registerTool(
    "jira_list_filters",
    {
      title: "List Jira filters",
      description: "Search saved filters by name; returns ids (for jira_run_filter) and their JQL.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        query: z.string().optional().describe("Part of the filter name."),
        limit: limitParam(100, 25, "filters"),
        raw: rawFlag
      }
    },
    async ({ query, limit, raw }) => {
      const filters = await client.findFilters({ name: query, limit: limit ?? 25 });
      return respond(raw, filters, formatFilters);
    }
  );

  server.registerTool(
    "jira_run_filter",
    {
      title: "Run Jira filter",
      description: "Run a saved filter by id and list the matching issues (like jira_search_issues).",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        filterId: z.string().min(1),
        maxResults: z.number().int().min(1).max(100).optional(),
        nextPageToken: nextPageTokenParam,
        raw: rawFlag
      }
    },
    async ({ filterId, maxResults, nextPageToken, raw }) => {
      const filter = await client.getFilter(filterId);

      if (!filter.jql) {
        throw new Error(`Filter ${filterId} has no JQL`);
      }

      const result = await client.searchIssues({ jql: filter.jql, maxResults, nextPageToken });
      return raw
        ? toTextResult({ filter, result }, client.customFields)
        : toMarkdownResult(`Filter ${filter.name ?? filterId}: ${filter.jql}\n\n${formatSearch(result)}`);
    }
  );

  server.registerTool(
    "jira_get_remote_links",
    {
      title: "Get Jira remote links",
      description: "Links from an issue to the outside: pull requests, Confluence pages, documents.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: { issueKey: z.string().min(2), raw: rawFlag }
    },
    async ({ issueKey, raw }) => {
      const links = await client.getRemoteLinks(issueKey);
      return respond(raw, links, (items) => formatRemoteLinks(items, issueKey));
    }
  );

  server.registerTool(
    "jira_list_boards",
    {
      title: "List Jira boards",
      description: "Agile boards (Scrum/Kanban) with ids for jira_list_sprints. Filter by name or project key.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        query: z.string().optional().describe("Part of the board name."),
        projectKey: z.string().optional().describe("Only boards of this project."),
        limit: limitParam(100, 25, "boards"),
        raw: rawFlag
      }
    },
    async ({ query, projectKey, limit, raw }) => {
      const boards = await client.getBoards({ name: query, projectKey, limit: limit ?? 25 });
      return respond(raw, boards, formatBoards);
    }
  );

  server.registerTool(
    "jira_list_sprints",
    {
      title: "List Jira sprints",
      description:
        "Sprints of a Scrum board with ids for jira_get_sprint_issues. Use state=active for the current one.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        boardId: z.string().min(1).describe("Board id from jira_list_boards."),
        state: z.enum(["active", "future", "closed"]).optional().describe("Only sprints in this state."),
        raw: rawFlag
      }
    },
    async ({ boardId, state, raw }) => {
      const sprints = await client.getSprints(boardId, state);
      return respond(raw, sprints, (items) => formatSprints(items, boardId));
    }
  );

  server.registerTool(
    "jira_get_sprint_issues",
    {
      title: "Get Jira sprint issues",
      description: "Issues of a sprint (id from jira_list_sprints), page by page via startAt.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: {
        sprintId: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional().describe("Page size (default 50)."),
        startAt: z.number().int().min(0).optional().describe("Offset from the previous result's nextStartAt."),
        raw: rawFlag
      }
    },
    async ({ sprintId, limit, startAt, raw }) => {
      const result = await client.getSprintIssues(sprintId, { limit: limit ?? 50, startAt: startAt ?? 0 });

      if (raw) {
        return toTextResult(result, client.customFields);
      }

      const shown = (result.issues ?? []).length;
      const next = (result.startAt ?? 0) + shown;
      const more = result.total !== undefined && next < result.total ? `\n\nnextStartAt: ${next}` : "";
      return toMarkdownResult(`${formatSearch(result)}${more}`);
    }
  );
}

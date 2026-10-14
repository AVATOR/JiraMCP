// Renders Jira REST payloads as compact Markdown.

import { adfToMarkdown, isAdf, type AdfOptions } from "../adf.js";
import type {
  CustomFieldMapping,
  JiraAttachment,
  JiraBoard,
  JiraChangelogEntry,
  JiraComment,
  JiraField,
  JiraFilter,
  JiraIssue,
  JiraIssueLink,
  JiraIssueRef,
  JiraProject,
  JiraProjectDetail,
  JiraReferenceItem,
  JiraRemoteLink,
  JiraSearchResult,
  JiraSprint,
  JiraTransition,
  JiraUser,
  JiraWorklog
} from "../types.js";
import { clip, countLine, EXTRA_CELL_CHARS, fileSize, shortDate, table, userName } from "./common.js";

export type CommentView = {
  issueKey: string;
  total: number;
  order: "asc" | "desc";
  since?: string;
  maxLength: number;
  full: boolean;
};

/**
 * Comma-separated names of a list of Jira objects (components, versions).
 *
 * @param values Array of objects with a name.
 * @returns Comma-separated names, empty string when not an array.
 */
function names(values: unknown): string {
  return Array.isArray(values)
    ? values
        .map((value) => (value as { name?: string } | null)?.name)
        .filter(Boolean)
        .join(", ")
    : "";
}

/**
 * Primitives print as-is; anything else is serialized instead of becoming "[object Object]".
 *
 * @param value Any value.
 * @returns Text form of the value.
 */
function scalar(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/**
 * Renders an arbitrary custom field value without dragging Jira metadata along.
 *
 * @param value Raw field value (ADF, array, object or scalar).
 * @param options ADF rendering options.
 * @returns Readable text, empty string for empty values.
 */
function fieldValue(value: unknown, options: AdfOptions = {}): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (isAdf(value)) {
    return adfToMarkdown(value, options);
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => fieldValue(entry, options))
      .filter(Boolean)
      .join(", ");
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const label = record.displayName ?? record.value ?? record.name ?? record.key;
    return label !== undefined ? scalar(label) : JSON.stringify(value);
  }

  return scalar(value);
}

/**
 * Renders an issue as Markdown: metadata, links, subtasks, description and custom fields.
 *
 * @param issue Issue payload from /rest/api/3/issue.
 * @param customFields Custom fields to render as extra sections.
 * @returns The issue as Markdown.
 */
export function formatIssue(issue: JiraIssue, customFields: CustomFieldMapping[]): string {
  const fields = issue?.fields ?? {};
  const lines: string[] = [`# ${issue.key}: ${fields.summary ?? ""}`, ""];

  const meta: [string, string | undefined][] = [
    ["Status", fields.status?.name],
    ["Type", fields.issuetype?.name],
    ["Priority", fields.priority?.name],
    ["Resolution", fields.resolution?.name],
    ["Assignee", userName(fields.assignee)],
    ["Reporter", userName(fields.reporter)],
    ["Project", fields.project?.key],
    ["Parent", fields.parent ? `${fields.parent.key} — ${fields.parent.fields?.summary ?? ""}` : ""],
    ["Labels", (fields.labels ?? []).join(", ")],
    ["Components", names(fields.components)],
    ["Fix versions", names(fields.fixVersions)],
    ["Due", fields.duedate ?? ""],
    ["Created", shortDate(fields.created)],
    ["Updated", shortDate(fields.updated)]
  ];

  for (const [label, value] of meta) {
    if (value) {
      lines.push(`- **${label}:** ${value}`);
    }
  }

  const links = (fields.issuelinks ?? []).map((link: JiraIssueLink) => {
    const [direction, target] = link.outwardIssue
      ? [link.type?.outward, link.outwardIssue]
      : [link.type?.inward, link.inwardIssue];
    return `- ${direction ?? link.type?.name}: ${target?.key} — ${target?.fields?.summary ?? ""} [${target?.fields?.status?.name ?? ""}]`;
  });

  if (links.length) {
    lines.push("", "## Links", ...links);
  }

  const subtasks = (fields.subtasks ?? []).map(
    (subtask: JiraIssueRef) =>
      `- ${subtask.key} — ${subtask.fields?.summary ?? ""} [${subtask.fields?.status?.name ?? ""}]`
  );

  if (subtasks.length) {
    lines.push("", "## Subtasks", ...subtasks);
  }

  const description = fieldValue(fields.description, { full: true });
  lines.push("", "## Description", description || "_(empty)_");

  if ((fields.attachment ?? []).length) {
    lines.push("", formatAttachments(fields.attachment ?? [], issue.key ?? ""));
  }

  for (const { id, alias } of customFields) {
    const value = fieldValue(fields[id], { full: true });
    if (value) {
      lines.push("", `## ${alias}${alias !== id ? ` (${id})` : ""}`, value);
    }
  }

  return lines.join("\n");
}

/**
 * Jira keeps one attachment list per issue: files dropped on the description and images pasted into comments both land here, so a single table covers both.
 *
 * @param attachments Attachment objects of the issue.
 * @param issueKey Issue key shown in the header.
 * @returns Markdown table with a download hint.
 */
export function formatAttachments(attachments: JiraAttachment[], issueKey: string): string {
  const header = `## Attachments (${attachments.length}) — ${issueKey}`;

  if (!attachments.length) {
    return `${header}\n\n_(none)_`;
  }

  const rows = attachments.map((attachment) => [
    attachment.id,
    attachment.filename ?? "",
    attachment.mimeType ?? "",
    fileSize(attachment.size),
    userName(attachment.author),
    shortDate(attachment.created)
  ]);

  return [
    header,
    "",
    table(["Id", "Filename", "Type", "Size", "Author", "Created"], rows),
    "",
    "Download one with jira_download_attachment (attachmentId from the Id column)."
  ].join("\n");
}

/**
 * Cuts text to maxLength and points at full:true for the rest.
 *
 * @param text Text to shorten.
 * @param maxLength Characters to keep.
 * @param commentId Comment id shown in the hint for getting the full text.
 * @returns The text, or its start followed by a truncation note.
 */
function truncate(text: string, maxLength: number, commentId: string): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n… [truncated ${text.length - maxLength} chars; full:true, commentId:${commentId}]`;
}

/**
 * Renders one comment with its author, date and (possibly truncated) body.
 *
 * @param comment Comment payload.
 * @param view Truncation limit and the full flag.
 * @returns Heading line followed by the body.
 */
export function formatComment(comment: JiraComment, view: Pick<CommentView, "maxLength" | "full">): string {
  const id = String(comment.id);
  const body = adfToMarkdown(comment.body, { full: view.full, commentId: id });
  const edited =
    comment.updated && comment.updated !== comment.created ? ` (edited ${shortDate(comment.updated)})` : "";
  const header = `### ${shortDate(comment.created)} — ${userName(comment.author)}${edited} · id ${id}`;

  return `${header}\n${view.full ? body : truncate(body, view.maxLength, id)}`;
}

/**
 * Renders a list of comments under a header with the shown and total count.
 *
 * @param comments Comment payloads.
 * @param view Issue key, totals, order and truncation settings.
 * @returns Header line followed by the comments.
 */
export function formatComments(comments: JiraComment[], view: CommentView): string {
  const orderLabel = view.order === "desc" ? "newest first" : "oldest first";
  const sinceLabel = view.since ? `, since ${view.since}` : "";
  const header = `${view.issueKey} — showing ${comments.length} of ${view.total} comments (${orderLabel}${sinceLabel})`;

  if (!comments.length) {
    return header;
  }

  return [header, ...comments.map((comment) => formatComment(comment, view))].join("\n\n");
}

/**
 * Renders a Jira search result as a table, with nextPageToken when more pages exist.
 *
 * @param result Response of /rest/api/3/search/jql.
 * @param extraFields Extra requested field ids, shown as additional columns.
 * @param customFields Id-to-alias mappings, used for the extra column headers.
 * @returns Table of issues, with nextPageToken when more exist.
 */
export function formatSearch(
  result: JiraSearchResult,
  extraFields: string[] = [],
  customFields: CustomFieldMapping[] = []
): string {
  const issues = result?.issues ?? [];
  const total =
    result?.total !== undefined
      ? ` of ${result.total}`
      : result?.approximateTotal !== undefined
        ? ` of ~${result.approximateTotal}`
        : "";
  const more = result?.nextPageToken && result?.isLast !== true;
  const rows = issues.map((issue) => {
    const f = issue.fields ?? {};
    return [
      issue.key,
      f.summary ?? "",
      f.status?.name ?? "",
      f.issuetype?.name ?? "",
      f.priority?.name ?? "",
      f.assignee?.displayName ?? "—",
      shortDate(f.updated),
      ...extraFields.map((id) => clip(fieldValue(f[id]), EXTRA_CELL_CHARS))
    ];
  });
  const extraHeaders = extraFields.map((id) => customFields.find((field) => field.id === id)?.alias ?? id);

  const lines = [`${issues.length}${total} issues${more ? " (more available)" : ""}`];

  if (rows.length) {
    lines.push(
      "",
      table(["Key", "Summary", "Status", "Type", "Priority", "Assignee", "Updated", ...extraHeaders], rows)
    );
  }

  if (more) {
    lines.push("", `nextPageToken: ${result.nextPageToken}`);
  }

  return lines.join("\n");
}

/**
 * /rest/api/3/field: [{ id, name, custom, schema: { type } }].
 *
 * @param fields Items of /rest/api/3/field.
 * @returns Table of field ids, names and types.
 */
export function formatFields(fields: JiraField[]): string {
  const lines = [`${fields.length} fields`];

  if (fields.length) {
    lines.push(
      "",
      table(
        ["Id", "Name", "Type", "Custom"],
        fields.map((field) => [field.id, field.name, field.schema?.type ?? "", field.custom ? "yes" : ""])
      )
    );
  }

  return lines.join("\n");
}

/**
 * /rest/api/3/project/search values: [{ key, name, projectTypeKey, style }].
 *
 * @param projects Projects to show.
 * @param total Number of projects matching before the limit.
 * @returns Table of project keys and names.
 */
export function formatProjects(projects: JiraProject[], total: number): string {
  const lines = [countLine("projects", projects.length, total)];

  if (projects.length) {
    lines.push(
      "",
      table(
        ["Key", "Name", "Type", "Style"],
        projects.map((project) => [project.key, project.name, project.projectTypeKey ?? "", project.style ?? ""])
      )
    );
  }

  return lines.join("\n");
}

/**
 * /rest/api/3/myself.
 *
 * @param user Response of /rest/api/3/myself.
 * @returns Bullet list with name, email, account id and time zone.
 */
export function formatCurrentUser(user: JiraUser | undefined): string {
  const meta: [string, string | undefined][] = [
    ["Name", user?.displayName],
    ["Email", user?.emailAddress],
    ["Account id", user?.accountId],
    ["Time zone", user?.timeZone],
    ["Active", user?.active === undefined ? "" : user.active ? "yes" : "no"]
  ];

  return meta
    .filter(([, value]) => value)
    .map(([label, value]) => `- **${label}:** ${value}`)
    .join("\n");
}

/**
 * /rest/api/3/user/search: [{ accountId, displayName, emailAddress, active, accountType }].
 *
 * @param users Items of /rest/api/3/user/search.
 * @returns Table of account ids and names.
 */
export function formatUsers(users: JiraUser[]): string {
  const lines = [`${users.length} users`];

  if (users.length) {
    lines.push(
      "",
      table(
        ["Account id", "Name", "Email", "Active"],
        users.map((user) => [
          user.accountId,
          user.displayName,
          user.emailAddress ?? "",
          user.active === false ? "no" : "yes"
        ])
      )
    );
  }

  return lines.join("\n");
}

/**
 * Renders issue history: one block per change set with the fields that changed.
 *
 * @param entries Changelog entries, newest first.
 * @param view Issue key, total entries and the field filter that was applied.
 * @returns Markdown history.
 */
export function formatChangelog(
  entries: JiraChangelogEntry[],
  view: { issueKey: string; total: number; field?: string }
): string {
  const filter = view.field ? `, field "${view.field}"` : "";
  const header = `${view.issueKey} — showing ${entries.length} of ${view.total} changes (newest first${filter})`;

  if (!entries.length) {
    return header;
  }

  const blocks = entries.map((entry) => {
    const lines = (entry.items ?? []).map(
      (item) => `- ${item.field ?? "?"}: ${clip(item.fromString ?? "∅", 120)} → ${clip(item.toString ?? "∅", 120)}`
    );
    return [`### ${shortDate(entry.created)} — ${userName(entry.author)}`, ...lines].join("\n");
  });

  return [header, ...blocks].join("\n\n");
}

/**
 * Renders worklogs as a table with the total time logged.
 *
 * @param worklogs Worklogs of an issue.
 * @param issueKey Issue key shown in the header.
 * @returns Markdown table.
 */
export function formatWorklogs(worklogs: JiraWorklog[], issueKey: string): string {
  const seconds = worklogs.reduce((sum, worklog) => sum + (worklog.timeSpentSeconds ?? 0), 0);
  const hours = Math.round((seconds / 3600) * 10) / 10;
  const header = `${issueKey} — ${worklogs.length} worklogs, ${hours} h in total`;

  if (!worklogs.length) {
    return header;
  }

  const rows = worklogs.map((worklog) => [
    shortDate(worklog.started),
    userName(worklog.author),
    worklog.timeSpent ?? "",
    clip(adfToMarkdown(worklog.comment), EXTRA_CELL_CHARS)
  ]);

  return [header, "", table(["Started", "Author", "Time", "Comment"], rows)].join("\n");
}

/**
 * Renders the transitions available for an issue.
 *
 * @param transitions Available transitions.
 * @param issueKey Issue key shown in the header.
 * @returns Markdown table.
 */
export function formatTransitions(transitions: JiraTransition[], issueKey: string): string {
  const header = `${issueKey} — ${transitions.length} available transitions`;

  if (!transitions.length) {
    return header;
  }

  const rows = transitions.map((transition) => [transition.id, transition.name, transition.to?.name]);
  return [header, "", table(["Id", "Name", "Target status"], rows)].join("\n");
}

/**
 * Renders statuses, issue types or priorities.
 *
 * @param items Reference items.
 * @param label Plural name used in the header (e.g. "statuses").
 * @param total Number of items before the limit was applied.
 * @returns Markdown table.
 */
export function formatReference(items: JiraReferenceItem[], label: string, total: number): string {
  const lines = [countLine(label, items.length, total)];

  if (items.length) {
    lines.push(
      "",
      table(
        ["Id", "Name", "Info", "Description"],
        items.map((item) => [
          item.id,
          item.name,
          item.statusCategory?.name ?? (item.subtask ? "subtask" : ""),
          clip(item.description ?? "", EXTRA_CELL_CHARS)
        ])
      )
    );
  }

  return lines.join("\n");
}

/**
 * Renders a project with its issue types, components and versions.
 *
 * @param project Response of /rest/api/3/project/{key}.
 * @returns Markdown summary.
 */
export function formatProjectDetail(project: JiraProjectDetail): string {
  const lines = [`# ${project.key}: ${project.name ?? ""}`, ""];
  const meta: [string, string | undefined][] = [
    ["Type", project.projectTypeKey],
    ["Lead", project.lead ? userName(project.lead) : ""],
    ["Description", project.description]
  ];

  for (const [label, value] of meta) {
    if (value) {
      lines.push(`- **${label}:** ${value}`);
    }
  }

  const issueTypes = (project.issueTypes ?? []).map((type) => type.name).filter(Boolean);
  if (issueTypes.length) {
    lines.push("", "## Issue types", issueTypes.join(", "));
  }

  const components = project.components ?? [];
  if (components.length) {
    lines.push(
      "",
      `## Components (${components.length})`,
      ...components.map(
        (component) => `- ${component.name}${component.lead ? ` (lead: ${userName(component.lead)})` : ""}`
      )
    );
  }

  const versions = project.versions ?? [];
  if (versions.length) {
    lines.push(
      "",
      `## Versions (${versions.length})`,
      ...versions.map((version) => {
        const state = version.archived ? "archived" : version.released ? "released" : "unreleased";
        return `- ${version.name} [${state}${version.releaseDate ? `, ${version.releaseDate}` : ""}]`;
      })
    );
  }

  return lines.join("\n");
}

/**
 * Renders saved filters with their JQL.
 *
 * @param filters Filters from /rest/api/3/filter/search.
 * @returns Markdown table.
 */
export function formatFilters(filters: JiraFilter[]): string {
  const lines = [`${filters.length} filters`];

  if (filters.length) {
    lines.push(
      "",
      table(
        ["Id", "Name", "Owner", "JQL"],
        filters.map((filter) => [
          filter.id,
          filter.name,
          filter.owner?.displayName ?? "",
          clip(filter.jql ?? "", EXTRA_CELL_CHARS)
        ])
      )
    );
  }

  return lines.join("\n");
}

/**
 * Renders the remote links (pull requests, Confluence pages, ...) of an issue.
 *
 * @param links Remote links of the issue.
 * @param issueKey Issue key shown in the header.
 * @returns Markdown list.
 */
export function formatRemoteLinks(links: JiraRemoteLink[], issueKey: string): string {
  const header = `${issueKey} — ${links.length} remote links`;

  if (!links.length) {
    return header;
  }

  const rows = links.map((link) => {
    const source = link.application?.name ? ` (${link.application.name})` : "";
    const relationship = link.relationship ? `${link.relationship}: ` : "";
    return `- ${relationship}[${link.object?.title ?? link.object?.url ?? ""}](${link.object?.url ?? ""})${source}`;
  });

  return [header, "", ...rows].join("\n");
}

/**
 * Renders Agile boards.
 *
 * @param boards Boards from /rest/agile/1.0/board.
 * @returns Markdown table.
 */
export function formatBoards(boards: JiraBoard[]): string {
  const lines = [`${boards.length} boards`];

  if (boards.length) {
    lines.push(
      "",
      table(
        ["Id", "Name", "Type", "Project"],
        boards.map((board) => [
          board.id,
          board.name,
          board.type,
          board.location?.projectKey ?? board.location?.displayName ?? ""
        ])
      )
    );
  }

  return lines.join("\n");
}

/**
 * Renders the sprints of a board.
 *
 * @param sprints Sprints of a board.
 * @param boardId Board id shown in the header.
 * @returns Markdown table.
 */
export function formatSprints(sprints: JiraSprint[], boardId: string): string {
  const header = `Board ${boardId} — ${sprints.length} sprints`;

  if (!sprints.length) {
    return header;
  }

  const rows = sprints.map((sprint) => [
    sprint.id,
    sprint.name,
    sprint.state,
    shortDate(sprint.startDate),
    shortDate(sprint.endDate),
    clip(sprint.goal ?? "", EXTRA_CELL_CHARS)
  ]);
  return [header, "", table(["Id", "Name", "State", "Start", "End", "Goal"], rows)].join("\n");
}

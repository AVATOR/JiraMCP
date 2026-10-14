// Whitelists the useful parts of Jira REST payloads and renders them as Markdown.

import { adfToMarkdown, isAdf, type AdfOptions } from "./adf.js";
import { storageToMarkdown } from "./storage.js";
import type {
  ConfluencePage,
  ConfluenceSearchResult,
  ConfluenceSpace,
  ConfluenceSpacePages,
  CustomFieldMapping,
  JiraAttachment,
  JiraComment,
  JiraField,
  JiraIssue,
  JiraIssueLink,
  JiraIssueRef,
  JiraProject,
  JiraSearchResult,
  JiraUser
} from "./types.js";

export type { CustomFieldMapping };

export type CommentView = {
  issueKey: string;
  total: number;
  order: "asc" | "desc";
  since?: string;
  maxLength: number;
  full: boolean;
};

// Long values (descriptions) would blow up a table row, so extra columns are clipped.
const EXTRA_CELL_CHARS = 200;
const DATE_LENGTH = 16; // "2026-09-18T11:12"

/**
 * Display name of a Jira user with the email when it is available.
 *
 * @param user Jira user object, may be null.
 * @returns "Name <email>", the name alone, or an em dash.
 */
function userName(user: JiraUser | null | undefined): string {
  if (!user) {
    return "—";
  }

  return user.emailAddress ? `${user.displayName} <${user.emailAddress}>` : (user.displayName ?? "—");
}

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
 * Makes a value safe for a Markdown table cell (no pipes or line breaks).
 *
 * @param value Any value.
 * @returns Single-line text that is safe inside a table cell.
 */
function cell(value: unknown): string {
  const text =
    typeof value === "string" || typeof value === "number" ? String(value) : value == null ? "" : JSON.stringify(value);
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/**
 * Shortens an ISO timestamp to "YYYY-MM-DD HH:MM".
 *
 * @param value ISO timestamp.
 * @returns "YYYY-MM-DD HH:MM", or an em dash when not a string.
 */
function shortDate(value: unknown): string {
  return typeof value === "string" ? value.slice(0, DATE_LENGTH).replace("T", " ") : "—";
}

/**
 * Clips text to a maximum length with an ellipsis.
 *
 * @param text Text to clip.
 * @param max Maximum number of characters kept.
 * @returns The text, shortened when longer than max.
 */
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
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
 * Formats a byte count as a human-readable size.
 *
 * @param bytes Size in bytes.
 * @returns Human-readable size such as "1.5 MB"; an em dash for non-numbers.
 */
function fileSize(bytes: unknown): string {
  const size = Number(bytes);
  if (!Number.isFinite(size)) {
    return "—";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
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

  const rows = attachments.map((attachment) => {
    const cells = [
      attachment.id,
      attachment.filename ?? "",
      attachment.mimeType ?? "",
      fileSize(attachment.size),
      userName(attachment.author),
      shortDate(attachment.created)
    ].map(cell);
    return `| ${cells.join(" | ")} |`;
  });

  return [
    header,
    "",
    "| Id | Filename | Type | Size | Author | Created |",
    "|---|---|---|---|---|---|",
    ...rows,
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
 * Extracts the cursor of the next page from a Confluence `_links.next` URL.
 *
 * @param links `_links` object of a paginated Confluence response.
 * @returns Cursor value, or null on the last page.
 */
function nextCursor(links: { next?: string } | undefined): string | null {
  return typeof links?.next === "string" ? new URL(links.next, "http://x").searchParams.get("cursor") : null;
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
  const total = result?.total !== undefined ? ` of ${result.total}` : "";
  const more = result?.nextPageToken && result?.isLast !== true;
  const rows = issues.map((issue) => {
    const f = issue.fields ?? {};
    const cells = [
      issue.key,
      f.summary ?? "",
      f.status?.name ?? "",
      f.issuetype?.name ?? "",
      f.priority?.name ?? "",
      f.assignee?.displayName ?? "—",
      shortDate(f.updated),
      ...extraFields.map((id) => clip(fieldValue(f[id]), EXTRA_CELL_CHARS))
    ].map(cell);
    return `| ${cells.join(" | ")} |`;
  });
  const extraHeaders = extraFields.map((id) => customFields.find((field) => field.id === id)?.alias ?? id);

  const lines = [`${issues.length}${total} issues${more ? " (more available)" : ""}`];

  if (rows.length) {
    lines.push(
      "",
      `| ${["Key", "Summary", "Status", "Type", "Priority", "Assignee", "Updated", ...extraHeaders].join(" | ")} |`,
      `|${"---|".repeat(7 + extraFields.length)}`,
      ...rows
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
      "| Id | Name | Type | Custom |",
      "|---|---|---|---|",
      ...fields.map(
        (field) =>
          `| ${[field.id, field.name, field.schema?.type ?? "", field.custom ? "yes" : ""].map(cell).join(" | ")} |`
      )
    );
  }

  return lines.join("\n");
}

/**
 * Summary line for a listing that may have been cut by a limit.
 *
 * @param label Plural noun, e.g. projects.
 * @param shown Items shown.
 * @param total Items matching before the limit.
 * @returns Count line such as "5 of 12 projects (raise limit or narrow query)".
 */
function countLine(label: string, shown: number, total: number): string {
  return shown < total ? `${shown} of ${total} ${label} (raise limit or narrow query)` : `${total} ${label}`;
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
      "| Key | Name | Type | Style |",
      "|---|---|---|---|",
      ...projects.map(
        (project) =>
          `| ${[project.key, project.name, project.projectTypeKey ?? "", project.style ?? ""].map(cell).join(" | ")} |`
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
      "| Account id | Name | Email | Active |",
      "|---|---|---|---|",
      ...users.map(
        (user) =>
          `| ${[user.accountId, user.displayName, user.emailAddress ?? "", user.active === false ? "no" : "yes"].map(cell).join(" | ")} |`
      )
    );
  }

  return lines.join("\n");
}

/**
 * v2 spaces: [{ id, key, name, type, status }].
 *
 * @param spaces Spaces to show.
 * @param total Number of spaces matching before the limit.
 * @returns Table of space keys and names.
 */
export function formatConfluenceSpaces(spaces: ConfluenceSpace[], total: number): string {
  const lines = [countLine("spaces", spaces.length, total)];

  if (spaces.length) {
    lines.push(
      "",
      "| Key | Name | Type | Status |",
      "|---|---|---|---|",
      ...spaces.map(
        (space) => `| ${[space.key, space.name, space.type ?? "", space.status ?? ""].map(cell).join(" | ")} |`
      )
    );
  }

  return lines.join("\n");
}

/**
 * v1 CQL search result: { results: [{ content: { id, title }, url, lastModified, excerpt }] }.
 *
 * @param result Response of the v1 CQL search.
 * @returns Table of matching pages.
 */
export function formatConfluenceSearch(result: ConfluenceSearchResult): string {
  const pages = result?.results ?? [];
  const total = result?.totalSize !== undefined ? ` of ${result.totalSize}` : "";
  const lines = [`${pages.length}${total} pages`];

  if (pages.length) {
    lines.push(
      "",
      "| Id | Title | Space | Modified |",
      "|---|---|---|---|",
      ...pages.map((page) => {
        // The key is what confluence_get_space_pages takes; displayUrl is "/spaces/<KEY>".
        const space =
          page.resultGlobalContainer?.displayUrl?.match(/\/spaces\/([^/]+)/)?.[1] ??
          page.content?.space?.key ??
          page.resultGlobalContainer?.title ??
          "";
        return `| ${[page.content?.id, page.content?.title ?? page.title, space, shortDate(page.lastModified)].map(cell).join(" | ")} |`;
      })
    );
  }

  const cursor = nextCursor(result?._links);
  if (cursor) {
    lines.push("", `cursor: ${cursor}`);
  }

  return lines.join("\n");
}

/**
 * v2 space pages: { results: [{ id, title, status, parentId, version: { createdAt } }], _links: { next } }.
 *
 * @param result Response of the v2 space pages endpoint.
 * @param spaceKey Space key shown in the header.
 * @returns Table of pages, with the cursor when more exist.
 */
export function formatConfluenceSpacePages(result: ConfluenceSpacePages, spaceKey: string): string {
  const pages = result?.results ?? [];
  const lines = [`${spaceKey} — ${pages.length} pages`];

  if (pages.length) {
    lines.push(
      "",
      "| Id | Title | Parent | Modified |",
      "|---|---|---|---|",
      ...pages.map(
        (page) =>
          `| ${[page.id, page.title, page.parentId ?? "", shortDate(page.version?.createdAt)].map(cell).join(" | ")} |`
      )
    );
  }

  const cursor = nextCursor(result?._links);
  if (cursor) {
    lines.push("", `cursor: ${cursor}`);
  }

  return lines.join("\n");
}

/**
 * v2 page with body-format=storage: { id, title, spaceId, parentId, version, body.storage.value, _links.webui }.
 *
 * @param page v2 page with a storage-format body.
 * @param wikiBaseUrl Base URL used to build the page link.
 * @returns Title, metadata and body as Markdown.
 */
export function formatConfluencePage(page: ConfluencePage, wikiBaseUrl: string): string {
  const lines = [`# ${page?.title ?? ""}`, ""];
  const meta: [string, string | undefined][] = [
    ["Id", page?.id],
    ["Space id", page?.spaceId],
    ["Parent", page?.parentId],
    [
      "Version",
      page?.version?.number !== undefined ? `${page.version.number} (${shortDate(page.version.createdAt)})` : ""
    ],
    ["Url", page?._links?.webui ? `${wikiBaseUrl}${page._links.webui}` : ""]
  ];

  for (const [label, value] of meta) {
    if (value) {
      lines.push(`- **${label}:** ${value}`);
    }
  }

  lines.push("", storageToMarkdown(page?.body?.storage?.value ?? "") || "_(empty)_");
  return lines.join("\n");
}

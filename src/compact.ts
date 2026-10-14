// Whitelists the useful parts of Jira REST payloads and renders them as Markdown.

import { adfToMarkdown, isAdf, type AdfOptions } from "./adf.js";
import { storageToMarkdown } from "./storage.js";

export type CustomFieldMapping = {
  id: string;
  alias: string;
};

export type CommentView = {
  issueKey: string;
  total: number;
  order: "asc" | "desc";
  since?: string;
  maxLength: number;
  full: boolean;
};

const DATE_LENGTH = 16; // "2026-09-18T11:12"

function userName(user: any): string {
  if (!user) {
    return "—";
  }

  return user.emailAddress ? `${user.displayName} <${user.emailAddress}>` : (user.displayName ?? "—");
}

function names(values: unknown): string {
  return Array.isArray(values)
    ? values
        .map((value) => value?.name)
        .filter(Boolean)
        .join(", ")
    : "";
}

function cell(value: unknown): string {
  const text =
    typeof value === "string" || typeof value === "number" ? String(value) : value == null ? "" : JSON.stringify(value);
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

function shortDate(value: unknown): string {
  return typeof value === "string" ? value.slice(0, DATE_LENGTH).replace("T", " ") : "—";
}

// Renders an arbitrary custom field value without dragging Jira metadata along.
function fieldValue(value: any, options: AdfOptions = {}): string {
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
    const label = value.displayName ?? value.value ?? value.name ?? value.key;
    return label !== undefined ? String(label) : JSON.stringify(value);
  }

  return String(value);
}

export function formatIssue(issue: any, customFields: CustomFieldMapping[]): string {
  const fields = issue?.fields ?? {};
  const lines: string[] = [`# ${issue.key}: ${fields.summary ?? ""}`, ""];

  const meta: [string, string][] = [
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

  const links = (fields.issuelinks ?? []).map((link: any) => {
    const [direction, target] = link.outwardIssue
      ? [link.type?.outward, link.outwardIssue]
      : [link.type?.inward, link.inwardIssue];
    return `- ${direction ?? link.type?.name}: ${target?.key} — ${target?.fields?.summary ?? ""} [${target?.fields?.status?.name ?? ""}]`;
  });

  if (links.length) {
    lines.push("", "## Links", ...links);
  }

  const subtasks = (fields.subtasks ?? []).map(
    (subtask: any) => `- ${subtask.key} — ${subtask.fields?.summary ?? ""} [${subtask.fields?.status?.name ?? ""}]`
  );

  if (subtasks.length) {
    lines.push("", "## Subtasks", ...subtasks);
  }

  const description = fieldValue(fields.description, { full: true });
  lines.push("", "## Description", description || "_(empty)_");

  if ((fields.attachment ?? []).length) {
    lines.push("", formatAttachments(fields.attachment, issue.key));
  }

  for (const { id, alias } of customFields) {
    const value = fieldValue(fields[id], { full: true });
    if (value) {
      lines.push("", `## ${alias}${alias !== id ? ` (${id})` : ""}`, value);
    }
  }

  return lines.join("\n");
}

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

// Jira keeps one attachment list per issue: files dropped on the description and
// images pasted into comments both land here, so a single table covers both.
export function formatAttachments(attachments: any[], issueKey: string): string {
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

function truncate(text: string, maxLength: number, commentId: string): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n… [truncated ${text.length - maxLength} chars; full:true, commentId:${commentId}]`;
}

export function formatComment(comment: any, view: Pick<CommentView, "maxLength" | "full">): string {
  const id = String(comment.id);
  const body = adfToMarkdown(comment.body, { full: view.full, commentId: id });
  const edited =
    comment.updated && comment.updated !== comment.created ? ` (edited ${shortDate(comment.updated)})` : "";
  const header = `### ${shortDate(comment.created)} — ${userName(comment.author)}${edited} · id ${id}`;

  return `${header}\n${view.full ? body : truncate(body, view.maxLength, id)}`;
}

export function formatComments(comments: any[], view: CommentView): string {
  const orderLabel = view.order === "desc" ? "newest first" : "oldest first";
  const sinceLabel = view.since ? `, since ${view.since}` : "";
  const header = `${view.issueKey} — showing ${comments.length} of ${view.total} comments (${orderLabel}${sinceLabel})`;

  if (!comments.length) {
    return header;
  }

  return [header, ...comments.map((comment) => formatComment(comment, view))].join("\n\n");
}

export function formatSearch(result: any): string {
  const issues: any[] = result?.issues ?? [];
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
      shortDate(f.updated)
    ].map(cell);
    return `| ${cells.join(" | ")} |`;
  });

  const lines = [`${issues.length}${total} issues${more ? " (more available)" : ""}`];

  if (rows.length) {
    lines.push(
      "",
      "| Key | Summary | Status | Type | Priority | Assignee | Updated |",
      "|---|---|---|---|---|---|---|",
      ...rows
    );
  }

  if (more) {
    lines.push("", `nextPageToken: ${result.nextPageToken}`);
  }

  return lines.join("\n");
}

// /rest/api/3/field: [{ id, name, custom, schema: { type } }].
export function formatFields(fields: any[]): string {
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

function countLine(label: string, shown: number, total: number): string {
  return shown < total ? `${shown} of ${total} ${label} (raise limit or narrow query)` : `${total} ${label}`;
}

// /rest/api/3/project/search values: [{ key, name, projectTypeKey, style }].
export function formatProjects(projects: any[], total: number): string {
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

// /rest/api/3/myself.
export function formatCurrentUser(user: any): string {
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

// /rest/api/3/user/search: [{ accountId, displayName, emailAddress, active, accountType }].
export function formatUsers(users: any[]): string {
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

// v2 spaces: [{ id, key, name, type, status }].
export function formatConfluenceSpaces(spaces: any[], total: number): string {
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

// v1 CQL search result: { results: [{ content: { id, title }, url, lastModified, excerpt }] }.
export function formatConfluenceSearch(result: any): string {
  const pages: any[] = result?.results ?? [];
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

  return lines.join("\n");
}

// v2 space pages: { results: [{ id, title, status, parentId, version: { createdAt } }], _links: { next } }.
export function formatConfluenceSpacePages(result: any, spaceKey: string): string {
  const pages: any[] = result?.results ?? [];
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

  const cursor =
    typeof result?._links?.next === "string"
      ? new URL(result._links.next, "http://x").searchParams.get("cursor")
      : null;
  if (cursor) {
    lines.push("", `cursor: ${cursor}`);
  }

  return lines.join("\n");
}

// v2 page with body-format=storage: { id, title, spaceId, parentId, version, body.storage.value, _links.webui }.
export function formatConfluencePage(page: any, wikiBaseUrl: string): string {
  const lines = [`# ${page?.title ?? ""}`, ""];
  const meta: [string, string][] = [
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

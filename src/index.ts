#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  formatAttachments,
  formatComment,
  formatComments,
  formatIssue,
  formatSearch,
  type CustomFieldMapping
} from "./compact.js";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const COMMENT_PAGE_SIZE = 100;
// Bigger images blow up the context when base64-encoded, so they are only saved to disk.
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
const downloadDir = process.env.JIRA_ATTACHMENT_DIR?.trim() || path.join(os.tmpdir(), "jira-attachments");

function sanitizeFileName(name: string): string {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 100) || "attachment";
}

type JiraClientConfig = {
  baseUrl: string;
  email: string;
  apiToken: string;
  defaultProject?: string;
  customFields: CustomFieldMapping[];
};

const BASE_ISSUE_FIELDS = [
  "summary",
  "status",
  "issuetype",
  "priority",
  "assignee",
  "reporter",
  "description",
  "issuelinks",
  "attachment",
  "project",
  "labels",
  "created",
  "updated"
];

// Fields differ per Jira project, so they are configured per MCP connection via
// JIRA_CUSTOM_FIELDS: "customfield_10145:requirements,customfield_10170:discoveryQuestions".
// The alias is optional; without it the raw field id is used as-is.
function parseCustomFields(raw: string | undefined): CustomFieldMapping[] {
  if (!raw?.trim()) {
    return [];
  }

  const mappings: CustomFieldMapping[] = [];

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const [id, alias] = trimmed.split(":").map((part) => part.trim());

    if (!id) {
      continue;
    }

    if (mappings.some((mapping) => mapping.id === id)) {
      continue;
    }

    mappings.push({ id, alias: alias || id });
  }

  return mappings;
}

class JiraReadOnlyClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  readonly defaultProject?: string;
  readonly customFields: CustomFieldMapping[];

  constructor(private readonly config: JiraClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.authHeader = Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
    this.defaultProject = config.defaultProject;
    this.customFields = config.customFields;
  }

  async getIssue(issueKey: string, withRendered = false): Promise<JsonValue> {
    const fields = [...BASE_ISSUE_FIELDS, ...this.customFields.map((field) => field.id)];
    const query: Record<string, string> = { fields: fields.join(",") };

    // Rendered HTML duplicates the ADF description, so it is only fetched for raw output.
    if (withRendered) {
      query.expand = "renderedFields";
    }

    return this.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, query);
  }

  async searchIssues(params: {
    jql: string;
    maxResults?: number;
    startAt?: number;
  }): Promise<JsonValue> {
    return this.get("/rest/api/3/search/jql", {
      jql: params.jql,
      maxResults: String(params.maxResults ?? 20),
      startAt: String(params.startAt ?? 0),
      fields: "summary,status,issuetype,priority,assignee,project,created,updated"
    });
  }

  async getProjectIssues(projectKey: string, maxResults?: number): Promise<JsonValue> {
    return this.searchIssues({
      jql: `project = ${projectKey} ORDER BY updated DESC`,
      maxResults
    });
  }

  async getComments(issueKey: string): Promise<JsonValue> {
    return this.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      orderBy: "created"
    });
  }

  async getComment(issueKey: string, commentId: string): Promise<any> {
    return this.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`);
  }

  // Returns up to `limit` comments in the requested order; with `since`, only comments created at or after it.
  async findComments(
    issueKey: string,
    params: { limit: number; order: "asc" | "desc"; since?: Date }
  ): Promise<{ comments: any[]; total: number }> {
    const path = `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`;

    if (!params.since) {
      const page: any = await this.get(path, {
        orderBy: params.order === "desc" ? "-created" : "created",
        maxResults: String(params.limit),
        startAt: "0"
      });
      return { comments: page.comments ?? [], total: page.total ?? 0 };
    }

    // Walk newest-first until comments get older than `since`; Jira has no server-side date filter here.
    const matched: any[] = [];
    let startAt = 0;
    let total = 0;

    while (true) {
      const page: any = await this.get(path, {
        orderBy: "-created",
        maxResults: String(COMMENT_PAGE_SIZE),
        startAt: String(startAt)
      });
      const comments: any[] = page.comments ?? [];
      total = page.total ?? 0;

      const fresh = comments.filter((comment) => new Date(comment.created) >= params.since!);
      matched.push(...fresh);

      if (fresh.length < comments.length || !comments.length || startAt + comments.length >= total) {
        break;
      }

      startAt += comments.length;
    }

    const ordered = params.order === "desc" ? matched : matched.reverse();
    return { comments: ordered.slice(0, params.limit), total: matched.length };
  }

  // The issue-level attachment list covers both description files and images
  // pasted into comments, since Jira stores them all on the issue.
  async getAttachments(issueKey: string): Promise<any[]> {
    const issue: any = await this.get(`/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      fields: "attachment"
    });

    return issue?.fields?.attachment ?? [];
  }

  async getAttachmentMeta(attachmentId: string): Promise<any> {
    return this.get(`/rest/api/3/attachment/${encodeURIComponent(attachmentId)}`);
  }

  async downloadAttachment(attachmentId: string): Promise<{ data: Buffer; mimeType: string }> {
    // Jira redirects attachment content to a signed media URL; fetch follows it and
    // drops the Authorization header cross-origin, which that URL does not need.
    const url = `${this.baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Basic ${this.authHeader}` },
      redirect: "follow"
    });

    if (!response.ok) {
      throw new Error(
        `Jira attachment download failed (${response.status} ${response.statusText}) for attachment ${attachmentId}`
      );
    }

    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType: (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim()
    };
  }

  async getConfluencePage(pageId: string): Promise<JsonValue> {
    return this.get(`/wiki/api/v2/pages/${pageId}`, {
      "body-format": "storage"
    });
  }

  async searchConfluence(query: string): Promise<JsonValue> {
    return this.get("/wiki/api/v2/pages", {
      title: query
    });
  }

  async getConfluenceSpacePages(spaceKey: string): Promise<JsonValue> {
    // В API v2 поиск по spaceKey через query параметры
    return this.get("/wiki/api/v2/pages", {
      "space-key": spaceKey
    });
  }

  private async get(path: string, query?: Record<string, string>): Promise<JsonValue> {
    const url = new URL(`${this.baseUrl}${path}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${this.authHeader}`
      }
    });

    const contentType = response.headers.get("content-type") ?? "";
    const responseBody = contentType.includes("application/json")
      ? ((await response.json()) as JsonValue)
      : ((await response.text()) as JsonValue);

    if (!response.ok) {
      throw new Error(`Jira request failed (${response.status} ${response.statusText}): ${JSON.stringify(responseBody)}`);
    }

    return responseBody;
  }
}

function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

// Adds a readable alias next to each configured custom field id, in both the raw
// fields and the rendered (HTML) ones, so the agent does not have to know field ids.
function applyCustomFieldAliases(container: any, customFields: CustomFieldMapping[]) {
  for (const holder of [container?.fields, container?.renderedFields]) {
    if (!holder || typeof holder !== "object") {
      continue;
    }

    for (const { id, alias } of customFields) {
      if (alias !== id && holder[id] !== undefined) {
        holder[alias] = holder[id];
      }
    }
  }
}

function toTextResult(payload: JsonValue, customFields: CustomFieldMapping[] = []) {
  if (customFields.length && payload && typeof payload === "object" && !Array.isArray(payload)) {
    const issue = payload as any;

    if (Array.isArray(issue.issues)) {
      issue.issues.forEach((entry: any) => applyCustomFieldAliases(entry, customFields));
    } else {
      applyCustomFieldAliases(issue, customFields);
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function toMarkdownResult(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text
      }
    ]
  };
}

const rawFlag = z.boolean().optional().describe("Return the unprocessed Jira JSON (debugging only; large).");

async function main() {
  const client = new JiraReadOnlyClient({
    baseUrl: getRequiredEnv("JIRA_BASE_URL"),
    email: getRequiredEnv("JIRA_EMAIL"),
    apiToken: getRequiredEnv("JIRA_API_TOKEN"),
    defaultProject: process.env.JIRA_DEFAULT_PROJECT?.trim() || undefined,
    customFields: parseCustomFields(process.env.JIRA_CUSTOM_FIELDS)
  });

  const customFieldsHint = client.customFields.length
    ? ` Returns these configured custom fields: ${client.customFields
        .map((field) => (field.alias === field.id ? field.id : `${field.alias} (${field.id})`))
        .join(", ")}.`
    : "";

  const server = new McpServer({
    name: "jira-readonly",
    version: "0.1.0"
  });

  server.registerTool(
    "jira_get_issue",
    {
      title: "Get Jira issue",
      description: `Fetch a Jira issue by key in read-only mode.${customFieldsHint}`,
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
      inputSchema: {
        jql: z.string().min(1),
        maxResults: z.number().int().min(1).max(100).optional(),
        startAt: z.number().int().min(0).optional()
      }
    },
    async ({ jql, maxResults, startAt }) =>
      toMarkdownResult(formatSearch(await client.searchIssues({ jql, maxResults, startAt })))
  );

  server.registerTool(
    "jira_get_project_issues",
    {
      title: "Get Jira project issues",
      description: "List issues from a Jira project ordered by last update.",
      inputSchema: {
        projectKey: z.string().min(1).optional(),
        maxResults: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ projectKey, maxResults }) => {
      const resolvedProject = projectKey ?? client.defaultProject;

      if (!resolvedProject) {
        throw new Error("projectKey is required when JIRA_DEFAULT_PROJECT is not set");
      }

      return toMarkdownResult(formatSearch(await client.getProjectIssues(resolvedProject, maxResults)));
    }
  );

  server.registerTool(
    "confluence_get_page",
    {
      title: "Get Confluence page",
      description: "Fetch a Confluence page by ID in read-only mode.",
      inputSchema: {
        pageId: z.string().describe("The ID of the Confluence page")
      }
    },
    async ({ pageId }) => toTextResult(await client.getConfluencePage(pageId))
  );

  server.registerTool(
    "confluence_search_pages",
    {
      title: "Search Confluence pages",
      description: "Search for Confluence pages by title.",
      inputSchema: {
        query: z.string().min(1).describe("The search query (title)")
      }
    },
    async ({ query }) => toTextResult(await client.searchConfluence(query))
  );

  server.registerTool(
    "confluence_get_space_pages",
    {
      title: "Get Confluence space pages",
      description: "List pages in a Confluence space.",
      inputSchema: {
        spaceKey: z.string().min(1).describe("The space key (e.g., 'MS')")
      }
    },
    async ({ spaceKey }) => toTextResult(await client.getConfluenceSpacePages(spaceKey))
  );

  server.registerTool(
    "jira_get_comments",
    {
      title: "Get Jira comments",
      description:
        "Fetch comments for a Jira issue as Markdown. Defaults to the 5 newest; long comments are truncated and " +
        "pasted JSON/XML payloads collapsed — expand one with commentId + full:true.",
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
    "jira_download_attachment",
    {
      title: "Download Jira attachment",
      description:
        "Download an attachment (e.g. a screenshot) by its id from jira_list_attachments. Saves it to disk and, " +
        "for images, also returns the image itself so it can be looked at directly.",
      inputSchema: {
        attachmentId: z.string().min(1).describe("Attachment id from jira_list_attachments."),
        outputPath: z
          .string()
          .optional()
          .describe("Where to save the file; defaults to JIRA_ATTACHMENT_DIR or the system temp dir."),
        inline: z
          .boolean()
          .optional()
          .describe("Return the image content as well (default true for images under the size limit).")
      }
    },
    async ({ attachmentId, outputPath, inline }) => {
      const meta = await client.getAttachmentMeta(attachmentId);
      const { data, mimeType } = await client.downloadAttachment(attachmentId);
      const resolvedMime = meta?.mimeType || mimeType;
      const target = outputPath
        ? path.resolve(outputPath)
        : path.join(downloadDir, `${attachmentId}-${sanitizeFileName(meta?.filename ?? attachmentId)}`);

      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, data);

      const isImage = resolvedMime.startsWith("image/");
      const tooLarge = data.byteLength > MAX_INLINE_IMAGE_BYTES;
      const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
        {
          type: "text",
          text:
            `Saved ${meta?.filename ?? attachmentId} (${resolvedMime}, ${data.byteLength} bytes) to ${target}` +
            (isImage && tooLarge ? "\nImage not inlined: larger than the inline limit; read the saved file instead." : "")
        }
      ];

      if (isImage && !tooLarge && inline !== false) {
        content.push({ type: "image", data: data.toString("base64"), mimeType: resolvedMime });
      }

      return { content };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
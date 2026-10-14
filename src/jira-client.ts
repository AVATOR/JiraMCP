import type { ReferenceCache } from "./cache.js";
import { MAX_LIST_PAGES, type AtlassianHttp } from "./http.js";
import { jqlString } from "./query.js";
import type {
  CustomFieldMapping,
  JiraAttachment,
  JiraAttachmentMeta,
  JiraComment,
  JiraCommentPage,
  JiraField,
  JiraIssue,
  JiraProject,
  JiraProjectSearchPage,
  JiraSearchResult,
  JiraUser
} from "./types.js";

const COMMENT_PAGE_SIZE = 100;
// Attachments are buffered in memory, so very large files are refused up front.
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

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
  "parent",
  "subtasks",
  "components",
  "fixVersions",
  "resolution",
  "duedate",
  "created",
  "updated"
];

const SEARCH_FIELDS = "summary,status,issuetype,priority,assignee,project,created,updated";

const issuePath = (issueKey: string) => `/rest/api/3/issue/${encodeURIComponent(issueKey)}`;

/**
 * Jira REST client. Only issues GET requests, so it cannot modify anything.
 */
export class JiraClient {
  readonly defaultProject?: string;
  readonly customFields: CustomFieldMapping[];

  constructor(
    private readonly http: AtlassianHttp,
    private readonly cache: ReferenceCache,
    options: { defaultProject?: string; customFields: CustomFieldMapping[] }
  ) {
    this.defaultProject = options.defaultProject;
    this.customFields = options.customFields;
  }

  /**
   * Fetches an issue with the base and custom fields; renderedFields only on request.
   *
   * @param issueKey Issue key, e.g. ABC-1.
   * @param withRendered Also request renderedFields (HTML).
   * @returns Raw issue JSON.
   */
  async getIssue(issueKey: string, withRendered = false): Promise<JiraIssue> {
    const fields = [...BASE_ISSUE_FIELDS, ...this.customFields.map((field) => field.id)];
    const query: Record<string, string> = { fields: fields.join(",") };

    // Rendered HTML duplicates the ADF description, so it is only fetched for raw output.
    if (withRendered) {
      query.expand = "renderedFields";
    }

    return this.http.get<JiraIssue>(issuePath(issueKey), query);
  }

  /**
   * /search/jql paginates with nextPageToken only; it ignores startAt and returns no total.
   *
   * @param params JQL, page size and page token.
   * @returns Raw search response.
   */
  async searchIssues(params: { jql: string; maxResults?: number; nextPageToken?: string }): Promise<JiraSearchResult> {
    const query: Record<string, string> = {
      jql: params.jql,
      maxResults: String(params.maxResults ?? 20),
      fields: SEARCH_FIELDS
    };

    if (params.nextPageToken) {
      query.nextPageToken = params.nextPageToken;
    }

    return this.http.get<JiraSearchResult>("/rest/api/3/search/jql", query);
  }

  /**
   * Lists a project's issues, most recently updated first.
   *
   * @param projectKey Project key.
   * @param maxResults Page size.
   * @param nextPageToken Token from the previous page.
   * @returns Raw search response.
   */
  async getProjectIssues(projectKey: string, maxResults?: number, nextPageToken?: string): Promise<JiraSearchResult> {
    return this.searchIssues({
      jql: `project = ${jqlString(projectKey)} ORDER BY updated DESC`,
      maxResults,
      nextPageToken
    });
  }

  /**
   * Lists every Jira field (system and custom) with its id and name; cached.
   * @returns All fields, or an empty list for an unexpected response.
   */
  async getFields(): Promise<JiraField[]> {
    return this.cache.get("fields", async () => {
      const fields = await this.http.get<unknown>("/rest/api/3/field");
      return Array.isArray(fields) ? (fields as JiraField[]) : [];
    });
  }

  /**
   * Every project the user can browse; filtering happens in the tool, so one listing serves all queries.
   * @returns Every browsable project, fetched page by page.
   */
  async getProjects(): Promise<JiraProject[]> {
    return this.cache.get("projects", async () => {
      const projects: JiraProject[] = [];

      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const result = await this.http.get<JiraProjectSearchPage>("/rest/api/3/project/search", {
          maxResults: "100",
          startAt: String(projects.length)
        });
        const values = result?.values ?? [];
        projects.push(...values);

        if (result?.isLast !== false || !values.length) {
          break;
        }
      }

      return projects;
    });
  }

  /**
   * Fetches the user the server authenticates as; cached.
   *
   * @returns The /myself response.
   */
  async getCurrentUser(): Promise<JiraUser> {
    return this.cache.get("myself", () => this.http.get<JiraUser>("/rest/api/3/myself"));
  }

  /**
   * Searches users by display name or email.
   *
   * @param query Part of the name or email.
   * @param maxResults Maximum number of users.
   * @returns Matching users.
   */
  async findUsers(query: string, maxResults: number): Promise<JiraUser[]> {
    const users = await this.http.get<unknown>("/rest/api/3/user/search", {
      query,
      maxResults: String(maxResults)
    });
    return Array.isArray(users) ? (users as JiraUser[]) : [];
  }

  /**
   * Fetches the issue's comments in creation order.
   *
   * @param issueKey Issue key.
   * @returns Raw comments response.
   */
  async getComments(issueKey: string): Promise<JiraCommentPage> {
    return this.http.get<JiraCommentPage>(`${issuePath(issueKey)}/comment`, { orderBy: "created" });
  }

  /**
   * Fetches a single comment by id.
   *
   * @param issueKey Issue key.
   * @param commentId Comment id.
   * @returns Raw comment.
   */
  async getComment(issueKey: string, commentId: string): Promise<JiraComment> {
    return this.http.get<JiraComment>(`${issuePath(issueKey)}/comment/${encodeURIComponent(commentId)}`);
  }

  /**
   * Returns up to `limit` comments in the requested order; with `since`, only comments created at or after it.
   *
   * @param issueKey Issue key.
   * @param params Limit, sort order and optional lower date bound.
   * @returns The comments and how many matched in total.
   */
  async findComments(
    issueKey: string,
    params: { limit: number; order: "asc" | "desc"; since?: Date }
  ): Promise<{ comments: JiraComment[]; total: number }> {
    const path = `${issuePath(issueKey)}/comment`;

    if (!params.since) {
      const page = await this.http.get<JiraCommentPage>(path, {
        orderBy: params.order === "desc" ? "-created" : "created",
        maxResults: String(params.limit),
        startAt: "0"
      });
      return { comments: page.comments ?? [], total: page.total ?? 0 };
    }

    // Walk newest-first until comments get older than `since`; Jira has no server-side date filter here.
    const since = params.since;
    const matched: JiraComment[] = [];
    let startAt = 0;

    while (true) {
      const page = await this.http.get<JiraCommentPage>(path, {
        orderBy: "-created",
        maxResults: String(COMMENT_PAGE_SIZE),
        startAt: String(startAt)
      });
      const comments = page.comments ?? [];
      const total = page.total ?? 0;

      const fresh = comments.filter((comment) => new Date(comment.created ?? 0) >= since);
      matched.push(...fresh);

      if (fresh.length < comments.length || !comments.length || startAt + comments.length >= total) {
        break;
      }

      startAt += comments.length;
    }

    const ordered = params.order === "desc" ? matched : matched.reverse();
    return { comments: ordered.slice(0, params.limit), total: matched.length };
  }

  /**
   * The issue-level attachment list covers both description files and images pasted into comments, since Jira stores them all on the issue.
   *
   * @param issueKey Issue key.
   * @returns Attachment objects of the issue.
   */
  async getAttachments(issueKey: string): Promise<JiraAttachment[]> {
    const issue = await this.http.get<JiraIssue>(issuePath(issueKey), { fields: "attachment" });
    return issue?.fields?.attachment ?? [];
  }

  /**
   * Fetches an attachment's metadata (filename, mime type, size).
   *
   * @param attachmentId Attachment id.
   * @returns Attachment metadata.
   */
  async getAttachmentMeta(attachmentId: string): Promise<JiraAttachmentMeta> {
    return this.http.get<JiraAttachmentMeta>(`/rest/api/3/attachment/${encodeURIComponent(attachmentId)}`);
  }

  /**
   * Downloads attachment content into memory, refusing files above the size limit.
   *
   * @param attachmentId Attachment id.
   * @returns File bytes and mime type.
   */
  async downloadAttachment(attachmentId: string): Promise<{ data: Buffer; mimeType: string }> {
    // Jira redirects attachment content to a signed media URL; fetch follows it and
    // drops the Authorization header cross-origin, which that URL does not need.
    const url = new URL(`${this.http.baseUrl}/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`);
    const response = await this.http.fetchWithRetry(url, "*/*");

    if (!response.ok) {
      throw new Error(
        `Jira attachment download failed (${response.status} ${response.statusText}) for attachment ${attachmentId}`
      );
    }

    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_DOWNLOAD_BYTES) {
      await response.body?.cancel();
      throw new Error(`Attachment ${attachmentId} is ${length} bytes, above the ${MAX_DOWNLOAD_BYTES}-byte limit`);
    }

    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType: (response.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim()
    };
  }
}

import type { ReferenceCache } from "./cache.js";
import { MAX_LIST_PAGES, type AtlassianHttp } from "./http.js";
import { jqlString } from "./query.js";
import type {
  CustomFieldMapping,
  JiraAttachment,
  JiraAttachmentMeta,
  JiraBoard,
  JiraChangelogEntry,
  JiraComment,
  JiraCommentPage,
  JiraField,
  JiraFilter,
  JiraIssue,
  JiraPage,
  JiraProject,
  JiraProjectDetail,
  JiraReferenceItem,
  JiraRemoteLink,
  JiraSearchResult,
  JiraSprint,
  JiraSprintIssues,
  JiraTransition,
  JiraUser,
  JiraWorklog
} from "./types.js";

const COMMENT_PAGE_SIZE = 100;

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
 * Narrows an unchecked response to a list; Jira occasionally answers with an object or nothing.
 *
 * @param value Parsed response body.
 * @returns The value when it is an array, otherwise an empty list.
 */
const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

/**
 * Jira REST client. Only issues GET requests, so it cannot modify anything.
 */
export class JiraClient {
  readonly defaultProject?: string;
  readonly customFields: CustomFieldMapping[];

  constructor(
    private readonly http: AtlassianHttp,
    private readonly cache: ReferenceCache,
    options: { defaultProject?: string; customFields: CustomFieldMapping[] },
    // Short-lived cache for issue and comment reads; without it every read goes to Jira.
    private readonly issueCache?: ReferenceCache
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

    return this.cached(`issue:${issueKey}:${withRendered}`, () => this.http.get<JiraIssue>(issuePath(issueKey), query));
  }

  /**
   * Reads through the short-lived issue cache when there is one.
   *
   * @param key Cache key.
   * @param load Loader called on a miss.
   * @returns The cached or freshly loaded value.
   */
  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    return this.issueCache ? this.issueCache.get(key, load) : load();
  }

  /**
   * /search/jql paginates with nextPageToken only; it ignores startAt and returns no total.
   *
   * @param params JQL, page size, page token and extra field ids beyond the default columns.
   * @returns Raw search response.
   */
  async searchIssues(params: {
    jql: string;
    maxResults?: number;
    nextPageToken?: string;
    fields?: string[];
  }): Promise<JiraSearchResult> {
    const query: Record<string, string> = {
      jql: params.jql,
      maxResults: String(params.maxResults ?? 20),
      fields: [SEARCH_FIELDS, ...(params.fields ?? [])].join(",")
    };

    if (params.nextPageToken) {
      query.nextPageToken = params.nextPageToken;
    }

    return this.http.get<JiraSearchResult>("/rest/api/3/search/jql", query);
  }

  /**
   * Counts the issues matching a JQL query. Jira only offers an estimate, via a read-only POST.
   *
   * @param jql JQL query.
   * @returns Approximate number of matching issues.
   */
  async countIssues(jql: string): Promise<number> {
    const result = await this.http.postRead<{ count?: number }>("/rest/api/3/search/approximate-count", { jql });
    return result?.count ?? 0;
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
      return asArray<JiraField>(await this.http.get<unknown>("/rest/api/3/field"));
    });
  }

  /**
   * Every project the user can browse; filtering happens in the tool, so one listing serves all queries.
   * @returns Every browsable project, fetched page by page.
   */
  async getProjects(): Promise<JiraProject[]> {
    return this.cache.get("projects", () => this.listAll<JiraProject>("/rest/api/3/project/search", "values"));
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
    return asArray<JiraUser>(
      await this.http.get<unknown>("/rest/api/3/user/search", { query, maxResults: String(maxResults) })
    );
  }

  /**
   * Fetches the issue's comments in creation order.
   *
   * @param issueKey Issue key.
   * @returns Raw comments response.
   */
  async getComments(issueKey: string): Promise<JiraCommentPage> {
    return this.cached(`comments:${issueKey}`, () =>
      this.http.get<JiraCommentPage>(`${issuePath(issueKey)}/comment`, { orderBy: "created" })
    );
  }

  /**
   * Fetches a single comment by id.
   *
   * @param issueKey Issue key.
   * @param commentId Comment id.
   * @returns Raw comment.
   */
  async getComment(issueKey: string, commentId: string): Promise<JiraComment> {
    return this.cached(`comment:${issueKey}:${commentId}`, () =>
      this.http.get<JiraComment>(`${issuePath(issueKey)}/comment/${encodeURIComponent(commentId)}`)
    );
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
    const key = `find-comments:${issueKey}:${params.limit}:${params.order}:${params.since?.toISOString() ?? ""}`;
    return this.cached(key, () => this.loadComments(issueKey, params));
  }

  /**
   * Loads the comments for findComments (uncached).
   *
   * @param issueKey Issue key.
   * @param params Limit, sort order and optional lower date bound.
   * @returns The comments and how many matched in total.
   */
  private async loadComments(
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
    return Array.isArray(issue?.fields?.attachment) ? issue.fields.attachment.filter(Boolean) : [];
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
   * Streams attachment content to a file, refusing files above the size limit.
   *
   * @param attachmentId Attachment id.
   * @param target File to write.
   * @param overwrite Replace an existing file.
   * @returns Bytes written and mime type.
   */
  async downloadAttachment(
    attachmentId: string,
    target: string,
    overwrite: boolean
  ): Promise<{ bytes: number; mimeType: string }> {
    return this.http.downloadToFile(
      `/rest/api/3/attachment/content/${encodeURIComponent(attachmentId)}`,
      `Jira attachment ${attachmentId}`,
      target,
      overwrite
    );
  }

  /**
   * Walks a startAt-paginated listing, up to a cap of items.
   *
   * @param path API path.
   * @param itemsKey Property of the page that holds the items.
   * @param query Extra query parameters.
   * @param maxItems Stop once this many items are collected.
   * @returns The collected items.
   */
  private async listAll<T>(
    path: string,
    itemsKey: "values" | "worklogs",
    query: Record<string, string> = {},
    maxItems = MAX_LIST_PAGES * 100
  ): Promise<T[]> {
    const items: T[] = [];

    while (items.length < maxItems) {
      const page = await this.http.get<JiraPage>(path, {
        ...query,
        startAt: String(items.length),
        maxResults: "100"
      });
      const batch = (page?.[itemsKey] ?? []) as T[];
      items.push(...batch);

      if (!batch.length || page?.isLast === true || (page?.total !== undefined && items.length >= page.total)) {
        break;
      }
    }

    return items.slice(0, maxItems);
  }

  /**
   * Fetches the whole change history of an issue, oldest first.
   *
   * @param issueKey Issue key.
   * @returns Changelog entries.
   */
  async getChangelog(issueKey: string): Promise<JiraChangelogEntry[]> {
    return this.listAll<JiraChangelogEntry>(`${issuePath(issueKey)}/changelog`, "values");
  }

  /**
   * Fetches the time logged on an issue.
   *
   * @param issueKey Issue key.
   * @returns Worklogs in the order Jira returns them.
   */
  async getWorklogs(issueKey: string): Promise<JiraWorklog[]> {
    return this.listAll<JiraWorklog>(`${issuePath(issueKey)}/worklog`, "worklogs");
  }

  /**
   * Lists the transitions currently available for an issue (read only; nothing is executed).
   *
   * @param issueKey Issue key.
   * @returns Available transitions.
   */
  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const result = await this.http.get<{ transitions?: JiraTransition[] }>(`${issuePath(issueKey)}/transitions`);
    return result?.transitions ?? [];
  }

  /**
   * Lists statuses, issue types or priorities; cached.
   *
   * @param kind Which reference list.
   * @returns The items of that list.
   */
  async getReference(kind: "statuses" | "issueTypes" | "priorities"): Promise<JiraReferenceItem[]> {
    const paths = {
      statuses: "/rest/api/3/status",
      issueTypes: "/rest/api/3/issuetype",
      priorities: "/rest/api/3/priority"
    };
    return this.cache.get(`reference-${kind}`, async () => {
      return asArray<JiraReferenceItem>(await this.http.get<unknown>(paths[kind]));
    });
  }

  /**
   * Fetches project details including issue types, components and versions.
   *
   * @param projectKey Project key.
   * @returns The project.
   */
  async getProject(projectKey: string): Promise<JiraProjectDetail> {
    return this.http.get<JiraProjectDetail>(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  }

  /**
   * Searches saved filters visible to the user.
   *
   * @param params Optional name filter and page size.
   * @returns Matching filters.
   */
  async findFilters(params: { name?: string; limit: number }): Promise<JiraFilter[]> {
    const query: Record<string, string> = { maxResults: String(params.limit), expand: "jql" };
    if (params.name) {
      query.filterName = params.name;
    }

    const result = await this.http.get<JiraPage>("/rest/api/3/filter/search", query);
    return (result?.values ?? []) as JiraFilter[];
  }

  /**
   * Fetches one saved filter with its JQL.
   *
   * @param filterId Filter id.
   * @returns The filter.
   */
  async getFilter(filterId: string): Promise<JiraFilter> {
    return this.http.get<JiraFilter>(`/rest/api/3/filter/${encodeURIComponent(filterId)}`);
  }

  /**
   * Lists web/Confluence links attached to an issue (pull requests, docs, ...).
   *
   * @param issueKey Issue key.
   * @returns Remote links.
   */
  async getRemoteLinks(issueKey: string): Promise<JiraRemoteLink[]> {
    return asArray<JiraRemoteLink>(await this.http.get<unknown>(`${issuePath(issueKey)}/remotelink`));
  }

  /**
   * Lists Agile boards the user can see.
   *
   * @param params Optional name and project filters, and page size.
   * @returns Matching boards.
   */
  async getBoards(params: { name?: string; projectKey?: string; limit: number }): Promise<JiraBoard[]> {
    const query: Record<string, string> = { maxResults: String(params.limit) };
    if (params.name) {
      query.name = params.name;
    }
    if (params.projectKey) {
      query.projectKeyOrId = params.projectKey;
    }

    const result = await this.http.get<JiraPage>("/rest/agile/1.0/board", query);
    return (result?.values ?? []) as JiraBoard[];
  }

  /**
   * Lists the sprints of a Scrum board.
   *
   * @param boardId Board id.
   * @param state Optional sprint state filter.
   * @returns Sprints, oldest first.
   */
  async getSprints(boardId: string, state?: string): Promise<JiraSprint[]> {
    return this.listAll<JiraSprint>(
      `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint`,
      "values",
      state ? { state } : {}
    );
  }

  /**
   * Fetches the issues of a sprint, one page at a time.
   *
   * @param sprintId Sprint id.
   * @param params Page size and offset.
   * @returns Agile search response with total and startAt.
   */
  async getSprintIssues(sprintId: string, params: { limit: number; startAt: number }): Promise<JiraSprintIssues> {
    return this.http.get<JiraSprintIssues>(`/rest/agile/1.0/sprint/${encodeURIComponent(sprintId)}/issue`, {
      maxResults: String(params.limit),
      startAt: String(params.startAt),
      fields: SEARCH_FIELDS
    });
  }
}

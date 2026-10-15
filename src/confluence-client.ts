import { Allowlist } from "./access.js";
import type { ReferenceCache } from "./cache.js";
import { MAX_LIST_PAGES, type AtlassianHttp } from "./http.js";
import { cqlSearchString, jqlString, nextCursor } from "./query.js";
import type {
  ConfluenceAncestor,
  ConfluenceAttachment,
  ConfluenceAttachments,
  ConfluenceChildren,
  ConfluenceComments,
  ConfluencePage,
  ConfluencePageSummary,
  ConfluenceSearchResult,
  ConfluenceSpace,
  ConfluenceSpaceList,
  ConfluenceSpacePages,
  ConfluenceVersions
} from "./types.js";

/**
 * Builds the limit/cursor query shared by the v2 listings.
 *
 * @param limit Page size.
 * @param cursor Cursor from the previous page.
 * @returns Query parameters.
 */
function pageQuery(limit: number, cursor?: string): Record<string, string> {
  return cursor ? { limit: String(limit), cursor } : { limit: String(limit) };
}

/**
 * Confluence REST client. Only issues GET requests, so it cannot modify anything.
 */
export class ConfluenceClient {
  // Space keys the server may read; undefined means no limit.
  readonly allowedSpaces?: string[];
  private readonly spaceAllowlist?: Allowlist;

  constructor(
    private readonly http: AtlassianHttp,
    private readonly cache: ReferenceCache,
    allowedSpaces?: string[]
  ) {
    this.allowedSpaces = allowedSpaces?.length ? allowedSpaces : undefined;
    this.spaceAllowlist = this.allowedSpaces
      ? new Allowlist(this.allowedSpaces, "Space", "CONFLUENCE_ALLOWED_SPACES")
      : undefined;
  }

  /**
   * Refuses a space outside the allowed ones.
   *
   * @param spaceKey Space key.
   */
  private guardSpace(spaceKey: string): void {
    this.spaceAllowlist?.assert(spaceKey);
  }

  /**
   * Refuses content that lives in a space outside the allowed ones. Spaces are matched by id, through
   * the (filtered) space listing, because pages only carry the id.
   *
   * @param spaceId Space id of a page.
   * @param what What is being refused, for the error message.
   */
  private async guardSpaceId(spaceId: string | undefined, what: string): Promise<void> {
    if (!this.spaceAllowlist) {
      return;
    }

    const allowed = (await this.getSpaces()).some((space) => space.id !== undefined && space.id === spaceId);
    if (!allowed) {
      throw new Error(`${what} is in a space that CONFLUENCE_ALLOWED_SPACES does not allow`);
    }
  }

  /**
   * Refuses a page outside the allowed spaces, looking its space up first (cached).
   *
   * @param pageId Page id.
   */
  private async guardPage(pageId: string): Promise<void> {
    if (!this.spaceAllowlist) {
      return;
    }

    const page = await this.cache.get(`page-space:${pageId}`, () =>
      this.http.get<ConfluencePage>(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`)
    );
    await this.guardSpaceId(page?.spaceId, `Page ${pageId}`);
  }

  get baseUrl(): string {
    return `${this.http.baseUrl}/wiki`;
  }

  /**
   * Fetches a Confluence page with its body in storage format.
   *
   * @param pageId Page id.
   * @returns Raw page with a storage-format body.
   */
  async getPage(pageId: string): Promise<ConfluencePage> {
    const page = await this.http.get<ConfluencePage>(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, {
      "body-format": "storage",
      "include-labels": "true"
    });
    await this.guardSpaceId(page?.spaceId, `Page ${pageId}`);
    return page;
  }

  /**
   * Fetches the ancestors of a page, top-most first.
   *
   * @param pageId Page id.
   * @returns Ancestor pages (breadcrumbs).
   */
  async getAncestors(pageId: string): Promise<ConfluenceAncestor[]> {
    await this.guardPage(pageId);
    const result = await this.http.get<{ results?: ConfluenceAncestor[] }>(
      `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/ancestors`
    );
    return result?.results ?? [];
  }

  /**
   * Resolves a page reference to a page id: an id passes through, a URL is parsed and a title is looked up
   * (within a space when one is given).
   *
   * @param ref Page id, page URL, or exact title.
   * @param spaceKey Space the title belongs to; recommended when ref is a title.
   * @returns The page id.
   */
  async resolvePageId(ref: string, spaceKey?: string): Promise<string> {
    const value = ref.trim();

    if (/^\d+$/.test(value)) {
      return value;
    }

    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      const id = url.searchParams.get("pageId") ?? url.pathname.match(/\/pages\/(\d+)/)?.[1];

      if (!id) {
        throw new Error(`Could not find a page id in the URL: ${value}`);
      }

      return id;
    }

    const query: Record<string, string> = { title: value, limit: "2" };
    if (spaceKey) {
      const spaces = await this.http.get<ConfluenceSpaceList>("/wiki/api/v2/spaces", { keys: spaceKey });
      const spaceId = spaces?.results?.[0]?.id;

      if (!spaceId) {
        throw new Error(`Confluence space not found: ${spaceKey}`);
      }

      query["space-id"] = spaceId;
    }

    const pages = await this.http.get<ConfluenceSpacePages>("/wiki/api/v2/pages", query);
    const found = pages?.results ?? [];

    if (!found.length || !found[0].id) {
      throw new Error(`No Confluence page titled "${value}"${spaceKey ? ` in space ${spaceKey}` : ""}`);
    }

    if (found.length > 1) {
      throw new Error(`Several pages are titled "${value}"; pass spaceKey or the page id`);
    }

    return found[0].id;
  }

  /**
   * Lists the direct children of a page.
   *
   * @param pageId Page id.
   * @param limit Page size.
   * @param cursor Cursor from the previous page.
   * @returns Raw v2 children response.
   */
  async getChildren(pageId: string, limit: number, cursor?: string): Promise<ConfluenceChildren> {
    await this.guardPage(pageId);
    return this.http.get<ConfluenceChildren>(
      `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/children`,
      pageQuery(limit, cursor)
    );
  }

  /**
   * Lists footer or inline comments of a page, with bodies in storage format.
   *
   * @param pageId Page id.
   * @param kind Footer or inline comments.
   * @param limit Page size.
   * @param cursor Cursor from the previous page.
   * @returns Raw v2 comments response.
   */
  async getComments(
    pageId: string,
    kind: "footer" | "inline",
    limit: number,
    cursor?: string
  ): Promise<ConfluenceComments> {
    await this.guardPage(pageId);
    return this.http.get<ConfluenceComments>(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}/${kind}-comments`, {
      ...pageQuery(limit, cursor),
      "body-format": "storage"
    });
  }

  /**
   * Lists the attachments of a page.
   *
   * @param pageId Page id.
   * @param limit Page size.
   * @param cursor Cursor from the previous page.
   * @returns Raw v2 attachments response.
   */
  async getAttachments(pageId: string, limit: number, cursor?: string): Promise<ConfluenceAttachments> {
    await this.guardPage(pageId);
    return this.http.get<ConfluenceAttachments>(
      `/wiki/api/v2/pages/${encodeURIComponent(pageId)}/attachments`,
      pageQuery(limit, cursor)
    );
  }

  /**
   * Fetches an attachment's metadata (title, media type, size, download link).
   *
   * @param attachmentId Attachment id, as returned by getAttachments.
   * @returns Attachment metadata.
   */
  async getAttachmentMeta(attachmentId: string): Promise<ConfluenceAttachment> {
    const meta = await this.http.get<ConfluenceAttachment>(
      `/wiki/api/v2/attachments/${encodeURIComponent(attachmentId)}`
    );

    if (this.spaceAllowlist) {
      if (!meta?.pageId) {
        throw new Error(
          `Attachment ${attachmentId} does not name its page, so CONFLUENCE_ALLOWED_SPACES cannot be applied`
        );
      }
      await this.guardPage(meta.pageId);
    }

    return meta;
  }

  /**
   * Streams an attachment to a file.
   *
   * @param meta Metadata of the attachment, holding its download link.
   * @param target File to write.
   * @param overwrite Replace an existing file.
   * @returns Bytes written and mime type.
   */
  async downloadAttachment(
    meta: ConfluenceAttachment,
    target: string,
    overwrite: boolean
  ): Promise<{ bytes: number; mimeType: string }> {
    if (!meta.downloadLink) {
      throw new Error(`Confluence attachment ${meta.id ?? ""} has no download link`);
    }

    // downloadLink is relative to the /wiki context.
    return this.http.downloadToFile(
      `/wiki${meta.downloadLink}`,
      `Confluence attachment ${meta.id ?? ""}`,
      target,
      overwrite
    );
  }

  /**
   * Lists the version history of a page, newest first.
   *
   * @param pageId Page id.
   * @param limit Page size.
   * @param cursor Cursor from the previous page.
   * @returns Raw v2 versions response.
   */
  async getVersions(pageId: string, limit: number, cursor?: string): Promise<ConfluenceVersions> {
    await this.guardPage(pageId);
    return this.http.get<ConfluenceVersions>(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}/versions`, {
      ...pageQuery(limit, cursor),
      sort: "-modified-date"
    });
  }

  /**
   * The v2 pages endpoint only filters by exact title, so fuzzy and full-text search go through v1 CQL.
   *
   * @param params Query text, labels (all must be present), contributor account id, limit, optional space and
   *   title-only restriction, and page cursor.
   * @returns Raw v1 search response.
   */
  async searchPages(params: {
    query?: string;
    labels?: string[];
    contributor?: string;
    limit: number;
    spaceKey?: string;
    titleOnly?: boolean;
    cursor?: string;
  }): Promise<ConfluenceSearchResult> {
    if (params.spaceKey) {
      this.guardSpace(params.spaceKey);
    }

    const labels = (params.labels ?? []).map((label) => label.trim()).filter(Boolean);
    const text = params.query?.trim();

    if (!text && !labels.length && !params.contributor) {
      throw new Error("Give a query, labels or a contributor to search for");
    }

    const clauses = [
      "type = page",
      ...(text ? [`${params.titleOnly ? "title" : "text"} ~ ${cqlSearchString(text)}`] : []),
      ...labels.map((label) => `label = ${jqlString(label)}`),
      ...(params.contributor ? [`contributor = ${jqlString(params.contributor)}`] : []),
      ...(params.spaceKey ? [`space = ${jqlString(params.spaceKey)}`] : []),
      ...(this.allowedSpaces ? [`space in (${this.allowedSpaces.map(jqlString).join(", ")})`] : [])
    ];

    const query: Record<string, string> = {
      cql: `${clauses.join(" AND ")} ORDER BY lastmodified DESC`,
      limit: String(params.limit)
    };
    if (params.cursor) {
      query.cursor = params.cursor;
    }

    return this.http.get<ConfluenceSearchResult>("/wiki/rest/api/search", query);
  }

  /**
   * Lists every visible Confluence space, following cursors; cached.
   *
   * @returns All spaces.
   */
  async getSpaces(): Promise<ConfluenceSpace[]> {
    const allowlist = this.spaceAllowlist;

    return this.cache.get("confluence-spaces", async () => {
      const spaces: ConfluenceSpace[] = [];
      let cursor: string | null = null;

      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const query: Record<string, string> = { limit: "250", sort: "key" };
        if (cursor) {
          query.cursor = cursor;
        }

        const result: ConfluenceSpaceList = await this.http.get<ConfluenceSpaceList>("/wiki/api/v2/spaces", query);
        spaces.push(...(result?.results ?? []));

        cursor = nextCursor(result?._links);

        if (!cursor) {
          break;
        }
      }

      return allowlist ? spaces.filter((space) => allowlist.has(space.key)) : spaces;
    });
  }

  /**
   * v2 lists pages by numeric space id, not by key, so the key is resolved first.
   *
   * @param spaceKey Space key.
   * @param limit Page size.
   * @param cursor Cursor from the previous page.
   * @returns Raw v2 pages response.
   */
  async getSpacePages(spaceKey: string, limit: number, cursor?: string): Promise<ConfluenceSpacePages> {
    this.guardSpace(spaceKey);
    const spaces = await this.http.get<ConfluenceSpaceList>("/wiki/api/v2/spaces", { keys: spaceKey });
    const spaceId = spaces?.results?.[0]?.id;

    if (!spaceId) {
      throw new Error(`Confluence space not found: ${spaceKey}`);
    }

    const query: Record<string, string> = { limit: String(limit), sort: "-modified-date" };
    if (cursor) {
      query.cursor = cursor;
    }

    return this.http.get<ConfluenceSpacePages>(`/wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/pages`, query);
  }

  /**
   * Reads the pages of a space page by page until `maxPages` are collected, for building a page tree.
   *
   * @param spaceKey Space key.
   * @param maxPages Stop after this many pages.
   * @returns The pages with their parent ids, and whether more exist.
   */
  async getSpaceTree(
    spaceKey: string,
    maxPages: number
  ): Promise<{ pages: ConfluencePageSummary[]; truncated: boolean }> {
    const pages: ConfluencePageSummary[] = [];
    let cursor: string | undefined;

    for (;;) {
      const result = await this.getSpacePages(spaceKey, Math.min(250, maxPages - pages.length), cursor);
      pages.push(...(result?.results ?? []));
      const next = nextCursor(result?._links) ?? undefined;

      if (!next) {
        return { pages, truncated: false };
      }

      if (pages.length >= maxPages) {
        return { pages, truncated: true };
      }

      cursor = next;
    }
  }

  /**
   * Fetches one historical version of a page with its body in storage format.
   *
   * @param pageId Page id.
   * @param version Version number.
   * @returns The page as it was in that version.
   */
  async getPageVersion(pageId: string, version: number): Promise<ConfluencePage> {
    const page = await this.http.get<ConfluencePage>(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, {
      "body-format": "storage",
      version: String(version)
    });
    await this.guardSpaceId(page?.spaceId, `Page ${pageId}`);
    return page;
  }
}

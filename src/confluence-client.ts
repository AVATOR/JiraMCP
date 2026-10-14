import type { ReferenceCache } from "./cache.js";
import { MAX_LIST_PAGES, type AtlassianHttp } from "./http.js";
import { cqlSearchString, jqlString } from "./query.js";
import type {
  ConfluenceAncestor,
  ConfluenceAttachment,
  ConfluenceAttachments,
  ConfluenceChildren,
  ConfluenceComments,
  ConfluencePage,
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
  constructor(
    private readonly http: AtlassianHttp,
    private readonly cache: ReferenceCache
  ) {}

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
    return this.http.get<ConfluencePage>(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}`, {
      "body-format": "storage",
      "include-labels": "true"
    });
  }

  /**
   * Fetches the ancestors of a page, top-most first.
   *
   * @param pageId Page id.
   * @returns Ancestor pages (breadcrumbs).
   */
  async getAncestors(pageId: string): Promise<ConfluenceAncestor[]> {
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
    return this.http.get<ConfluenceAttachment>(`/wiki/api/v2/attachments/${encodeURIComponent(attachmentId)}`);
  }

  /**
   * Downloads an attachment into memory.
   *
   * @param meta Metadata of the attachment, holding its download link.
   * @returns File bytes and mime type.
   */
  async downloadAttachment(meta: ConfluenceAttachment): Promise<{ data: Buffer; mimeType: string }> {
    if (!meta.downloadLink) {
      throw new Error(`Confluence attachment ${meta.id ?? ""} has no download link`);
    }

    // downloadLink is relative to the /wiki context.
    return this.http.download(`/wiki${meta.downloadLink}`, `Confluence attachment ${meta.id ?? ""}`);
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
    return this.http.get<ConfluenceVersions>(`/wiki/api/v2/pages/${encodeURIComponent(pageId)}/versions`, {
      ...pageQuery(limit, cursor),
      sort: "-modified-date"
    });
  }

  /**
   * The v2 pages endpoint only filters by exact title, so fuzzy and full-text search go through v1 CQL.
   *
   * @param params Query text, limit, optional space and title-only restriction, and page cursor.
   * @returns Raw v1 search response.
   */
  async searchPages(params: {
    query: string;
    limit: number;
    spaceKey?: string;
    titleOnly?: boolean;
    cursor?: string;
  }): Promise<ConfluenceSearchResult> {
    const clauses = [
      "type = page",
      `${params.titleOnly ? "title" : "text"} ~ ${cqlSearchString(params.query)}`,
      ...(params.spaceKey ? [`space = ${jqlString(params.spaceKey)}`] : [])
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

        cursor =
          typeof result?._links?.next === "string"
            ? new URL(result._links.next, "http://x").searchParams.get("cursor")
            : null;

        if (!cursor) {
          break;
        }
      }

      return spaces;
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
}

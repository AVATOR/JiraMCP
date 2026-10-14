import type { ReferenceCache } from "./cache.js";
import { MAX_LIST_PAGES, type AtlassianHttp } from "./http.js";
import { jqlString } from "./query.js";
import type {
  ConfluencePage,
  ConfluenceSearchResult,
  ConfluenceSpace,
  ConfluenceSpaceList,
  ConfluenceSpacePages
} from "./types.js";

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
      "body-format": "storage"
    });
  }

  /**
   * The v2 pages endpoint only filters by exact title, so fuzzy and full-text search go through v1 CQL.
   *
   * @param params Query text, limit and optional space and title-only restriction.
   * @returns Raw v1 search response.
   */
  async searchPages(params: {
    query: string;
    limit: number;
    spaceKey?: string;
    titleOnly?: boolean;
  }): Promise<ConfluenceSearchResult> {
    const clauses = [
      "type = page",
      `${params.titleOnly ? "title" : "text"} ~ ${jqlString(params.query)}`,
      ...(params.spaceKey ? [`space = ${jqlString(params.spaceKey)}`] : [])
    ];

    return this.http.get<ConfluenceSearchResult>("/wiki/rest/api/search", {
      cql: `${clauses.join(" AND ")} ORDER BY lastmodified DESC`,
      limit: String(params.limit)
    });
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

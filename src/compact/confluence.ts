// Renders Confluence REST payloads as compact Markdown.

import { storageToMarkdown } from "../storage.js";
import type {
  ConfluenceAttachment,
  ConfluenceChildren,
  ConfluenceComment,
  ConfluencePage,
  ConfluenceSearchResult,
  ConfluenceSpace,
  ConfluenceSpacePages,
  ConfluenceVersion
} from "../types.js";
import { nextCursor } from "../query.js";
import { countLine, fileSize, shortDate, table } from "./common.js";

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
      table(
        ["Key", "Name", "Type", "Status"],
        spaces.map((space) => [space.key, space.name, space.type ?? "", space.status ?? ""])
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
      table(
        ["Id", "Title", "Space", "Modified"],
        pages.map((page) => {
          // The key is what confluence_get_space_pages takes; displayUrl is "/spaces/<KEY>".
          const space =
            page.resultGlobalContainer?.displayUrl?.match(/\/spaces\/([^/]+)/)?.[1] ??
            page.content?.space?.key ??
            page.resultGlobalContainer?.title ??
            "";
          return [page.content?.id, page.content?.title ?? page.title, space, shortDate(page.lastModified)];
        })
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
      table(
        ["Id", "Title", "Parent", "Modified"],
        pages.map((page) => [page.id, page.title, page.parentId ?? "", shortDate(page.version?.createdAt)])
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
 * @param ancestors Ancestor pages, top-most first, shown as the page path.
 * @returns Title, metadata and body as Markdown.
 */
export function formatConfluencePage(
  page: ConfluencePage,
  wikiBaseUrl: string,
  ancestors: { id?: string; title?: string }[] = []
): string {
  const lines = [`# ${page?.title ?? ""}`, ""];
  const meta: [string, string | undefined][] = [
    ["Id", page?.id],
    ["Space id", page?.spaceId],
    ["Parent", page?.parentId],
    [
      "Version",
      page?.version?.number !== undefined ? `${page.version.number} (${shortDate(page.version.createdAt)})` : ""
    ],
    ["Url", page?._links?.webui ? `${wikiBaseUrl}${page._links.webui}` : ""],
    ["Path", ancestors.map((ancestor) => `${ancestor.title} (${ancestor.id})`).join(" › ")],
    ["Labels", (page?.labels?.results ?? []).map((label) => label.name).join(", ")]
  ];

  for (const [label, value] of meta) {
    if (value) {
      lines.push(`- **${label}:** ${value}`);
    }
  }

  lines.push("", storageToMarkdown(page?.body?.storage?.value ?? "") || "_(empty)_");
  return lines.join("\n");
}

/**
 * Renders the child pages of a page, with the cursor when more exist.
 *
 * @param result Response of the v2 children endpoint.
 * @param pageId Parent page id shown in the header.
 * @returns Markdown table.
 */
export function formatConfluenceChildren(result: ConfluenceChildren, pageId: string): string {
  const pages = result?.results ?? [];
  const lines = [`Page ${pageId} — ${pages.length} child pages`];

  if (pages.length) {
    lines.push(
      "",
      table(
        ["Id", "Title"],
        pages.map((page) => [page.id, page.title])
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
 * Renders page comments, converting the storage-format bodies to Markdown.
 *
 * @param comments Comments of one kind.
 * @param view Page id, comment kind and the next cursor.
 * @returns Markdown with one block per comment.
 */
export function formatConfluenceComments(
  comments: ConfluenceComment[],
  view: { pageId: string; kind: string; cursor: string | null }
): string {
  const header = `Page ${view.pageId} — ${comments.length} ${view.kind} comments`;
  const blocks = comments.map((comment) => {
    const status =
      comment.resolutionStatus && comment.resolutionStatus !== "open" ? ` · ${comment.resolutionStatus}` : "";
    const title = `### ${shortDate(comment.version?.createdAt)} — author ${comment.version?.authorId ?? "?"} · id ${comment.id}${status}`;
    return `${title}\n${storageToMarkdown(comment.body?.storage?.value ?? "") || "_(empty)_"}`;
  });
  const lines = [header, ...blocks];

  if (view.cursor) {
    lines.push(`cursor: ${view.cursor}`);
  }

  return lines.join("\n\n");
}

/**
 * Renders the attachments of a Confluence page.
 *
 * @param result Response of the v2 attachments endpoint.
 * @param pageId Page id shown in the header.
 * @returns Markdown table with the ids needed by confluence_download_attachment.
 */
export function formatConfluenceAttachments(
  result: { results?: ConfluenceAttachment[]; _links?: { next?: string } },
  pageId: string
): string {
  const attachments = result?.results ?? [];
  const lines = [`Page ${pageId} — ${attachments.length} attachments`];

  if (attachments.length) {
    lines.push(
      "",
      table(
        ["Id", "Filename", "Type", "Size", "Created"],
        attachments.map((attachment) => [
          attachment.id,
          attachment.title,
          attachment.mediaType,
          fileSize(attachment.fileSize),
          shortDate(attachment.createdAt ?? attachment.version?.createdAt)
        ])
      ),
      "",
      "Download one with confluence_download_attachment (attachmentId from the Id column)."
    );
  }

  const cursor = nextCursor(result?._links);
  if (cursor) {
    lines.push("", `cursor: ${cursor}`);
  }

  return lines.join("\n");
}

/**
 * Renders the version history of a page.
 *
 * @param result Response of the v2 versions endpoint.
 * @param pageId Page id shown in the header.
 * @returns Markdown table, newest version first.
 */
export function formatConfluenceVersions(
  result: { results?: ConfluenceVersion[]; _links?: { next?: string } },
  pageId: string
): string {
  const versions = result?.results ?? [];
  const lines = [`Page ${pageId} — ${versions.length} versions (newest first)`];

  if (versions.length) {
    lines.push(
      "",
      table(
        ["Version", "Date", "Author", "Message"],
        versions.map((version) => [
          version.number,
          shortDate(version.createdAt),
          version.authorId ?? "",
          `${version.minorEdit ? "(minor) " : ""}${version.message ?? ""}`
        ])
      )
    );
  }

  const cursor = nextCursor(result?._links);
  if (cursor) {
    lines.push("", `cursor: ${cursor}`);
  }

  return lines.join("\n");
}

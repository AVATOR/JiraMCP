# Changelog

## Unreleased

### Added

- `jira_get_issue_links`: follows issue links, parent/epic and subtasks up to 3 levels and returns the issues with
  the relations between them in one call.

## 0.3.0

### Added

- MCP resources `jira://issue/{key}` and `confluence://page/{id}`, and prompts `summarize_issue`,
  `release_notes` and `summarize_page`.
- Streamable HTTP transport (`MCP_TRANSPORT=http`) with bearer-token auth; the download tools are off there.
- Confluence tools: page children, comments, attachments (list and download), versions, lookup by URL or title,
  labels and breadcrumbs, cursor for search.
- Jira tools: changelog, worklogs, transitions, metadata (statuses, issue types, priorities), project details,
  saved filters, remote links, Agile boards, sprints and sprint issues, projects and users.
- `structuredContent` and `outputSchema` on every tool; `fields` and `includeTotal` for `jira_search_issues`.
- Short cache for issue and comment reads (`JIRA_ISSUE_CACHE_SECONDS`) and for reference data.
- `JIRA_ATTACHMENT_ROOTS` to allow extra download directories.

### Security

- `outputPath` of the download tools must be inside `JIRA_ATTACHMENT_DIR` or `JIRA_ATTACHMENT_ROOTS`
  (relative paths resolve in the download directory; symlinks are followed before the check).
- `structuredContent` carries `untrusted: true` for results with third-party text.
- The ADF and storage converters no longer throw on hostile content (huge character references, negative heading
  levels, malformed nodes, deep nesting).

### Changed

- Downloads are streamed to disk, limited to 100 MB.
- Requests are retried on 502 and 504 as well as 429 and 503.
- CQL special characters in `confluence_search_pages` are escaped.

## 0.2.0

- Initial public version: read-only Jira issue, search, comment and attachment tools, Confluence pages and search,
  interactive installer.

# Jira Read-Only MCP Server

TypeScript MCP server for Jira Cloud with read-only access.

## Capabilities

- Read a Jira issue by key (incl. parent, subtasks, links, components, configured custom fields)
- Search issues by JQL, with `nextPageToken` pagination
- List project issues
- Read comments for an issue (newest first, date filter, truncation of large payloads)
- List and download issue attachments (images are returned inline)
- Find field ids (including `customfield_*`) by name, list projects, find users and the current user
- Issue history (changelog), worklogs, available transitions, remote links, project components and versions
- Statuses, issue types and priorities for JQL, saved filters (list and run), Agile boards, sprints and sprint issues
- Read Confluence pages as Markdown, full-text search them (optionally per space) and list spaces and a space's pages

This server does not expose any methods for creating or updating issues, comments, transitions, or any other Jira entities.

## Environment

Copy `.env.example` to `.env` and fill in your credentials.

Required variables:

- `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`

Optional variables:

- `JIRA_DEFAULT_PROJECT` — project used by `jira_get_project_issues` when no key is given
- `JIRA_CUSTOM_FIELDS` — see below
- `JIRA_ATTACHMENT_DIR` — where downloaded attachments go (default: `<tmp>/jira-attachments`)
- `JIRA_ATTACHMENT_ROOTS` — extra directories (separated like `PATH`) an explicit `outputPath` may point into; by default only `JIRA_ATTACHMENT_DIR` is allowed
- `JIRA_ISSUE_CACHE_SECONDS` — how long issue and comment reads are reused (default `30`, `0` disables)
- `MCP_TRANSPORT`, `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_HTTP_TOKEN` — Streamable HTTP, see below

### Getting a Jira API token

The server authenticates to Jira Cloud with basic auth: your account email plus
an API token. It never asks for your password, and it cannot use one.

1. Sign in to Atlassian with the account whose Jira access you want the server
   to have, then open
   [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens).
   The same page is reachable from any Atlassian page: avatar → **Manage
   account** → **Security** → **Create and manage API tokens**.
2. Click **Create API token**, give it a label you will recognise later (for
   example `jira-mcp — laptop`), pick an expiry, and confirm.
3. Copy the token immediately — Atlassian shows it only once. If you lose it,
   revoke that token and create a new one.
4. Paste it when `npx jira-mcp-add` asks for the API token (input is hidden), or
   put it into `JIRA_API_TOKEN`.

Notes:

- `JIRA_EMAIL` must be the email of that same Atlassian account, otherwise Jira
  answers `401 Unauthorized`.
- The token inherits your own permissions. To limit what the agent can see, make
  the token on a dedicated Atlassian account with access to just those projects.
  The server is read-only regardless, but the token itself is not.
- `JIRA_BASE_URL` is your site root, for example `https://your-company.atlassian.net`,
  with no `/jira` or `/browse/...` suffix. It must be `https://`: Basic auth sends the
  token with every request, so plain `http://` is refused (only `localhost` is allowed, for tests).
- Jira **Data Center / Server** (self-hosted) uses personal access tokens instead
  and is not covered by this setup.
- Revoke a token on the same page the moment it leaks — for instance if it ends
  up pasted into a chat, a commit, or a shared config file.

### Custom fields

Custom field ids differ between Jira projects, so they are configured per MCP
connection rather than hardcoded. `JIRA_CUSTOM_FIELDS` takes a comma-separated
list of `customfield_<id>:<alias>` pairs. The alias is optional; without it the
raw field id is used.

```
JIRA_CUSTOM_FIELDS=customfield_10145:requirements,customfield_10170:discoveryQuestions
```

Listed fields are requested by `jira_get_issue` and exposed under their alias in
both `fields` and `renderedFields` (the latter holds the HTML rendering, which is
usually the readable one). The raw ids stay in the response as well.

To discover the ids available on a Jira instance, ask the agent to call
`jira_list_fields` with a name filter (e.g. `query: "requirements"`).

If the variable is unset, no custom fields are requested and only the base issue
fields are returned.

## Install

Requires Node.js 20+; Node 24 LTS is recommended. In a checkout the version is
pinned for both [nvm](https://github.com/nvm-sh/nvm) (`.nvmrc`) and
[Volta](https://volta.sh) (`volta` in `package.json`): run `nvm use` in the project
directory, or let Volta switch automatically.

```bash
npm install -D jira-readonly-mcp
npx jira-mcp-add
```

`jira-mcp-add` is an interactive setup wizard. It:

- asks for the Jira base URL, account email and API token (hidden input);
- verifies the credentials against `/rest/api/3/myself` and reports whether
  Confluence is reachable with the same token;
- offers the project keys the account can see, for `JIRA_DEFAULT_PROJECT`;
- resolves custom fields by display name to their `customfield_*` ids;
- creates the attachment download directory;
- when run from a checkout, offers to launch the server from that local build
  (absolute `node` path plus `cwd`) instead of `npx`;
- loops, so several Jira sites can be added in one run.

It then writes the server entry into one of:

- `.mcp.json` (Claude Code, this project)
- `.cursor/mcp.json` (Cursor)
- `.vscode/mcp.json` (VS Code / Copilot)
- `~/.claude.json` (Claude Code, all projects)

Existing entries in those files are preserved, and the wizard offers to add the
written file to `.gitignore`, since it holds the API token in plain text. Your
own `package.json` is never touched.

`npx jira-mcp-add --print` runs the same questions but prints the JSON instead
of writing it, for pasting into a config by hand.

## Run

The MCP client starts the server itself, using the generated configuration. To
run it manually:

```bash
npx jira-mcp
```

Started this way the server reads `JIRA_*` from the environment and from a `.env`
file in the current directory, so each project can keep its own Jira settings. Only
when the current directory has no `.env`, the one next to the server code (the
project root of a checkout) is used instead; the two files are never mixed.
Variables set by the client (its `env` config) take precedence over the file.

### Streamable HTTP (one server for a team)

By default the client starts the server over stdio. To run one shared server instead:

```bash
MCP_TRANSPORT=http MCP_HTTP_TOKEN=choose-a-long-random-string npx jira-mcp
# listening on http://127.0.0.1:3000/mcp
```

Clients then connect to `http://<host>:3000/mcp` and send `Authorization: Bearer <token>`.

- `MCP_HTTP_HOST` (default `127.0.0.1`) and `MCP_HTTP_PORT` (default `3000`) set the address.
  Listening beyond loopback requires `MCP_HTTP_TOKEN`; the server refuses to start otherwise,
  because every caller reads Jira with the configured account.
- Stateless: `POST /mcp` only (GET answers 405), `GET /healthz` for health checks. Put it behind
  TLS (a reverse proxy) when it leaves your machine; the token travels in a header.
- The attachment download tools are not registered in this mode, since they would write to the
  server's disk. `jira_list_attachments` and `confluence_list_attachments` still work.
- The reference and issue caches are shared by all callers.

For local development from a checkout:

```bash
npm install
npm run build
npm run dev      # run the server from source
npm run setup    # run the setup wizard from source
```

## MCP Tools

- `jira_get_issue`
- `jira_search_issues`
- `jira_get_project_issues`
- `jira_get_comments`
- `jira_list_attachments`
- `jira_download_attachment`
- `jira_list_fields`
- `jira_list_projects`
- `jira_get_current_user`
- `jira_find_users`
- `jira_get_changelog`
- `jira_get_worklogs`
- `jira_list_transitions`
- `jira_list_metadata`
- `jira_get_project`
- `jira_list_filters`
- `jira_run_filter`
- `jira_get_remote_links`
- `jira_list_boards`
- `jira_list_sprints`
- `jira_get_sprint_issues`
- `confluence_get_page`
- `confluence_get_page_children`
- `confluence_get_page_comments`
- `confluence_list_attachments`
- `confluence_download_attachment`
- `confluence_get_page_versions`
- `confluence_search_pages`
- `confluence_get_space_pages`
- `confluence_list_spaces`

## MCP Resources and Prompts

Resources let a client attach an issue or page as context without a tool call:

- `jira://issue/{key}` — an issue as Markdown, e.g. `jira://issue/ABC-123`
- `confluence://page/{id}` — a page as Markdown, e.g. `confluence://page/123456`

Bodies above 40,000 characters are cut, with a pointer to `jira_get_issue` or `confluence_get_page`
for the rest.

Prompts are ready-made instructions that name the tools to call:

- `summarize_issue` (`issueKey`) — state, decisions, open questions and next steps
- `release_notes` (`jql`, optional `audience`) — release notes grouped by issue type
- `summarize_page` (`pageId`) — key points and action items of a Confluence page

## Structured output

Every tool declares an `outputSchema` and returns `structuredContent` next to the Markdown text:
the same compact fields the Markdown shows, as JSON, so clients can use the data without parsing
tables. `raw: true` only changes the text part to the unprocessed Jira JSON.
`jira_search_issues` also accepts `includeTotal` for an approximate total.

## Security model

- The server uses Jira/Confluence REST API GET endpoints (plus one read-only POST,
  `search/approximate-count`, behind an allowlist); every request goes through
  a single HTTP client (30 s per attempt, 45 s in total; retries on HTTP 429/502/503/504 honouring `Retry-After`, but never waiting past the 45 s).
- No MCP tools for mutations are registered; every tool is annotated `readOnlyHint`.
- Jira/Confluence text is untrusted: Markdown results end with a note saying so, `structuredContent`
  carries `untrusted: true`, and the server instructions tell the client not to follow instructions found in it.
- Issue and comment reads are cached for 30 s (`JIRA_ISSUE_CACHE_SECONDS`), so a repeated read can
  be that stale.
- The only local side effect is `jira_download_attachment` writing a file (off in HTTP mode). An explicit
  `outputPath` never overwrites an existing file and must stay inside `JIRA_ATTACHMENT_DIR` or a
  directory from `JIRA_ATTACHMENT_ROOTS` (symlinks are resolved), since attachment content is untrusted.
  Downloads above 100 MB are refused.

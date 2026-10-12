# Jira Read-Only MCP Server

TypeScript MCP server for Jira Cloud with read-only access.

## Capabilities

- Read a Jira issue by key
- Search issues by JQL
- List project issues
- Read comments for an issue
- Read transitions and issue metadata exposed by Jira REST GET endpoints

This server does not expose any methods for creating or updating issues, comments, transitions, or any other Jira entities.

## Environment

Copy `.env.example` to `.env` and fill in your credentials.

Required variables:

- `JIRA_BASE_URL`
- `JIRA_EMAIL`
- `JIRA_API_TOKEN`

Optional variables:

- `JIRA_DEFAULT_PROJECT`
- `JIRA_CUSTOM_FIELDS`
- `JIRA_ATTACHMENT_DIR`

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
  with no `/jira` or `/browse/...` suffix.
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

To discover the ids available on a Jira instance, call `/rest/api/3/field` and
match on the field name.

If the variable is unset, no custom fields are requested and only the base issue
fields are returned.

## Install

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

Started this way the server reads `JIRA_*` from the environment, including a
`.env` file in the current directory.

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
- `confluence_get_page`
- `confluence_search_pages`
- `confluence_get_space_pages`

## Security model

- The server uses Jira REST API GET endpoints only.
- The HTTP client rejects non-GET methods at runtime.
- No MCP tools for mutations are registered.
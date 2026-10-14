#!/usr/bin/env node
import dotenv from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { startHttpServer } from "./http-server.js";
import { createCaches, createServer, parseCustomFields, projectRoot, type JiraClientConfig } from "./server.js";

// Each project can carry its own .env in the directory the server is started from; only
// when there is none, the .env next to the MCP code (dist/ or src/ -> ..) is used. The
// files are never mixed, so one site's URL cannot pair with another site's token.
// dotenv never overrides, so variables set by the client win; quiet keeps it from
// writing to stdout, which carries the MCP protocol.
const cwdEnv = path.resolve(".env");
dotenv.config({
  path: existsSync(cwdEnv) ? cwdEnv : path.join(projectRoot, ".env"),
  quiet: true
});

/**
 * Reads a required environment variable or fails with its name.
 *
 * @param name Environment variable name.
 * @returns The trimmed value; throws when it is missing or blank.
 */
function getRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

/**
 * Reads a non-negative number of seconds from an environment variable.
 *
 * @param name Environment variable name.
 * @returns Milliseconds, or undefined when unset; throws on invalid values.
 */
function getSecondsEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }

  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`${name} must be a number of seconds, 0 or more`);
  }

  return seconds * 1000;
}

/** Builds the server from the environment and serves it over stdio, or over HTTP with MCP_TRANSPORT=http. */
async function main() {
  const config: JiraClientConfig = {
    baseUrl: getRequiredEnv("JIRA_BASE_URL"),
    email: getRequiredEnv("JIRA_EMAIL"),
    apiToken: getRequiredEnv("JIRA_API_TOKEN"),
    defaultProject: process.env.JIRA_DEFAULT_PROJECT?.trim() || undefined,
    customFields: parseCustomFields(process.env.JIRA_CUSTOM_FIELDS)
  };
  const issueCacheTtlMs = getSecondsEnv("JIRA_ISSUE_CACHE_SECONDS");
  const transport = process.env.MCP_TRANSPORT?.trim().toLowerCase() || "stdio";

  if (transport === "http") {
    const host = process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1";
    const port = Number(process.env.MCP_HTTP_PORT?.trim() || "3000");

    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error("MCP_HTTP_PORT must be a port number");
    }

    // One cache for all requests; downloads write to the server's disk, so they stay off.
    const caches = createCaches({ issueCacheTtlMs });
    const running = await startHttpServer({
      host,
      port,
      token: process.env.MCP_HTTP_TOKEN?.trim() || undefined,
      createServer: () => createServer(config, { caches, downloads: false })
    });
    console.error(`jira-readonly-mcp listening on http://${host}:${running.port}/mcp`);
    return;
  }

  if (transport !== "stdio") {
    throw new Error(`MCP_TRANSPORT must be "stdio" or "http", got "${transport}"`);
  }

  const server = createServer(config, { issueCacheTtlMs });
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

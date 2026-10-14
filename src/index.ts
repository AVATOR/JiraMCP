#!/usr/bin/env node
import dotenv from "dotenv";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { createServer, parseCustomFields, projectRoot } from "./server.js";

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

/** Builds the server from the environment and serves it over stdio. */
async function main() {
  const server = createServer({
    baseUrl: getRequiredEnv("JIRA_BASE_URL"),
    email: getRequiredEnv("JIRA_EMAIL"),
    apiToken: getRequiredEnv("JIRA_API_TOKEN"),
    defaultProject: process.env.JIRA_DEFAULT_PROJECT?.trim() || undefined,
    customFields: parseCustomFields(process.env.JIRA_CUSTOM_FIELDS)
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

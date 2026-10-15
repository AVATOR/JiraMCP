// The entry point as a child process: environment parsing and transport selection.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { projectRoot } from "./server.js";

const entryPoint = path.join(projectRoot, "dist", "index.js");

type Run = { code: number | null; stderr: string };

/**
 * Starts the built server with the given variables and a cwd with an empty .env.
 *
 * @param env Environment on top of valid Jira credentials.
 * @param until Resolves the run early (and kills the child) once stderr matches.
 * @returns Exit code (null when killed) and everything written to stderr.
 */
async function run(env: Record<string, string>, until?: RegExp): Promise<Run> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "jira-mcp-index-"));
  await writeFile(path.join(cwd, ".env"), "");

  const child = spawn(process.execPath, [entryPoint], {
    cwd,
    env: {
      PATH: process.env.PATH,
      NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE,
      JIRA_BASE_URL: "https://example.atlassian.net",
      JIRA_EMAIL: "me@example.com",
      JIRA_API_TOKEN: "secret",
      ...env
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";

  try {
    return await new Promise<Run>((resolve) => {
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (until?.test(stderr)) {
          child.kill("SIGTERM");
        }
      });
      child.on("close", (code) => resolve({ code, stderr }));
    });
  } finally {
    child.kill();
    await rm(cwd, { recursive: true, force: true });
  }
}

test("an unknown MCP_TRANSPORT is rejected with its value", async () => {
  const result = await run({ MCP_TRANSPORT: "carrier-pigeon" });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /MCP_TRANSPORT must be "stdio" or "http", got "carrier-pigeon"/);
});

test("invalid numbers are rejected before the server starts", async () => {
  const seconds = await run({ JIRA_ISSUE_CACHE_SECONDS: "soon" });
  assert.equal(seconds.code, 1);
  assert.match(seconds.stderr, /JIRA_ISSUE_CACHE_SECONDS must be a number of seconds/);

  const port = await run({ MCP_TRANSPORT: "http", MCP_HTTP_PORT: "99999" });
  assert.equal(port.code, 1);
  assert.match(port.stderr, /MCP_HTTP_PORT must be a port number/);
});

test("http transport refuses a public bind without a token", async () => {
  const result = await run({ MCP_TRANSPORT: "http", MCP_HTTP_HOST: "0.0.0.0", MCP_HTTP_PORT: "0" });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /without MCP_HTTP_TOKEN/);
});

test("http transport starts on loopback and says where it listens", async () => {
  const result = await run({ MCP_TRANSPORT: "http", MCP_HTTP_PORT: "0" }, /listening on/);

  assert.match(result.stderr, /jira-readonly-mcp listening on http:\/\/127\.0\.0\.1:\d+\/mcp/);
});

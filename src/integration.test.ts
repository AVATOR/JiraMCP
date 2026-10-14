// Tests against a real HTTP server on localhost (no fetch stub): what the stubbed tests in
// server.test.ts cannot see, such as redirects, auth headers on the wire and broken responses.
// The last tests also start the built server as a child process and talk to it over stdio.
import { after, afterEach, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createServer, projectRoot } from "./server.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

type MockSite = { server: Server; url: string; requests: IncomingMessage[]; handler: Handler };

// A listening mock site; `handler` is swapped per test and every request is recorded.
async function startSite(): Promise<MockSite> {
  const site: MockSite = {
    server: createHttpServer((request, response) => {
      site.requests.push(request);
      site.handler(request, response);
    }),
    url: "",
    requests: [],
    handler: (_request, response) => response.writeHead(404).end("Not found")
  };

  await new Promise<void>((resolve) => site.server.listen(0, "127.0.0.1", resolve));
  site.url = `http://127.0.0.1:${(site.server.address() as AddressInfo).port}`;
  return site;
}

const sendJson = (response: ServerResponse, body: unknown, status = 200) =>
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

let jira: MockSite;
let media: MockSite;
let client: Client | undefined;
let tempDir: string;

before(async () => {
  jira = await startSite();
  media = await startSite();
  tempDir = await mkdtemp(path.join(os.tmpdir(), "jira-mcp-integration-"));
});

after(async () => {
  jira.server.closeAllConnections();
  media.server.closeAllConnections();
  await Promise.all([
    new Promise((resolve) => jira.server.close(resolve)),
    new Promise((resolve) => media.server.close(resolve)),
    rm(tempDir, { recursive: true, force: true })
  ]);
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  jira.requests.length = 0;
  media.requests.length = 0;
  jira.handler = (_request, response) => response.writeHead(404).end("Not found");
  media.handler = (_request, response) => response.writeHead(404).end("Not found");
});

async function connect() {
  const server = createServer(
    { baseUrl: jira.url, email: "me@example.com", apiToken: "secret", customFields: [] },
    { downloadDir: tempDir }
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(c: Client, name: string, args: Record<string, unknown>) {
  const result = (await c.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: result.isError === true, text: result.content[0]?.text ?? "" };
}

test("requests carry basic auth and a GET method over real HTTP", async () => {
  jira.handler = (_request, response) => sendJson(response, { accountId: "a1", displayName: "Ann" });

  const { text } = await call(await connect(), "jira_get_current_user", {});

  assert.match(text, /Ann/);
  const request = jira.requests[0];
  assert.equal(request.method, "GET");
  assert.equal(request.headers.authorization, `Basic ${Buffer.from("me@example.com:secret").toString("base64")}`);
  assert.equal(request.headers.accept, "application/json");
});

for (const [status, statusText] of [
  [401, "Unauthorized"],
  [403, "Forbidden"],
  [404, "Not Found"]
] as const) {
  test(`${status} responses become tool errors that name the status and path`, async () => {
    jira.handler = (_request, response) => response.writeHead(status, statusText).end(`{"errorMessages":["nope"]}`);

    const { isError, text } = await call(await connect(), "jira_get_issue", { issueKey: "ABC-1" });

    assert.equal(isError, true);
    assert.match(text, new RegExp(`Jira request failed \\(${status} ${statusText}\\) for /rest/api/3/issue/ABC-1`));
    assert.equal(jira.requests.length, 1, "client errors are not retried");
  });
}

test("a persistently rate-limited site is given up on after the retry budget", async () => {
  jira.handler = (_request, response) => response.writeHead(429, { "retry-after": "0" }).end("slow down");

  const { isError, text } = await call(await connect(), "jira_get_issue", { issueKey: "ABC-1" });

  assert.equal(isError, true);
  assert.match(text, /429/);
  assert.equal(jira.requests.length, 4, "one attempt plus three retries");
});

test("a response cut off mid-body is reported as an error, not a crash", async () => {
  jira.handler = (_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
    response.write('{"key":"ABC-1","fields":');
    setTimeout(() => response.destroy(), 10);
  };

  const c = await connect();
  const { isError } = await call(c, "jira_get_issue", { issueKey: "ABC-1" });

  assert.equal(isError, true);
  jira.handler = (_request, response) => sendJson(response, { accountId: "a1", displayName: "Ann" });
  assert.equal((await call(c, "jira_get_current_user", {})).isError, false, "the server keeps working");
});

test("invalid JSON with a JSON content type is reported as an error", async () => {
  jira.handler = (_request, response) =>
    response.writeHead(200, { "content-type": "application/json" }).end("{not json");

  const { isError } = await call(await connect(), "jira_get_issue", { issueKey: "ABC-1" });

  assert.equal(isError, true);
});

test("an HTML error page is trimmed in the error message", async () => {
  jira.handler = (_request, response) =>
    response.writeHead(500, { "content-type": "text/html" }).end(`<html>${"x".repeat(50_000)}</html>`);

  const { isError, text } = await call(await connect(), "jira_get_issue", { issueKey: "ABC-1" });

  assert.equal(isError, true);
  assert.ok(text.length < 1500, `error text is ${text.length} chars`);
});

test("attachment download follows the redirect and does not leak credentials to the media host", async () => {
  jira.handler = (request, response) => {
    if (request.url?.startsWith("/rest/api/3/attachment/content/")) {
      response.writeHead(302, { location: `${media.url}/signed/file.txt` }).end();
    } else {
      sendJson(response, { filename: "notes.txt", mimeType: "text/plain", size: 5 });
    }
  };
  media.handler = (_request, response) => response.writeHead(200, { "content-type": "text/plain" }).end("hello");

  const { isError, text } = await call(await connect(), "jira_download_attachment", { attachmentId: "42" });

  assert.equal(isError, false, text);
  assert.match(text, /Saved notes.txt \(text\/plain, 5 bytes\)/);
  assert.equal(media.requests.length, 1);
  assert.equal(media.requests[0].headers.authorization, undefined, "Authorization must not reach the media host");
  assert.ok(
    jira.requests.some((request) => request.headers.authorization),
    "the Jira call is authenticated"
  );
});

// --- The built server as a child process, over stdio ---------------------------------------

const entryPoint = path.join(projectRoot, "dist", "index.js");

// A cwd with an empty .env keeps the developer's real .env out of these runs.
async function emptyEnvDir() {
  const dir = await mkdtemp(path.join(tempDir, "cwd-"));
  await writeFile(path.join(dir, ".env"), "");
  return dir;
}

test("smoke: the built server starts over stdio, lists its tools and answers a call", async () => {
  jira.handler = (_request, response) => sendJson(response, { accountId: "a1", displayName: "Smoke Tester" });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entryPoint],
    cwd: await emptyEnvDir(),
    env: { JIRA_BASE_URL: jira.url, JIRA_EMAIL: "me@example.com", JIRA_API_TOKEN: "secret" },
    stderr: "pipe"
  });
  client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  for (const expected of ["jira_get_issue", "jira_search_issues", "confluence_get_page", "jira_download_attachment"]) {
    assert.ok(names.includes(expected), `${expected} is listed`);
  }
  assert.ok(
    tools.every((tool) => tool.annotations?.readOnlyHint === true),
    "every tool is read only"
  );

  const { text } = await call(client, "jira_get_current_user", {});
  assert.match(text, /Smoke Tester/);
});

test("smoke: the built server exits with a clear message when configuration is missing", async () => {
  const child = spawn(process.execPath, [entryPoint], {
    cwd: await emptyEnvDir(),
    env: { PATH: process.env.PATH },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));

  assert.notEqual(code, 0);
  assert.match(stderr, /Missing required environment variable: JIRA_BASE_URL/);
});

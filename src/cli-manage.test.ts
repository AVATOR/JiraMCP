// jira-mcp-add --list / --remove: finding the entries the wizard wrote, checking tokens, removing entries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkToken, findEntries, removeEntry } from "./cli/manage.js";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "jira-mcp-manage-"));
}
async function withProject(entries: Record<string, unknown>, run: (dir: string, file: string) => Promise<void>) {
  const dir = await tempDir();
  const file = path.join(dir, ".mcp.json");

  try {
    await writeFile(file, JSON.stringify({ other: 1, mcpServers: entries }));
    await run(dir, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const jiraEntry = (token: string) => ({
  command: "npx",
  env: { JIRA_BASE_URL: "https://x.atlassian.net/", JIRA_EMAIL: "me@x.com", JIRA_API_TOKEN: token }
});

test("findEntries lists server entries with Jira credentials and skips the rest and broken files", async () => {
  await withProject({ jira: jiraEntry("t1"), github: { command: "gh", env: { TOKEN: "x" } } }, async (dir) => {
    await mkdir(path.join(dir, ".cursor"));
    await writeFile(path.join(dir, ".cursor", "mcp.json"), "{nope");
    const errors: string[] = [];

    const found = await findEntries(dir, (message) => errors.push(message));

    assert.deepEqual(
      found.map((entry) => [entry.target.id, entry.name, entry.baseUrl, entry.email]),
      [["claude-project", "jira", "https://x.atlassian.net/", "me@x.com"]]
    );
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Cannot parse .*mcp\.json/);
  });
});

test("checkToken tells a working token from a rejected one and from an unreachable site", async () => {
  await withProject({ jira: jiraEntry("t1") }, async (dir) => {
    const [entry] = await findEntries(dir);
    const seen: { url: string; auth: string }[] = [];
    const answer = (status: number) =>
      ((url: string, init: RequestInit) => {
        seen.push({ url, auth: (init.headers as Record<string, string>).Authorization });
        return Promise.resolve(new Response("{}", { status }));
      }) as unknown as typeof fetch;

    assert.equal((await checkToken(entry, answer(200))).state, "ok");
    assert.equal(seen[0].url, "https://x.atlassian.net/rest/api/3/myself");
    assert.match(seen[0].auth, /^Basic /);

    const rejected = await checkToken(entry, answer(401));
    assert.equal(rejected.state, "invalid");
    assert.match(rejected.detail, /expired or was revoked/);
    assert.equal((await checkToken(entry, answer(500))).state, "unreachable");

    const down = (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as unknown as typeof fetch;
    assert.deepEqual(await checkToken(entry, down), { state: "unreachable", detail: "getaddrinfo ENOTFOUND" });
  });
});

test("removeEntry deletes only the named server and keeps the rest of the file", async () => {
  await withProject({ jira: jiraEntry("t1"), keep: { command: "x" } }, async (dir, file) => {
    const [entry] = await findEntries(dir);

    assert.equal(await removeEntry(entry), true);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { other: 1, mcpServers: { keep: { command: "x" } } });
    assert.equal(await removeEntry(entry), false);
  });
});

// The setup wizard end to end: the real jira-mcp-add script, answers piped through --stdin, a mock Jira on localhost.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ADD_SCRIPT = fileURLToPath(new URL("./cli/add.js", import.meta.url));
const GOOD_TOKEN = "good-token";
const EMAIL = "me@example.com";

type Run = { code: number | null; stdout: string; stderr: string };

async function withJira(run: (baseUrl: string) => Promise<void>) {
  const expected = `Basic ${Buffer.from(`${EMAIL}:${GOOD_TOKEN}`).toString("base64")}`;
  const server: Server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");

    if (request.headers.authorization !== expected) {
      response.writeHead(401).end("{}");
      return;
    }

    const url = request.url ?? "";
    const body = url.startsWith("/rest/api/3/myself")
      ? { displayName: "Me" }
      : url.startsWith("/rest/api/3/project/search")
        ? { values: [{ key: "PMG", name: "Project" }] }
        : url.startsWith("/rest/api/3/field")
          ? [{ id: "customfield_10016", name: "Story Points" }]
          : {};
    response.writeHead(200).end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withProject(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jira-mcp-wizard-"));

  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs jira-mcp-add in dir with one answer per line; HOME points at dir so the global config is never touched. */
function wizard(dir: string, flags: string[], answers: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ADD_SCRIPT, "--stdin", ...flags], {
      cwd: dir,
      env: { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(answers.join("\n") + "\n");
  });
}

// url, email, token, default project, custom fields, attachment dir, launcher, server name, target, gitignore, another
const addAnswers = (baseUrl: string, dir: string, overrides: Partial<Record<number, string>> = {}) =>
  [baseUrl, EMAIL, GOOD_TOKEN, "pmg", "Story Points", path.join(dir, "att"), "1", "", "1", "y", "n"].map(
    (answer, index) => overrides[index] ?? answer
  );

const readConfig = async (dir: string) => JSON.parse(await readFile(path.join(dir, ".mcp.json"), "utf8"));

test("the wizard writes the entry, keeps the rest of the file and ignores the file in git", async () => {
  await withJira(async (baseUrl) => {
    await withProject(async (dir) => {
      await writeFile(
        path.join(dir, ".mcp.json"),
        JSON.stringify({ other: 1, mcpServers: { keep: { command: "x" } } })
      );
      await writeFile(path.join(dir, ".gitignore"), "node_modules");

      const result = await wizard(dir, [], addAnswers(baseUrl, dir));

      assert.equal(result.code, 0, result.stdout + result.stderr);
      const config = await readConfig(dir);
      assert.equal(config.other, 1);
      assert.deepEqual(config.mcpServers.keep, { command: "x" });

      const entry = config.mcpServers.jira_pmg;
      assert.equal(entry.command, "npx");
      assert.deepEqual(entry.args, ["-y", "jira-readonly-mcp"]);
      assert.equal(entry.env.JIRA_BASE_URL, baseUrl);
      assert.equal(entry.env.JIRA_EMAIL, EMAIL);
      assert.equal(entry.env.JIRA_API_TOKEN, GOOD_TOKEN);
      assert.equal(entry.env.JIRA_DEFAULT_PROJECT, "PMG");
      assert.equal(entry.env.JIRA_CUSTOM_FIELDS, "customfield_10016:storyPoints");
      assert.equal(entry.env.JIRA_ATTACHMENT_DIR, path.join(dir, "att"));

      assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), "node_modules\n.mcp.json\n");
      assert.ok(!result.stdout.includes(GOOD_TOKEN), "the token must not be echoed");
    });
  });
});

test("running the wizard again leaves the file untouched when overwriting is declined, and does not duplicate it when accepted", async () => {
  await withJira(async (baseUrl) => {
    await withProject(async (dir) => {
      await wizard(dir, [], addAnswers(baseUrl, dir));
      const first = await readFile(path.join(dir, ".mcp.json"), "utf8");

      // ... target, overwrite?, another (the gitignore question is skipped)
      const declined = await wizard(dir, [], [...addAnswers(baseUrl, dir).slice(0, 9), "n", "n"]);
      assert.equal(declined.code, 0, declined.stdout + declined.stderr);
      assert.match(declined.stdout, /already exists/);
      assert.match(declined.stdout, /Nothing was written/);
      assert.equal(await readFile(path.join(dir, ".mcp.json"), "utf8"), first);

      const accepted = await wizard(dir, [], [...addAnswers(baseUrl, dir).slice(0, 9), "y", "y", "n"]);
      assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
      assert.equal(await readFile(path.join(dir, ".mcp.json"), "utf8"), first);
      assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), ".mcp.json\n");
      assert.match(accepted.stdout, /already ignored/);
    });
  });
});

test("rejected credentials can be retried, and declining to save writes nothing", async () => {
  await withJira(async (baseUrl) => {
    await withProject(async (dir) => {
      const retried = await wizard(dir, ["--print"], [baseUrl, EMAIL, "bad", "y", GOOD_TOKEN, "", "", "", "", "jira"]);
      assert.equal(retried.code, 0, retried.stdout + retried.stderr);
      assert.match(retried.stdout, /Jira rejected the credentials/);
      assert.match(retried.stdout, /Authenticated as Me/);

      const printed = JSON.parse(retried.stdout.slice(retried.stdout.indexOf("{\n")));
      assert.equal(printed.mcpServers.jira.env.JIRA_API_TOKEN, GOOD_TOKEN);
      await assert.rejects(readFile(path.join(dir, ".mcp.json")), { code: "ENOENT" });

      const declined = await wizard(dir, [], [baseUrl, EMAIL, "bad", "n", "n"]);
      assert.equal(declined.code, 1);
      await assert.rejects(readFile(path.join(dir, ".mcp.json")), { code: "ENOENT" });
    });
  });
});

test("the wizard refuses a plain http URL for a remote host and a config file that is not valid JSON", async () => {
  await withJira(async (baseUrl) => {
    await withProject(async (dir) => {
      const remote = await wizard(
        dir,
        [],
        ["http://jira.example.com", "https://x.atlassian.net", EMAIL, "bad", "n", "n"]
      );
      assert.match(remote.stdout, /must use https/);

      await writeFile(path.join(dir, ".mcp.json"), "{broken");
      const broken = await wizard(dir, [], addAnswers(baseUrl, dir));

      assert.equal(broken.code, 1);
      assert.match(broken.stdout, /Cannot parse .*\.mcp\.json/);
      assert.equal(await readFile(path.join(dir, ".mcp.json"), "utf8"), "{broken");
    });
  });
});

test("running out of piped answers and running without --stdin both fail with a clear message", async () => {
  await withProject(async (dir) => {
    const short = await wizard(dir, [], ["http://127.0.0.1:1"]);
    assert.equal(short.code, 1);
    assert.match(short.stdout, /piped input ended/);

    const noTty = await new Promise<Run>((resolve) => {
      const child = spawn(process.execPath, [ADD_SCRIPT], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir } });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr: "" }));
      child.stdin.end();
    });
    assert.equal(noTty.code, 1);
    assert.match(noTty.stdout, /needs a TTY/);
  });
});

test("--list reports working and revoked tokens, and --remove deletes only the confirmed entry", async () => {
  await withJira(async (baseUrl) => {
    await withProject(async (dir) => {
      await wizard(dir, [], addAnswers(baseUrl, dir));

      const list = await wizard(dir, ["--list"], []);
      assert.equal(list.code, 0, list.stdout + list.stderr);
      assert.match(list.stdout, /token works/);
      assert.ok(!list.stdout.includes(GOOD_TOKEN));

      const config = await readConfig(dir);
      config.mcpServers.old = { command: "npx", env: { ...config.mcpServers.jira_pmg.env, JIRA_API_TOKEN: "revoked" } };
      await writeFile(path.join(dir, ".mcp.json"), JSON.stringify(config));

      const mixed = await wizard(dir, ["--list"], []);
      assert.equal(mixed.code, 1);
      assert.match(mixed.stdout, /expired or was revoked/);

      const kept = await wizard(dir, ["--remove", "old"], ["n"]);
      assert.match(kept.stdout, /Nothing was removed/);
      assert.ok((await readConfig(dir)).mcpServers.old);

      const removed = await wizard(dir, ["--remove", "old"], ["y"]);
      assert.match(removed.stdout, /Removed old/);
      const after = await readConfig(dir);
      assert.equal(after.mcpServers.old, undefined);
      assert.ok(after.mcpServers.jira_pmg);

      const missing = await wizard(dir, ["--remove", "nope"], []);
      assert.match(missing.stdout, /No Jira server entry named "nope"/);
    });
  });
});

// The setup wizard's config-file helpers: where entries go and how files are read and edited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureGitIgnored, getIn, readJson, targets } from "./cli/config-files.js";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "jira-mcp-cli-"));
}

test("targets point at the project and global client config files", () => {
  const list = targets("/work/app");
  const byId = Object.fromEntries(list.map((target) => [target.id, target]));

  assert.equal(byId["claude-project"].file, path.join("/work/app", ".mcp.json"));
  assert.deepEqual(byId["claude-project"].pathInFile, ["mcpServers"]);
  assert.equal(byId["cursor-project"].file, path.join("/work/app", ".cursor", "mcp.json"));
  assert.equal(byId["vscode-project"].file, path.join("/work/app", ".vscode", "mcp.json"));
  assert.deepEqual(byId["vscode-project"].pathInFile, ["servers"]);
  assert.equal(byId["claude-global"].file, path.join(os.homedir(), ".claude.json"));
  assert.equal(byId["claude-global"].gitIgnorable, false);
  assert.ok(list.filter((target) => target.id !== "claude-global").every((target) => target.gitIgnorable));
});

test("readJson: a missing file is empty, valid JSON is parsed, broken JSON names the file", async () => {
  const dir = await tempDir();

  try {
    assert.deepEqual(await readJson(path.join(dir, "missing.json")), {});

    await writeFile(path.join(dir, "ok.json"), '{"mcpServers":{"a":{}}}');
    assert.deepEqual(await readJson(path.join(dir, "ok.json")), { mcpServers: { a: {} } });

    await writeFile(path.join(dir, "null.json"), "null");
    assert.deepEqual(await readJson(path.join(dir, "null.json")), {});

    await writeFile(path.join(dir, "bad.json"), "{nope");
    await assert.rejects(readJson(path.join(dir, "bad.json")), /Cannot parse .*bad\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("getIn creates missing levels and replaces non-objects", () => {
  const root: Record<string, unknown> = { servers: "not an object" };

  getIn(root, ["mcpServers"])["jira"] = { command: "npx" };
  getIn(root, ["servers", "nested"]);

  assert.deepEqual(root, { servers: { nested: {} }, mcpServers: { jira: { command: "npx" } } });
  assert.equal(getIn(root, []), root);
});

test("ensureGitIgnored appends once, keeps the existing content and handles a missing file", async () => {
  const dir = await tempDir();

  try {
    assert.equal(await ensureGitIgnored(dir, ".mcp.json"), true);
    assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), ".mcp.json\n");
    assert.equal(await ensureGitIgnored(dir, ".mcp.json"), false);

    await writeFile(path.join(dir, ".gitignore"), "node_modules\r\n.env");
    assert.equal(await ensureGitIgnored(dir, ".env"), false);
    assert.equal(await ensureGitIgnored(dir, ".cursor/mcp.json"), true);
    assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), "node_modules\r\n.env\n.cursor/mcp.json\n");

    // Something that is not a file cannot be read: the error is not mistaken for "missing".
    await mkdir(path.join(dir, "sub", ".gitignore"), { recursive: true });
    await assert.rejects(ensureGitIgnored(path.join(dir, "sub"), "x"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the wizard explains that it needs a terminal instead of hanging", async () => {
  const { spawn } = await import("node:child_process");
  const { projectRoot } = await import("./server.js");
  const child = spawn(process.execPath, [path.join(projectRoot, "dist", "cli", "add.js"), "--print"], {
    env: { PATH: process.env.PATH, NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));

  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));

  assert.equal(code, 1);
  assert.match(output, /Interactive setup needs a TTY/);
});

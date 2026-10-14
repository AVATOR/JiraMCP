// Locating and editing the MCP client config files the wizard writes to.

import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type JsonObject = Record<string, unknown>;

export type ConfigTarget = {
  id: string;
  label: string;
  hint: string;
  file: string;
  // Where the server map lives inside the file; differs between clients.
  pathInFile: string[];
  gitIgnorable: boolean;
};

/**
 * Client config files the entry can be written to, relative to the working directory.
 *
 * @param cwd Project directory that holds the project-level config files.
 * @returns Config files the entry can be written to.
 */
export function targets(cwd: string): ConfigTarget[] {
  return [
    {
      id: "claude-project",
      label: "Claude Code — this project",
      hint: ".mcp.json, shared with everyone who opens the repo",
      file: path.join(cwd, ".mcp.json"),
      pathInFile: ["mcpServers"],
      gitIgnorable: true
    },
    {
      id: "cursor-project",
      label: "Cursor — this project",
      hint: ".cursor/mcp.json",
      file: path.join(cwd, ".cursor", "mcp.json"),
      pathInFile: ["mcpServers"],
      gitIgnorable: true
    },
    {
      id: "vscode-project",
      label: "VS Code / Copilot — this project",
      hint: ".vscode/mcp.json",
      file: path.join(cwd, ".vscode", "mcp.json"),
      pathInFile: ["servers"],
      gitIgnorable: true
    },
    {
      id: "claude-global",
      label: "Claude Code — global (all projects)",
      hint: "~/.claude.json",
      file: path.join(os.homedir(), ".claude.json"),
      pathInFile: ["mcpServers"],
      gitIgnorable: false
    }
  ];
}

/**
 * Reads a JSON config file; a missing file counts as empty, an invalid one is an error.
 *
 * @param file Path of the config file.
 * @returns Parsed object, or an empty one when the file does not exist.
 */
export async function readJson(file: string): Promise<JsonObject> {
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw new Error(`Cannot parse ${file}: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Returns the nested object at the key path, creating missing levels.
 *
 * @param root Config object to descend into.
 * @param keys Key path, e.g. ["mcpServers"].
 * @returns The nested object at that path.
 */
export function getIn(root: JsonObject, keys: string[]): JsonObject {
  let node = root;

  for (const key of keys) {
    if (!node[key] || typeof node[key] !== "object") {
      node[key] = {};
    }

    node = node[key] as JsonObject;
  }

  return node;
}

/**
 * Appends the entry to .gitignore unless already listed; returns whether it was added.
 *
 * @param cwd Project directory that holds .gitignore.
 * @param entry Path to ignore, relative to cwd.
 * @returns True when the entry was added, false when it was already listed.
 */
export async function ensureGitIgnored(cwd: string, entry: string) {
  const file = path.join(cwd, ".gitignore");
  let content = "";

  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (content.split(/\r?\n/).some((line) => line.trim() === entry)) {
    return false;
  }

  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  await writeFile(file, `${content}${prefix}${entry}\n`, "utf8");
  return true;
}

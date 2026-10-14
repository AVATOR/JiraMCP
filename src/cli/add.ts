#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ask, confirm, log, select, styles } from "./prompt.js";

const PACKAGE_NAME = "jira-readonly-mcp";
const MIN_NODE_MAJOR = 20;

type ServerEntry = {
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
};

type ConfigTarget = {
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
function targets(cwd: string): ConfigTarget[] {
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
 * Adds https:// when missing and strips trailing slashes.
 *
 * @param value URL as typed by the user.
 * @returns URL with a scheme and no trailing slash.
 */
function normalizeBaseUrl(value: string): string {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * Basic auth header value for an Atlassian email and API token.
 *
 * @param email Atlassian account email.
 * @param apiToken Atlassian API token.
 * @returns Value for the Authorization header.
 */
function authHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
}

/**
 * GETs a Jira endpoint as JSON; used for the wizard's project and field lookups.
 *
 * @param baseUrl Jira site URL.
 * @param email Atlassian account email.
 * @param apiToken Atlassian API token.
 * @param endpoint Path with query, e.g. /rest/api/3/field.
 * @returns Parsed JSON response; throws on a non-2xx status.
 */
async function jiraGet<T>(baseUrl: string, email: string, apiToken: string, endpoint: string): Promise<T> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: { Authorization: authHeader(email, apiToken), Accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return (await response.json()) as T;
}

/**
 * Reads a JSON config file; a missing file counts as empty, an invalid one is an error.
 *
 * @param file Path of the config file.
 * @returns Parsed object, or an empty one when the file does not exist.
 */
async function readJson(file: string): Promise<Record<string, any>> {
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
function getIn(root: Record<string, any>, keys: string[]): Record<string, any> {
  let node = root;

  for (const key of keys) {
    if (!node[key] || typeof node[key] !== "object") {
      node[key] = {};
    }

    node = node[key];
  }

  return node;
}

/**
 * Whether the file is accessible.
 *
 * @param file Path to check.
 * @returns True when the file is accessible.
 */
async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * A checkout of this repo can be run straight from dist/, which avoids the npx resolution step; an installed copy under node_modules should use npx instead.
 * @returns Path to dist/index.js of a local checkout, or undefined when running from node_modules.
 */
async function findLocalCheckout(): Promise<string | undefined> {
  const entry = path.resolve(fileURLToPath(import.meta.url), "..", "..", "index.js");

  if (!entry.includes(`${path.sep}node_modules${path.sep}`) && (await exists(entry))) {
    return entry;
  }

  return undefined;
}

/**
 * Appends the entry to .gitignore unless already listed; returns whether it was added.
 *
 * @param cwd Project directory that holds .gitignore.
 * @param entry Path to ignore, relative to cwd.
 * @returns True when the entry was added, false when it was already listed.
 */
async function ensureGitIgnored(cwd: string, entry: string) {
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

/**
 * Asks for the default project key, listing the available keys as a hint.
 *
 * @param baseUrl Jira site URL.
 * @param email Atlassian account email.
 * @param apiToken Atlassian API token.
 * @returns Upper-cased project key, or an empty string.
 */
async function pickDefaultProject(baseUrl: string, email: string, apiToken: string): Promise<string> {
  type ProjectPage = { values?: { key: string; name: string }[] };

  let projects: { key: string; name: string }[] = [];

  try {
    const page = await jiraGet<ProjectPage>(baseUrl, email, apiToken, "/rest/api/3/project/search?maxResults=50");
    projects = page.values ?? [];
  } catch {
    log.note("Could not list projects, falling back to manual input.");
  }

  if (projects.length) {
    log.note(`Available: ${projects.map((project) => project.key).join(", ")}`);
  }

  const value = await ask("Default project key (optional, press Enter to skip)", {
    defaultValue: "",
    validate: (input) => (!input || /^[A-Za-z][A-Za-z0-9_]*$/.test(input) ? undefined : "Use a project key like PMG.")
  });

  return value.toUpperCase();
}

/**
 * Asks for field names and resolves them to JIRA_CUSTOM_FIELDS id:alias pairs.
 *
 * @param baseUrl Jira site URL.
 * @param email Atlassian account email.
 * @param apiToken Atlassian API token.
 * @returns JIRA_CUSTOM_FIELDS value (id:alias pairs), empty when none were chosen.
 */
async function pickCustomFields(baseUrl: string, email: string, apiToken: string): Promise<string> {
  const wanted = await ask("Custom fields to expose, by display name, comma separated (optional)", {
    defaultValue: ""
  });

  if (!wanted) {
    return "";
  }

  type Field = { id: string; name: string };
  let fields: Field[];

  try {
    fields = await jiraGet<Field[]>(baseUrl, email, apiToken, "/rest/api/3/field");
  } catch (error) {
    log.warn(`Could not read the field list (${(error as Error).message}).`);
    return "";
  }

  const mappings: string[] = [];

  for (const name of wanted
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const match =
      fields.find((field) => field.name.toLowerCase() === name.toLowerCase()) ??
      fields.find((field) => field.name.toLowerCase().includes(name.toLowerCase()));

    if (!match) {
      log.warn(`No field matches "${name}" — skipped.`);
      continue;
    }

    const alias = name
      .replace(/[^A-Za-z0-9 ]+/g, " ")
      .trim()
      .split(/\s+/)
      .map((word, index) => (index === 0 ? word.toLowerCase() : word[0].toUpperCase() + word.slice(1).toLowerCase()))
      .join("");

    log.info(`${styles.bold(match.name)} → ${match.id} as ${alias}`);
    mappings.push(`${match.id}:${alias}`);
  }

  return mappings.join(",");
}

/**
 * Collects the Jira connection details and builds the MCP server entry.
 *
 * @param printOnly Skip the local checkout lookup so the entry always uses npx.
 * @returns The server entry and a suggested server name.
 */
async function buildEntry(printOnly: boolean): Promise<{ entry: ServerEntry; suggestedName: string }> {
  const baseUrl = normalizeBaseUrl(
    await ask("Jira base URL", {
      defaultValue: process.env.JIRA_BASE_URL?.trim() || "",
      validate: (value) => (value ? undefined : "Required, e.g. your-company.atlassian.net")
    })
  );

  const email = await ask("Atlassian account email", {
    defaultValue: process.env.JIRA_EMAIL?.trim() || "",
    validate: (value) => (/^[^@\s]+@[^@\s]+$/.test(value) ? undefined : "Enter a valid email.")
  });

  log.note("Create a token at https://id.atlassian.com/manage-profile/security/api-tokens");

  let apiToken: string;
  let authenticated = false;

  for (;;) {
    apiToken = await ask("API token (hidden)", {
      secret: true,
      validate: (value) => (value ? undefined : "Required.")
    });

    try {
      const me = await jiraGet<{ displayName?: string }>(baseUrl, email, apiToken, "/rest/api/3/myself");
      log.success(`Authenticated as ${me.displayName ?? email}`);
      authenticated = true;
      break;
    } catch (error) {
      log.error(`Jira rejected the credentials: ${(error as Error).message}`);

      if (!(await confirm("Try again?", true))) {
        if (!(await confirm("Save the configuration anyway?", false))) {
          process.exit(1);
        }

        break;
      }
    }
  }

  if (authenticated) {
    // The same token covers Confluence only when the site has it and the user has access,
    // so the Confluence tools are worth checking separately.
    try {
      await jiraGet(baseUrl, email, apiToken, "/wiki/rest/api/space?limit=1");
      log.success("Confluence is reachable with this token.");
    } catch (error) {
      log.note(`Confluence check failed (${(error as Error).message}) — the Confluence tools may return errors.`);
    }
  }

  const defaultProject = await pickDefaultProject(baseUrl, email, apiToken);
  const customFields = await pickCustomFields(baseUrl, email, apiToken);
  const attachmentDir = await ask("Directory for downloaded attachments", {
    defaultValue: path.join(os.tmpdir(), "jira-attachments")
  });

  if (attachmentDir) {
    await mkdir(attachmentDir, { recursive: true });
  }

  const env: Record<string, string> = {
    JIRA_BASE_URL: baseUrl,
    JIRA_EMAIL: email,
    JIRA_API_TOKEN: apiToken
  };

  if (defaultProject) {
    env.JIRA_DEFAULT_PROJECT = defaultProject;
  }

  if (customFields) {
    env.JIRA_CUSTOM_FIELDS = customFields;
  }

  if (attachmentDir) {
    env.JIRA_ATTACHMENT_DIR = attachmentDir;
  }

  const localEntry = printOnly ? undefined : await findLocalCheckout();
  let entry: ServerEntry = { type: "stdio", command: "npx", args: ["-y", PACKAGE_NAME], env };

  if (localEntry) {
    const launcher = await select("How should the server be launched?", [
      { value: `npx ${PACKAGE_NAME}`, hint: "always runs the published package, survives moving this folder" },
      { value: `this checkout (${localEntry})`, hint: "runs your local build, needs npm run build after changes" }
    ]);

    if (launcher.startsWith("this checkout")) {
      entry = {
        type: "stdio",
        command: process.execPath,
        args: [localEntry],
        cwd: path.dirname(path.dirname(localEntry)),
        env
      };
    }
  }

  return { entry, suggestedName: defaultProject ? `jira_${defaultProject.toLowerCase()}` : "jira" };
}

/**
 * Configures one Jira instance; returns whether the user wants to add another.
 *
 * @param cwd Project directory the config is written relative to.
 * @param printOnly Print the JSON instead of writing a config file.
 * @returns True when the user wants to add another instance.
 */
async function addOne(cwd: string, printOnly: boolean): Promise<boolean> {
  const { entry, suggestedName } = await buildEntry(printOnly);

  const serverName = await ask("MCP server name (how the tools get prefixed)", {
    defaultValue: suggestedName,
    validate: (value) => (/^[A-Za-z0-9_-]+$/.test(value) ? undefined : "Use letters, digits, _ or - only.")
  });

  if (printOnly) {
    log.blank();
    process.stdout.write(`${JSON.stringify({ mcpServers: { [serverName]: entry } }, null, 2)}\n`);
    return false;
  }

  log.blank();
  const available = targets(cwd);
  const choice = await select(
    "Where should the configuration go?",
    available.map((target) => ({ value: target.label, hint: target.hint }))
  );
  const target = available.find((candidate) => candidate.label === choice)!;

  const config = await readJson(target.file);
  const servers = getIn(config, target.pathInFile);

  if (servers[serverName] && !(await confirm(`"${serverName}" already exists in ${target.file}. Overwrite?`, false))) {
    log.warn("Nothing was written.");
    return await confirm("Add another Jira instance?", false);
  }

  servers[serverName] = entry;

  await mkdir(path.dirname(target.file), { recursive: true });
  await writeFile(target.file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  log.success(`Wrote ${serverName} to ${target.file}`);

  if (target.gitIgnorable) {
    log.warn("That file now holds your API token in plain text.");

    if (await confirm("Add it to .gitignore?", true)) {
      const relative = path.relative(cwd, target.file);
      const added = await ensureGitIgnored(cwd, relative);
      log.success(added ? `Added ${relative} to .gitignore` : `${relative} is already ignored`);
    }
  }

  log.blank();
  log.title("Next steps");
  log.info("1. Restart your MCP client so it picks up the new server.");
  log.info(`2. Ask it for a Jira issue, e.g. "show me ${entry.env.JIRA_DEFAULT_PROJECT || "PROJ"}-1".`);
  log.note(`Tools: ${serverName}__jira_get_issue, jira_search_issues, jira_get_comments, jira_list_attachments, ...`);
  log.blank();

  // Several Jira sites are common (one per client), each needing its own server entry.
  return await confirm("Add another Jira instance?", false);
}

/** Entry point of the setup wizard (--print only outputs the JSON). */
async function main() {
  const major = Number(process.versions.node.split(".")[0]);

  if (major < MIN_NODE_MAJOR) {
    throw new Error(`Node ${MIN_NODE_MAJOR}+ is required, this is ${process.versions.node}.`);
  }

  const cwd = process.cwd();
  const args = new Set(process.argv.slice(2));
  const printOnly = args.has("--print");

  log.title("jira-mcp-add — read-only Jira MCP server setup");
  log.note(`Project: ${cwd}`);
  log.blank();

  while (await addOne(cwd, printOnly)) {
    log.blank();
  }
}

main().catch((error) => {
  log.blank();
  log.error((error as Error).message);
  process.exit(1);
});

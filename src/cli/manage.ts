// `jira-mcp-add --list` and `--remove`: inspecting and cleaning up entries the wizard wrote.

import { writeFile } from "node:fs/promises";
import { basicAuthHeader } from "../auth.js";
import { getIn, readJson, targets, type ConfigTarget } from "./config-files.js";
import { confirm, log, select } from "./prompt.js";

export type FoundEntry = {
  target: ConfigTarget;
  name: string;
  baseUrl: string;
  email: string;
  apiToken: string;
};

export type TokenStatus = { state: "ok" | "invalid" | "unreachable"; detail: string };

/**
 * Finds the Jira server entries in every client config file the wizard writes to. A file that
 * cannot be parsed is reported through `onError` and skipped, so one broken file does not hide the rest.
 *
 * @param cwd Project directory that holds the project-level config files.
 * @param onError Called with a message for each unreadable file.
 * @returns Entries that carry Jira credentials in their env.
 */
export async function findEntries(cwd: string, onError: (message: string) => void = () => undefined) {
  const found: FoundEntry[] = [];

  for (const target of targets(cwd)) {
    let servers: Record<string, unknown>;

    try {
      servers = getIn(await readJson(target.file), target.pathInFile);
    } catch (error) {
      onError((error as Error).message);
      continue;
    }

    for (const [name, value] of Object.entries(servers)) {
      const env = (value as { env?: Record<string, unknown> } | null)?.env;
      const { JIRA_BASE_URL: baseUrl, JIRA_EMAIL: email, JIRA_API_TOKEN: apiToken } = env ?? {};

      if (typeof baseUrl === "string" && typeof apiToken === "string") {
        found.push({ target, name, baseUrl, email: typeof email === "string" ? email : "", apiToken });
      }
    }
  }

  return found;
}

/**
 * Asks Jira who the token belongs to: 200 means it works, 401/403 means it was revoked or expired.
 *
 * @param entry Entry holding the credentials.
 * @param fetchImpl fetch, replaceable in tests.
 * @returns Whether the token works, with a short explanation.
 */
export async function checkToken(entry: FoundEntry, fetchImpl: typeof fetch = fetch): Promise<TokenStatus> {
  try {
    const response = await fetchImpl(`${entry.baseUrl.replace(/\/+$/, "")}/rest/api/3/myself`, {
      headers: { Authorization: basicAuthHeader(entry.email, entry.apiToken), Accept: "application/json" },
      signal: AbortSignal.timeout(10_000)
    });

    if (response.ok) {
      return { state: "ok", detail: "token works" };
    }

    if (response.status === 401 || response.status === 403) {
      return {
        state: "invalid",
        detail: `rejected (${response.status}): the token expired or was revoked, create a new one and re-run the wizard`
      };
    }

    return { state: "unreachable", detail: `unexpected answer ${response.status} ${response.statusText}` };
  } catch (error) {
    return { state: "unreachable", detail: (error as Error).message };
  }
}

/**
 * Deletes one server entry from its config file, leaving everything else in the file as it was.
 *
 * @param entry The entry to remove.
 * @returns True when it was there and has been removed.
 */
export async function removeEntry(entry: Pick<FoundEntry, "target" | "name">): Promise<boolean> {
  const config = await readJson(entry.target.file);
  const servers = getIn(config, entry.target.pathInFile);

  if (!(entry.name in servers)) {
    return false;
  }

  delete servers[entry.name];
  await writeFile(entry.target.file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return true;
}

/**
 * `--list`: prints every configured Jira site and whether its token still works. Tokens are never printed.
 *
 * @param cwd Project directory.
 * @returns Number of entries whose token no longer works.
 */
export async function runList(cwd: string): Promise<number> {
  const entries = await findEntries(cwd, (message) => log.warn(message));

  if (!entries.length) {
    log.info("No Jira server entries found. Run jira-mcp-add to create one.");
    return 0;
  }

  let invalid = 0;

  for (const entry of entries) {
    const status = await checkToken(entry);
    const line = `${entry.name}: ${entry.baseUrl}${entry.email ? ` (${entry.email})` : ""} — ${status.detail}`;

    if (status.state === "ok") {
      log.success(line);
    } else {
      log.error(line);
      invalid += status.state === "invalid" ? 1 : 0;
    }

    log.note(`${entry.target.label}: ${entry.target.file}`);
  }

  return invalid;
}

/**
 * `--remove [name]`: removes one entry after confirmation; without a name the user picks one.
 *
 * @param cwd Project directory.
 * @param name Server name to remove, or undefined to choose from a list.
 * @returns True when an entry was removed.
 */
export async function runRemove(cwd: string, name?: string): Promise<boolean> {
  const entries = await findEntries(cwd, (message) => log.warn(message));
  const candidates = name ? entries.filter((entry) => entry.name === name) : entries;

  if (!candidates.length) {
    log.info(name ? `No Jira server entry named "${name}" found.` : "No Jira server entries found.");
    return false;
  }

  let chosen = candidates[0];

  if (candidates.length > 1) {
    const label = (entry: FoundEntry) => `${entry.name} — ${entry.baseUrl} (${entry.target.label})`;
    const picked = await select(
      "Which entry should be removed?",
      candidates.map((entry) => ({ value: label(entry), hint: entry.target.file }))
    );
    chosen = candidates.find((entry) => label(entry) === picked) ?? chosen;
  }

  if (!(await confirm(`Remove "${chosen.name}" (${chosen.baseUrl}) from ${chosen.target.file}?`, false))) {
    log.warn("Nothing was removed.");
    return false;
  }

  const removed = await removeEntry(chosen);
  log.success(removed ? `Removed ${chosen.name} from ${chosen.target.file}` : "The entry was already gone.");
  log.note(
    "Revoke the API token at https://id.atlassian.com/manage-profile/security/api-tokens if it is no longer used."
  );
  return removed;
}

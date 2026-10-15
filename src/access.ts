// Server-side allowlists for Jira projects and Confluence spaces. The Atlassian token usually sees
// far more than the agent should, so these limits are enforced here, not left to the token.

import { jqlString } from "./query.js";

/**
 * Parses a comma-separated allowlist such as JIRA_ALLOWED_PROJECTS.
 *
 * @param raw Environment value.
 * @returns Trimmed, non-empty keys, or undefined when no list is configured.
 */
export function parseAllowlist(raw: string | undefined): string[] | undefined {
  const keys = (raw ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  return keys.length ? [...new Set(keys)] : undefined;
}

/**
 * Case-insensitive set of allowed keys with a name for error messages.
 */
export class Allowlist {
  private readonly keys: Set<string>;

  constructor(
    keys: string[],
    private readonly label: string,
    private readonly variable: string
  ) {
    this.keys = new Set(keys.map((key) => key.toLowerCase()));
  }

  /**
   * @param key Project or space key.
   * @returns Whether the key is on the list.
   */
  has(key: string | undefined): boolean {
    return key !== undefined && this.keys.has(key.toLowerCase());
  }

  /**
   * Throws unless the key is allowed.
   *
   * @param key Project or space key.
   */
  assert(key: string | undefined): void {
    if (!this.has(key)) {
      throw new Error(`${this.label} ${key ?? "(unknown)"} is not allowed by ${this.variable}`);
    }
  }
}

/**
 * Project key of an issue key (ABC-123 -> ABC).
 *
 * @param issueKey Issue key.
 * @returns The project key, or undefined when the text is not an issue key.
 */
export function projectOfIssue(issueKey: string | undefined): string | undefined {
  return issueKey?.match(/^(.+)-\d+$/)?.[1];
}

/**
 * Restricts a JQL query to the given projects: `project in (...) AND (<query>) ORDER BY ...`.
 * Quotes and parentheses must be balanced, otherwise a crafted query could close the group and
 * escape the restriction.
 *
 * @param jql User-supplied JQL.
 * @param projects Allowed project keys.
 * @returns The restricted JQL.
 */
export function scopeJql(jql: string, projects: string[]): string {
  let depth = 0;
  let quote: string | undefined;
  let orderAt = -1;

  for (let i = 0; i < jql.length; i++) {
    const char = jql[i];

    if (quote) {
      if (char === "\\") {
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth++;
    } else if (char === ")") {
      depth--;
      if (depth < 0) {
        throw new Error("JQL has an unbalanced closing parenthesis");
      }
    } else if (depth === 0 && /\s/.test(jql[i - 1] ?? " ") && /^order\s+by\b/i.test(jql.slice(i))) {
      orderAt = i;
      break;
    }
  }

  if (quote || depth !== 0) {
    throw new Error("JQL has an unterminated quote or parenthesis");
  }

  const where = (orderAt === -1 ? jql : jql.slice(0, orderAt)).trim();
  const order = orderAt === -1 ? "" : ` ${jql.slice(orderAt).trim()}`;
  const scope = `project in (${projects.map(jqlString).join(", ")})`;

  return `${scope}${where ? ` AND (${where})` : ""}${order}`;
}

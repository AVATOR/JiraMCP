/**
 * Basic auth header value for an Atlassian email and API token.
 *
 * @param email Atlassian account email.
 * @param apiToken Atlassian API token.
 * @returns Value for the Authorization header, including the "Basic " scheme.
 */
export function basicAuthHeader(email: string, apiToken: string): string {
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
}

/**
 * Explains why a base URL cannot be used: Basic auth sends the API token with every request, so
 * anything but https:// would expose it. Plain http is accepted only for a local development host.
 *
 * @param value Jira site URL.
 * @returns A message describing the problem, or undefined when the URL is acceptable.
 */
export function baseUrlProblem(value: string): string | undefined {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return `JIRA_BASE_URL is not a valid URL: ${value}`;
  }

  if (url.protocol === "https:") {
    return undefined;
  }

  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");

  if (url.protocol === "http:" && local) {
    return undefined;
  }

  return `JIRA_BASE_URL must use https:// (got ${url.protocol}//${url.host}): the API token would be sent unencrypted. Plain http is only allowed for localhost.`;
}

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

// Counters for the HTTP transport, exposed at /metrics in the Prometheus text format.

export type UpstreamEvent = {
  // HTTP status of the answer, or "error" when no answer came (timeout, network failure).
  outcome: string;
  // The attempt repeats an earlier one that was rate limited or failed with a gateway error.
  retry: boolean;
  durationMs: number;
};

/**
 * In-memory request counters. One instance is shared by every request of a server process.
 */
export class Metrics {
  private readonly started: number;
  private readonly mcpRequests = new Map<string, number>();
  private readonly upstreamRequests = new Map<string, number>();
  private rateLimited = 0;
  private upstreamRetries = 0;
  private upstreamSeconds = 0;

  constructor(private readonly now: () => number = Date.now) {
    this.started = now();
  }

  /**
   * Counts a finished /mcp request.
   *
   * @param status HTTP status that was sent.
   */
  countMcpRequest(status: number): void {
    increment(this.mcpRequests, String(status));
  }

  /** Counts a request refused by the rate limiter. */
  countRateLimited(): void {
    this.rateLimited++;
  }

  /**
   * Counts one request to Atlassian, retries included.
   *
   * @param event Outcome, whether it was a retry and how long it took.
   */
  countUpstream(event: UpstreamEvent): void {
    increment(this.upstreamRequests, event.outcome);
    this.upstreamSeconds += event.durationMs / 1000;

    if (event.retry) {
      this.upstreamRetries++;
    }
  }

  /** @returns Seconds since the server started. */
  uptimeSeconds(): number {
    return Math.floor((this.now() - this.started) / 1000);
  }

  /**
   * Renders every counter in the Prometheus text exposition format.
   *
   * @param version Server version, exposed as a label of an info metric.
   * @returns Text for the /metrics response.
   */
  render(version: string): string {
    const lines: string[] = [];
    const metric = (name: string, type: string, help: string, samples: [string, number][]) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      samples.forEach(([labels, value]) => lines.push(`${name}${labels} ${value}`));
    };
    const byStatus = (counts: Map<string, number>): [string, number][] =>
      [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([status, value]) => [`{status="${status}"}`, value]);

    metric("jira_mcp_info", "gauge", "Server version.", [[`{version="${version.replace(/"/g, "")}"}`, 1]]);
    metric("jira_mcp_uptime_seconds", "gauge", "Seconds since the server started.", [["", this.uptimeSeconds()]]);
    metric(
      "jira_mcp_http_requests_total",
      "counter",
      "Requests to /mcp by the HTTP status that was sent.",
      byStatus(this.mcpRequests)
    );
    metric("jira_mcp_rate_limited_total", "counter", "Requests refused by the rate limiter.", [["", this.rateLimited]]);
    metric(
      "jira_mcp_atlassian_requests_total",
      "counter",
      "Requests sent to Atlassian (retries included) by status, or error when there was no answer.",
      byStatus(this.upstreamRequests)
    );
    metric("jira_mcp_atlassian_retries_total", "counter", "Requests to Atlassian that repeated an earlier one.", [
      ["", this.upstreamRetries]
    ]);
    metric("jira_mcp_atlassian_request_seconds_total", "counter", "Time spent waiting for Atlassian answers.", [
      ["", Math.round(this.upstreamSeconds * 1000) / 1000]
    ]);

    return `${lines.join("\n")}\n`;
  }
}

/**
 * Adds one to a counter in a map.
 *
 * @param counts Counters by label value.
 * @param key Label value.
 */
function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

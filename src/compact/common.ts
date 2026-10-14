// Formatting helpers shared by the Jira and Confluence Markdown renderers.

import type { JiraUser } from "../types.js";

// Long values (descriptions) would blow up a table row, so extra columns are clipped.
export const EXTRA_CELL_CHARS = 200;
const DATE_LENGTH = 16; // "2026-09-18T11:12"

/**
 * Display name of a Jira user with the email when it is available.
 *
 * @param user Jira user object, may be null.
 * @returns "Name <email>", the name alone, or an em dash.
 */
export function userName(user: JiraUser | null | undefined): string {
  if (!user) {
    return "—";
  }

  return user.emailAddress ? `${user.displayName} <${user.emailAddress}>` : (user.displayName ?? "—");
}

/**
 * Narrows an unchecked value to a list of present entries; null entries and non-arrays are dropped.
 *
 * @param value Value that should be an array.
 * @returns The non-null entries, or an empty list.
 */
export function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((entry) => entry !== null && entry !== undefined) as T[]) : [];
}

/**
 * Makes a value safe for a Markdown table cell (no pipes or line breaks).
 *
 * @param value Any value.
 * @returns Single-line text that is safe inside a table cell.
 */
export function cell(value: unknown): string {
  const text =
    typeof value === "string" || typeof value === "number" ? String(value) : value == null ? "" : JSON.stringify(value);
  return text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

/**
 * Shortens an ISO timestamp to "YYYY-MM-DD HH:MM".
 *
 * @param value ISO timestamp.
 * @returns "YYYY-MM-DD HH:MM", or an em dash when not a string.
 */
export function shortDate(value: unknown): string {
  return typeof value === "string" ? value.slice(0, DATE_LENGTH).replace("T", " ") : "—";
}

/**
 * Clips text to a maximum length with an ellipsis.
 *
 * @param text Text to clip.
 * @param max Maximum number of characters kept.
 * @returns The text, shortened when longer than max.
 */
export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Formats a byte count as a human-readable size.
 *
 * @param bytes Size in bytes.
 * @returns Human-readable size such as "1.5 MB"; an em dash for non-numbers.
 */
export function fileSize(bytes: unknown): string {
  const size = Number(bytes);
  if (!Number.isFinite(size)) {
    return "—";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Summary line for a listing that may have been cut by a limit.
 *
 * @param label Plural noun, e.g. projects.
 * @param shown Items shown.
 * @param total Items matching before the limit.
 * @returns Count line such as "5 of 12 projects (raise limit or narrow query)".
 */
export function countLine(label: string, shown: number, total: number): string {
  return shown < total ? `${shown} of ${total} ${label} (raise limit or narrow query)` : `${total} ${label}`;
}

/**
 * Renders a Markdown table; every value is made safe for a cell.
 *
 * @param headers Column titles.
 * @param rows Rows of cell values, one value per column.
 * @returns Header line, separator line and one line per row.
 */
export function table(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `|${"---|".repeat(headers.length)}`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)
  ].join("\n");
}

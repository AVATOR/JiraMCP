/**
 * JQL/CQL string literal; keeps keys like reserved words or odd characters from breaking the query.
 *
 * @param value Raw text, e.g. a project key.
 * @returns Double-quoted string literal.
 */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

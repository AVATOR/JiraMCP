// JQL/CQL string literal; keeps keys like reserved words or odd characters from breaking the query.
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

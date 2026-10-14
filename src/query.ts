/**
 * JQL/CQL string literal; keeps keys like reserved words or odd characters from breaking the query.
 *
 * @param value Raw text, e.g. a project key.
 * @returns Double-quoted string literal.
 */
export function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Characters that are operators in the Lucene syntax behind CQL `~` searches.
const CQL_RESERVED = /[+\-&|!(){}[\]^~*?:/]/g;

/**
 * CQL string literal for `~` (text/title) searches: besides quotes and backslashes it escapes the
 * Lucene operator characters, which otherwise make queries like `C++` or `what?` fail with a CQL error.
 *
 * @param value Raw search text.
 * @returns Double-quoted string literal safe for `text ~` and `title ~`.
 */
export function cqlSearchString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\\\\\")
    .replace(/"/g, '\\"')
    .replace(CQL_RESERVED, (char) => `\\\\${char}`);
  return `"${escaped}"`;
}

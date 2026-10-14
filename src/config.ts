import type { CustomFieldMapping } from "./types.js";

// Fields differ per Jira project, so they are configured per MCP connection via
// JIRA_CUSTOM_FIELDS: "customfield_10145:requirements,customfield_10170:discoveryQuestions".
// The alias is optional; without it the raw field id is used as-is.
export function parseCustomFields(raw: string | undefined): CustomFieldMapping[] {
  if (!raw?.trim()) {
    return [];
  }

  const mappings: CustomFieldMapping[] = [];

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    const [id, alias] = trimmed.split(":").map((part) => part.trim());

    if (!id) {
      continue;
    }

    if (mappings.some((mapping) => mapping.id === id)) {
      continue;
    }

    mappings.push({ id, alias: alias || id });
  }

  return mappings;
}

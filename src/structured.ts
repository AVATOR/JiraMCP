// Machine-readable results (MCP structuredContent) next to the Markdown text: the same compact
// whitelist the Markdown shows, so clients can use the data without parsing tables. Each
// schema is the tool's outputSchema; the mappers build the matching object.

import { z } from "zod";
import { adfToMarkdown } from "./adf.js";
import { list, shortDate } from "./compact/common.js";
import { commentBody, issueDescription } from "./compact/jira.js";
import { nextCursor } from "./query.js";
import { storageToMarkdown } from "./storage.js";
import type {
  ConfluenceAttachment,
  ConfluenceChildren,
  ConfluenceComment,
  ConfluencePage,
  ConfluenceSearchResult,
  ConfluenceSpace,
  ConfluenceSpacePages,
  ConfluenceVersion,
  CustomFieldMapping,
  JiraAttachment,
  JiraBoard,
  JiraChangelogEntry,
  JiraComment,
  JiraField,
  JiraFilter,
  JiraIssue,
  JiraIssueLink,
  JiraIssueRef,
  JiraProject,
  JiraProjectDetail,
  JiraReferenceItem,
  JiraRemoteLink,
  JiraSearchResult,
  JiraSprint,
  JiraTransition,
  JiraUser,
  JiraWorklog
} from "./types.js";

const str = z.string().optional();
const num = z.number().optional();

const user = z.object({ accountId: str, displayName: str, email: str }).optional();

/**
 * Compact person object.
 *
 * @param value Jira user.
 * @returns accountId, name and email, or undefined for no user.
 */
function person(value: JiraUser | null | undefined): z.infer<typeof user> {
  return value ? { accountId: value.accountId, displayName: value.displayName, email: value.emailAddress } : undefined;
}

// ---- Jira

const issueRef = z.object({ key: str, summary: str, status: str });

export const issueOutput = {
  key: str,
  summary: str,
  status: str,
  type: str,
  priority: str,
  resolution: str,
  assignee: user,
  reporter: user,
  project: str,
  parent: issueRef.optional(),
  labels: z.array(z.string()),
  components: z.array(z.string()),
  fixVersions: z.array(z.string()),
  due: str,
  created: str,
  updated: str,
  description: z.string(),
  links: z.array(z.object({ relation: str, issue: issueRef })),
  subtasks: z.array(issueRef),
  attachments: z.array(z.object({ id: str, filename: str, mimeType: str, size: num })),
  customFields: z.record(z.string())
};

/**
 * Structured form of jira_get_issue.
 *
 * @param issue Issue payload.
 * @param customFields Configured custom fields, keyed by alias in the result.
 * @returns Object matching issueOutput.
 */
export function issueData(
  issue: JiraIssue,
  customFields: CustomFieldMapping[]
): z.infer<z.ZodObject<typeof issueOutput>> {
  const fields = issue?.fields ?? {};
  const names = (values: unknown) =>
    Array.isArray(values)
      ? values.map((value) => (value as { name?: string } | null)?.name).filter((name): name is string => !!name)
      : [];
  const ref = (value: JiraIssueRef | undefined) => ({
    key: value?.key,
    summary: value?.fields?.summary,
    status: value?.fields?.status?.name
  });
  const custom: Record<string, string> = {};

  for (const { id, alias } of customFields) {
    const value = issueDescription(fields[id]);
    if (value) {
      custom[alias] = value;
    }
  }

  return {
    key: issue.key,
    summary: fields.summary,
    status: fields.status?.name,
    type: fields.issuetype?.name,
    priority: fields.priority?.name,
    resolution: fields.resolution?.name,
    assignee: person(fields.assignee),
    reporter: person(fields.reporter),
    project: fields.project?.key,
    parent: fields.parent ? ref(fields.parent) : undefined,
    labels: list<string>(fields.labels),
    components: names(fields.components),
    fixVersions: names(fields.fixVersions),
    due: fields.duedate ?? undefined,
    created: fields.created,
    updated: fields.updated,
    description: issueDescription(fields.description),
    links: list<JiraIssueLink>(fields.issuelinks).map((link) => {
      const outward = !!link.outwardIssue;
      return {
        relation: (outward ? link.type?.outward : link.type?.inward) ?? link.type?.name,
        issue: ref(outward ? link.outwardIssue : link.inwardIssue)
      };
    }),
    subtasks: list<JiraIssueRef>(fields.subtasks).map(ref),
    attachments: list<JiraAttachment>(fields.attachment).map((file) => ({
      id: file.id === undefined ? undefined : String(file.id),
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size
    })),
    customFields: custom
  };
}

export const searchOutput = {
  total: num,
  approximate: z.boolean().optional(),
  count: z.number(),
  issues: z.array(
    z.object({
      key: str,
      summary: str,
      status: str,
      type: str,
      priority: str,
      assignee: str,
      updated: str,
      fields: z.record(z.string())
    })
  ),
  nextPageToken: str,
  nextStartAt: num
};

/**
 * Structured form of a JQL search result.
 *
 * @param result Search response.
 * @param extraFields Extra requested field ids.
 * @param customFields Id-to-alias mappings for the extra fields.
 * @returns Object matching searchOutput.
 */
export function searchData(
  result: JiraSearchResult,
  extraFields: string[] = [],
  customFields: CustomFieldMapping[] = []
): z.infer<z.ZodObject<typeof searchOutput>> {
  const issues = list<JiraIssue>(result?.issues);
  const more = result?.nextPageToken && result?.isLast !== true;

  return {
    total: result?.total ?? result?.approximateTotal,
    approximate: result?.total === undefined && result?.approximateTotal !== undefined ? true : undefined,
    count: issues.length,
    issues: issues.map((issue) => {
      const f = issue.fields ?? {};
      const extras: Record<string, string> = {};

      for (const id of extraFields) {
        extras[customFields.find((field) => field.id === id)?.alias ?? id] = issueDescription(f[id]);
      }

      return {
        key: issue.key,
        summary: f.summary,
        status: f.status?.name,
        type: f.issuetype?.name,
        priority: f.priority?.name,
        assignee: f.assignee?.displayName,
        updated: f.updated,
        fields: extras
      };
    }),
    nextPageToken: more ? result.nextPageToken : undefined,
    nextStartAt: undefined
  };
}

export const commentsOutput = {
  issueKey: z.string(),
  total: z.number(),
  order: z.string(),
  comments: z.array(
    z.object({ id: z.string(), author: user, created: str, updated: str, body: z.string(), truncated: z.boolean() })
  )
};

/**
 * Structured form of jira_get_comments.
 *
 * @param comments Comments to show.
 * @param view Issue key, totals, order and truncation settings.
 * @returns Object matching commentsOutput.
 */
export function commentsData(
  comments: JiraComment[],
  view: { issueKey: string; total: number; order: string; maxLength: number; full: boolean }
): z.infer<z.ZodObject<typeof commentsOutput>> {
  return {
    issueKey: view.issueKey,
    total: view.total,
    order: view.order,
    comments: comments.map((comment) => {
      const { text, truncated } = commentBody(comment, view);
      return {
        id: String(comment.id),
        author: person(comment.author),
        created: comment.created,
        updated: comment.updated,
        body: text,
        truncated
      };
    })
  };
}

export const attachmentsOutput = {
  attachments: z.array(z.object({ id: str, filename: str, mimeType: str, size: num, author: user, created: str }))
};

/**
 * Structured form of jira_list_attachments.
 *
 * @param attachments Attachments of the issue.
 * @returns Object matching attachmentsOutput.
 */
export function attachmentsData(attachments: JiraAttachment[]): z.infer<z.ZodObject<typeof attachmentsOutput>> {
  return {
    attachments: list<JiraAttachment>(attachments).map((file) => ({
      id: file.id === undefined ? undefined : String(file.id),
      filename: file.filename,
      mimeType: file.mimeType,
      size: file.size,
      author: person(file.author),
      created: file.created
    }))
  };
}

export const fieldsOutput = {
  fields: z.array(z.object({ id: str, name: str, custom: z.boolean(), type: str }))
};

/**
 * Structured form of jira_list_fields.
 *
 * @param fields Jira fields.
 * @returns Object matching fieldsOutput.
 */
export function fieldsData(fields: JiraField[]): z.infer<z.ZodObject<typeof fieldsOutput>> {
  return {
    fields: fields.map((field) => ({
      id: field.id,
      name: field.name,
      custom: field.custom === true,
      type: field.schema?.type
    }))
  };
}

export const projectsOutput = {
  total: z.number(),
  projects: z.array(z.object({ key: str, name: str, type: str, style: str }))
};

/**
 * Structured form of jira_list_projects.
 *
 * @param projects Projects shown.
 * @param total Matches before the limit.
 * @returns Object matching projectsOutput.
 */
export function projectsData(projects: JiraProject[], total: number): z.infer<z.ZodObject<typeof projectsOutput>> {
  return {
    total,
    projects: projects.map((project) => ({
      key: project.key,
      name: project.name,
      type: project.projectTypeKey,
      style: project.style
    }))
  };
}

export const currentUserOutput = {
  accountId: str,
  displayName: str,
  email: str,
  timeZone: str,
  active: z.boolean().optional()
};

/**
 * Structured form of jira_get_current_user.
 *
 * @param value The /myself response.
 * @returns Object matching currentUserOutput.
 */
export function currentUserData(value: JiraUser | undefined): z.infer<z.ZodObject<typeof currentUserOutput>> {
  return {
    accountId: value?.accountId,
    displayName: value?.displayName,
    email: value?.emailAddress,
    timeZone: value?.timeZone,
    active: value?.active
  };
}

export const usersOutput = {
  users: z.array(z.object({ accountId: str, displayName: str, email: str, active: z.boolean() }))
};

/**
 * Structured form of jira_find_users.
 *
 * @param users Matching users.
 * @returns Object matching usersOutput.
 */
export function usersData(users: JiraUser[]): z.infer<z.ZodObject<typeof usersOutput>> {
  return {
    users: users.map((entry) => ({
      accountId: entry.accountId,
      displayName: entry.displayName,
      email: entry.emailAddress,
      active: entry.active !== false
    }))
  };
}

export const changelogOutput = {
  issueKey: z.string(),
  total: z.number(),
  changes: z.array(
    z.object({
      created: str,
      author: user,
      items: z.array(z.object({ field: str, from: str, to: str }))
    })
  )
};

/**
 * Structured form of jira_get_changelog.
 *
 * @param entries Change sets shown, newest first.
 * @param issueKey Issue key.
 * @param total Change sets matching before the limit.
 * @returns Object matching changelogOutput.
 */
export function changelogData(
  entries: JiraChangelogEntry[],
  issueKey: string,
  total: number
): z.infer<z.ZodObject<typeof changelogOutput>> {
  return {
    issueKey,
    total,
    changes: entries.map((entry) => ({
      created: entry.created,
      author: person(entry.author),
      items: (entry.items ?? []).map((item) => ({
        field: item.field,
        from: item.fromString ?? undefined,
        to: item.toString ?? undefined
      }))
    }))
  };
}

export const worklogsOutput = {
  issueKey: z.string(),
  totalSeconds: z.number(),
  worklogs: z.array(
    z.object({ started: str, author: user, timeSpent: str, timeSpentSeconds: num, comment: z.string() })
  )
};

/**
 * Structured form of jira_get_worklogs.
 *
 * @param worklogs Worklogs of the issue.
 * @param issueKey Issue key.
 * @returns Object matching worklogsOutput.
 */
export function worklogsData(worklogs: JiraWorklog[], issueKey: string): z.infer<z.ZodObject<typeof worklogsOutput>> {
  return {
    issueKey,
    totalSeconds: worklogs.reduce((sum, worklog) => sum + (worklog.timeSpentSeconds ?? 0), 0),
    worklogs: worklogs.map((worklog) => ({
      started: worklog.started,
      author: person(worklog.author),
      timeSpent: worklog.timeSpent,
      timeSpentSeconds: worklog.timeSpentSeconds,
      comment: adfToMarkdown(worklog.comment)
    }))
  };
}

export const transitionsOutput = {
  issueKey: z.string(),
  transitions: z.array(z.object({ id: str, name: str, to: str }))
};

/**
 * Structured form of jira_list_transitions.
 *
 * @param transitions Available transitions.
 * @param issueKey Issue key.
 * @returns Object matching transitionsOutput.
 */
export function transitionsData(
  transitions: JiraTransition[],
  issueKey: string
): z.infer<z.ZodObject<typeof transitionsOutput>> {
  return {
    issueKey,
    transitions: transitions.map((transition) => ({
      id: transition.id,
      name: transition.name,
      to: transition.to?.name
    }))
  };
}

export const metadataOutput = {
  kind: z.string(),
  total: z.number(),
  items: z.array(z.object({ id: str, name: str, category: str, subtask: z.boolean().optional(), description: str }))
};

/**
 * Structured form of jira_list_metadata.
 *
 * @param items Statuses, issue types or priorities shown.
 * @param kind Which list it is.
 * @param total Matches before the limit.
 * @returns Object matching metadataOutput.
 */
export function metadataData(
  items: JiraReferenceItem[],
  kind: string,
  total: number
): z.infer<z.ZodObject<typeof metadataOutput>> {
  return {
    kind,
    total,
    items: items.map((item) => ({
      id: item.id,
      name: item.name,
      category: item.statusCategory?.name,
      subtask: item.subtask,
      description: item.description
    }))
  };
}

export const projectOutput = {
  key: str,
  name: str,
  type: str,
  lead: user,
  description: str,
  issueTypes: z.array(z.string()),
  components: z.array(z.object({ name: str, lead: user })),
  versions: z.array(z.object({ name: str, state: z.string(), releaseDate: str }))
};

/**
 * Structured form of jira_get_project.
 *
 * @param project Project details.
 * @returns Object matching projectOutput.
 */
export function projectData(project: JiraProjectDetail): z.infer<z.ZodObject<typeof projectOutput>> {
  return {
    key: project.key,
    name: project.name,
    type: project.projectTypeKey,
    lead: person(project.lead),
    description: project.description,
    issueTypes: (project.issueTypes ?? []).map((type) => type.name).filter((name): name is string => !!name),
    components: (project.components ?? []).map((component) => ({
      name: component.name,
      lead: person(component.lead)
    })),
    versions: (project.versions ?? []).map((version) => ({
      name: version.name,
      state: version.archived ? "archived" : version.released ? "released" : "unreleased",
      releaseDate: version.releaseDate
    }))
  };
}

export const filtersOutput = {
  filters: z.array(z.object({ id: str, name: str, owner: user, jql: str }))
};

/**
 * Structured form of jira_list_filters.
 *
 * @param filters Saved filters.
 * @returns Object matching filtersOutput.
 */
export function filtersData(filters: JiraFilter[]): z.infer<z.ZodObject<typeof filtersOutput>> {
  return {
    filters: filters.map((filter) => ({
      id: filter.id,
      name: filter.name,
      owner: person(filter.owner),
      jql: filter.jql
    }))
  };
}

export const runFilterOutput = {
  filter: z.object({ id: str, name: str, jql: str }),
  ...searchOutput
};

export const remoteLinksOutput = {
  issueKey: z.string(),
  links: z.array(z.object({ title: str, url: str, relationship: str, application: str }))
};

/**
 * Structured form of jira_get_remote_links.
 *
 * @param links Remote links.
 * @param issueKey Issue key.
 * @returns Object matching remoteLinksOutput.
 */
export function remoteLinksData(
  links: JiraRemoteLink[],
  issueKey: string
): z.infer<z.ZodObject<typeof remoteLinksOutput>> {
  return {
    issueKey,
    links: links.map((link) => ({
      title: link.object?.title,
      url: link.object?.url,
      relationship: link.relationship,
      application: link.application?.name
    }))
  };
}

export const boardsOutput = {
  boards: z.array(z.object({ id: num, name: str, type: str, project: str }))
};

/**
 * Structured form of jira_list_boards.
 *
 * @param boards Agile boards.
 * @returns Object matching boardsOutput.
 */
export function boardsData(boards: JiraBoard[]): z.infer<z.ZodObject<typeof boardsOutput>> {
  return {
    boards: boards.map((board) => ({
      id: board.id,
      name: board.name,
      type: board.type,
      project: board.location?.projectKey ?? board.location?.displayName
    }))
  };
}

export const sprintsOutput = {
  boardId: z.string(),
  sprints: z.array(z.object({ id: num, name: str, state: str, startDate: str, endDate: str, goal: str }))
};

/**
 * Structured form of jira_list_sprints.
 *
 * @param sprints Sprints of the board.
 * @param boardId Board id.
 * @returns Object matching sprintsOutput.
 */
export function sprintsData(sprints: JiraSprint[], boardId: string): z.infer<z.ZodObject<typeof sprintsOutput>> {
  return {
    boardId,
    sprints: sprints.map((sprint) => ({
      id: sprint.id,
      name: sprint.name,
      state: sprint.state,
      startDate: sprint.startDate,
      endDate: sprint.endDate,
      goal: sprint.goal
    }))
  };
}

// ---- Confluence

const cursor = z.string().optional();

export const pageOutput = {
  id: str,
  title: str,
  spaceId: str,
  parentId: str,
  version: num,
  modified: str,
  url: str,
  path: z.array(z.object({ id: str, title: str })),
  labels: z.array(z.string()),
  body: z.string()
};

/**
 * Structured form of confluence_get_page.
 *
 * @param page Page with a storage-format body.
 * @param wikiBaseUrl Base URL used to build the page link.
 * @param ancestors Ancestors, top-most first.
 * @returns Object matching pageOutput.
 */
export function pageData(
  page: ConfluencePage,
  wikiBaseUrl: string,
  ancestors: { id?: string; title?: string }[] = []
): z.infer<z.ZodObject<typeof pageOutput>> {
  return {
    id: page?.id,
    title: page?.title,
    spaceId: page?.spaceId,
    parentId: page?.parentId,
    version: page?.version?.number,
    modified: page?.version?.createdAt,
    url: page?._links?.webui ? `${wikiBaseUrl}${page._links.webui}` : undefined,
    path: ancestors.map((ancestor) => ({ id: ancestor.id, title: ancestor.title })),
    labels: (page?.labels?.results ?? []).map((label) => label.name).filter((name): name is string => !!name),
    body: storageToMarkdown(page?.body?.storage?.value ?? "")
  };
}

export const childrenOutput = {
  pageId: z.string(),
  pages: z.array(z.object({ id: str, title: str })),
  cursor
};

/**
 * Structured form of confluence_get_page_children.
 *
 * @param result Children response.
 * @param pageId Parent page id.
 * @returns Object matching childrenOutput.
 */
export function childrenData(result: ConfluenceChildren, pageId: string): z.infer<z.ZodObject<typeof childrenOutput>> {
  return {
    pageId,
    pages: (result?.results ?? []).map((page) => ({ id: page.id, title: page.title })),
    cursor: nextCursor(result?._links) ?? undefined
  };
}

export const confluenceCommentsOutput = {
  pageId: z.string(),
  kind: z.string(),
  comments: z.array(z.object({ id: str, created: str, authorId: str, resolution: str, body: z.string() })),
  cursor
};

/**
 * Structured form of confluence_get_page_comments.
 *
 * @param comments Comments of one kind.
 * @param view Page id, kind and next cursor.
 * @returns Object matching confluenceCommentsOutput.
 */
export function confluenceCommentsData(
  comments: ConfluenceComment[],
  view: { pageId: string; kind: string; cursor: string | null }
): z.infer<z.ZodObject<typeof confluenceCommentsOutput>> {
  return {
    pageId: view.pageId,
    kind: view.kind,
    comments: comments.map((comment) => ({
      id: comment.id,
      created: comment.version?.createdAt,
      authorId: comment.version?.authorId,
      resolution: comment.resolutionStatus,
      body: storageToMarkdown(comment.body?.storage?.value ?? "")
    })),
    cursor: view.cursor ?? undefined
  };
}

export const confluenceAttachmentsOutput = {
  pageId: z.string(),
  attachments: z.array(z.object({ id: str, filename: str, mediaType: str, size: num, created: str })),
  cursor
};

/**
 * Structured form of confluence_list_attachments.
 *
 * @param result Attachments response.
 * @param pageId Page id.
 * @returns Object matching confluenceAttachmentsOutput.
 */
export function confluenceAttachmentsData(
  result: { results?: ConfluenceAttachment[]; _links?: { next?: string } },
  pageId: string
): z.infer<z.ZodObject<typeof confluenceAttachmentsOutput>> {
  return {
    pageId,
    attachments: (result?.results ?? []).map((file) => ({
      id: file.id,
      filename: file.title,
      mediaType: file.mediaType,
      size: file.fileSize,
      created: file.createdAt ?? file.version?.createdAt
    })),
    cursor: nextCursor(result?._links) ?? undefined
  };
}

export const versionsOutput = {
  pageId: z.string(),
  versions: z.array(z.object({ number: num, created: str, authorId: str, minorEdit: z.boolean(), message: str })),
  cursor
};

/**
 * Structured form of confluence_get_page_versions.
 *
 * @param result Versions response.
 * @param pageId Page id.
 * @returns Object matching versionsOutput.
 */
export function versionsData(
  result: { results?: ConfluenceVersion[]; _links?: { next?: string } },
  pageId: string
): z.infer<z.ZodObject<typeof versionsOutput>> {
  return {
    pageId,
    versions: (result?.results ?? []).map((version) => ({
      number: version.number,
      created: version.createdAt,
      authorId: version.authorId,
      minorEdit: version.minorEdit === true,
      message: version.message
    })),
    cursor: nextCursor(result?._links) ?? undefined
  };
}

export const confluenceSearchOutput = {
  total: num,
  pages: z.array(z.object({ id: str, title: str, space: str, modified: str })),
  cursor
};

/**
 * Structured form of confluence_search_pages.
 *
 * @param result CQL search response.
 * @returns Object matching confluenceSearchOutput.
 */
export function confluenceSearchData(
  result: ConfluenceSearchResult
): z.infer<z.ZodObject<typeof confluenceSearchOutput>> {
  return {
    total: result?.totalSize,
    pages: (result?.results ?? []).map((page) => ({
      id: page.content?.id,
      title: page.content?.title ?? page.title,
      space:
        page.resultGlobalContainer?.displayUrl?.match(/\/spaces\/([^/]+)/)?.[1] ??
        page.content?.space?.key ??
        page.resultGlobalContainer?.title,
      modified: page.lastModified ? shortDate(page.lastModified) : undefined
    })),
    cursor: nextCursor((result as { _links?: { next?: string } })?._links) ?? undefined
  };
}

export const spacePagesOutput = {
  spaceKey: z.string(),
  pages: z.array(z.object({ id: str, title: str, parentId: str, modified: str })),
  cursor
};

/**
 * Structured form of confluence_get_space_pages.
 *
 * @param result Space pages response.
 * @param spaceKey Space key.
 * @returns Object matching spacePagesOutput.
 */
export function spacePagesData(
  result: ConfluenceSpacePages,
  spaceKey: string
): z.infer<z.ZodObject<typeof spacePagesOutput>> {
  return {
    spaceKey,
    pages: (result?.results ?? []).map((page) => ({
      id: page.id,
      title: page.title,
      parentId: page.parentId,
      modified: page.version?.createdAt
    })),
    cursor: nextCursor(result?._links) ?? undefined
  };
}

export const spacesOutput = {
  total: z.number(),
  spaces: z.array(z.object({ key: str, name: str, type: str, status: str }))
};

/**
 * Structured form of confluence_list_spaces.
 *
 * @param spaces Spaces shown.
 * @param total Matches before the limit.
 * @returns Object matching spacesOutput.
 */
export function spacesData(spaces: ConfluenceSpace[], total: number): z.infer<z.ZodObject<typeof spacesOutput>> {
  return {
    total,
    spaces: spaces.map((space) => ({ key: space.key, name: space.name, type: space.type, status: space.status }))
  };
}

// ---- Attachments

export const downloadOutput = {
  path: z.string(),
  filename: str,
  mimeType: z.string(),
  bytes: z.number(),
  inlined: z.boolean()
};

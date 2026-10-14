// Minimal shapes of the Jira/Confluence payloads the server reads. Every property is
// optional because the APIs omit fields freely; only what the code touches is described.

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type CustomFieldMapping = {
  id: string;
  alias: string;
};

export type JiraClientConfig = {
  baseUrl: string;
  email: string;
  apiToken: string;
  defaultProject?: string;
  customFields: CustomFieldMapping[];
};

// Jira objects carry many more properties (self, avatarUrls, iconUrl, ...) that are never read.
export type JiraNamed = { name?: string; [key: string]: unknown };

export type JiraUser = {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  active?: boolean;
  timeZone?: string;
  accountType?: string;
  [key: string]: unknown;
};

export type JiraAttachment = {
  id?: string | number;
  filename?: string;
  mimeType?: string;
  size?: number;
  author?: JiraUser;
  created?: string;
};

export type JiraComment = {
  id: string | number;
  // ADF document, rendered by adfToMarkdown.
  body?: unknown;
  author?: JiraUser;
  created?: string;
  updated?: string;
};

export type JiraCommentPage = {
  comments?: JiraComment[];
  total?: number;
};

export type JiraIssueRef = {
  key?: string;
  fields?: { summary?: string; status?: JiraNamed };
};

export type JiraIssueLink = {
  type?: { name?: string; inward?: string; outward?: string };
  inwardIssue?: JiraIssueRef;
  outwardIssue?: JiraIssueRef;
};

export type JiraIssueFields = {
  summary?: string;
  status?: JiraNamed;
  issuetype?: JiraNamed;
  priority?: JiraNamed;
  resolution?: JiraNamed;
  assignee?: JiraUser | null;
  reporter?: JiraUser | null;
  project?: { key?: string };
  parent?: JiraIssueRef;
  labels?: string[];
  components?: JiraNamed[];
  fixVersions?: JiraNamed[];
  duedate?: string | null;
  created?: string;
  updated?: string;
  issuelinks?: JiraIssueLink[];
  subtasks?: JiraIssueRef[];
  attachment?: JiraAttachment[];
  description?: unknown;
  // Configured custom fields (customfield_*) are looked up by id.
  [fieldId: string]: unknown;
};

export type JiraIssue = {
  key?: string;
  fields?: JiraIssueFields;
  renderedFields?: Record<string, unknown>;
};

export type JiraSearchResult = {
  issues?: JiraIssue[];
  total?: number;
  nextPageToken?: string;
  isLast?: boolean;
};

export type JiraField = {
  id?: string;
  name?: string;
  custom?: boolean;
  schema?: { type?: string };
};

export type JiraProject = {
  key?: string;
  name?: string;
  projectTypeKey?: string;
  style?: string;
};

export type JiraProjectSearchPage = {
  values?: JiraProject[];
  isLast?: boolean;
};

export type JiraAttachmentMeta = {
  filename?: string;
  mimeType?: string;
  size?: number | string;
};

export type ConfluenceSpace = {
  id?: string;
  key?: string;
  name?: string;
  type?: string;
  status?: string;
};

export type ConfluenceLinks = { next?: string; webui?: string };

export type ConfluenceSpaceList = {
  results?: ConfluenceSpace[];
  _links?: ConfluenceLinks;
};

export type ConfluencePageSummary = {
  id?: string;
  title?: string;
  parentId?: string;
  version?: { number?: number; createdAt?: string };
};

export type ConfluenceSpacePages = {
  results?: ConfluencePageSummary[];
  _links?: ConfluenceLinks;
};

export type ConfluencePage = ConfluencePageSummary & {
  spaceId?: string;
  body?: { storage?: { value?: string } };
  _links?: ConfluenceLinks;
};

export type ConfluenceSearchHit = {
  title?: string;
  url?: string;
  lastModified?: string;
  excerpt?: string;
  content?: { id?: string; title?: string; space?: { key?: string } };
  resultGlobalContainer?: { title?: string; displayUrl?: string };
};

export type ConfluenceSearchResult = {
  results?: ConfluenceSearchHit[];
  totalSize?: number;
  _links?: ConfluenceLinks;
};

export type JiraChangelogItem = {
  field?: string;
  fromString?: string | null;
  toString?: string | null;
};

export type JiraChangelogEntry = {
  id?: string;
  author?: JiraUser;
  created?: string;
  items?: JiraChangelogItem[];
};

export type JiraWorklog = {
  id?: string;
  author?: JiraUser;
  started?: string;
  timeSpent?: string;
  timeSpentSeconds?: number;
  // ADF document, rendered by adfToMarkdown.
  comment?: unknown;
};

export type JiraTransition = {
  id?: string;
  name?: string;
  to?: JiraNamed;
};

// Statuses, issue types and priorities share one shape for listing purposes.
export type JiraReferenceItem = {
  id?: string;
  name?: string;
  description?: string;
  subtask?: boolean;
  statusCategory?: JiraNamed;
};

export type JiraProjectDetail = {
  key?: string;
  name?: string;
  description?: string;
  projectTypeKey?: string;
  lead?: JiraUser;
  issueTypes?: JiraReferenceItem[];
  components?: { name?: string; description?: string; lead?: JiraUser }[];
  versions?: { name?: string; released?: boolean; archived?: boolean; releaseDate?: string }[];
};

export type JiraFilter = {
  id?: string;
  name?: string;
  jql?: string;
  description?: string;
  owner?: JiraUser;
};

export type JiraRemoteLink = {
  id?: number | string;
  relationship?: string;
  application?: { name?: string };
  object?: { url?: string; title?: string; summary?: string };
};

export type JiraBoard = {
  id?: number;
  name?: string;
  type?: string;
  location?: { projectKey?: string; displayName?: string };
};

export type JiraSprint = {
  id?: number;
  name?: string;
  state?: string;
  startDate?: string;
  endDate?: string;
  goal?: string;
};

// startAt-paginated listings; the items live under a different key per endpoint.
export type JiraPage = {
  values?: unknown[];
  worklogs?: unknown[];
  isLast?: boolean;
  total?: number;
};

export type JiraSprintIssues = JiraSearchResult & { startAt?: number; maxResults?: number };

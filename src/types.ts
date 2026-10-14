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
};

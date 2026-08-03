import {
  APIErrorCode,
  Client,
  collectPaginatedAPI,
  isFullBlock,
  isFullDatabase,
  isFullPage,
  isNotionClientError,
} from '@notionhq/client';
import type {
  CreatePageParameters,
  PageObjectResponse,
  QueryDatabaseParameters,
  QueryDatabaseResponse,
  UpdatePageParameters,
} from '@notionhq/client/build/src/api-endpoints';
import { isMovCompatibilityTrialEligible } from '@/lib/mov-compatibility-trial';
import type {
  PublishReadyPostResponse,
  ReadyPostCandidateKind,
  ReadyXhsPost,
  XhsPost,
} from '@/types/ready-post';
import type {
  ExternalPostSnapshot,
  ExternalReconciliationOutcome,
} from '@/types/local-publish-job';

export type PropertyMap = Record<string, {
  type: string;
  select?: { options: Array<{ name: string }> };
}>;
type PageProperty = PageObjectResponse['properties'][string];
type PropertyUpdates = UpdatePageParameters['properties'];
type DatabaseFilter = NonNullable<QueryDatabaseParameters['filter']>;

const NOTION_TIMEOUT_MS = 10_000;

const PROPERTY_ALIASES = {
  headline: ['Headline', 'Name', 'Title'],
  platform: ['Platform', 'Platforms'],
  status: ['Status'],
  thumbnail: ['Thumbnail', 'Thumbnail URL'],
  mediaUrls: ['Image URLs', 'Image URL', 'Images'],
  caption: ['Weibo text', 'Weibo Text', 'Weibo', 'Caption'],
  publishPacketReady: ['Publish packet ready', 'Publish Packet Ready', 'Packet ready'],
  hasVideo: ['Has video', 'Has Video'],
  needsMedia: ['Needs media', 'Needs Media'],
  needsCaption: ['Needs caption', 'Needs Caption'],
  tags: ['Final Tags', 'Final tags'],
  xhsNoteId: ['XHS Note ID', 'XHS note ID', 'Rednote Note ID', 'Rednote note ID'],
  xhsShareUrl: [
    'XHS Share URL',
    'XHS URL',
    'Rednote Share URL',
    'Rednote URL',
    'Published URL',
    'Share URL',
  ],
  publishedAt: ['Published at', 'Published At', 'XHS Published At', 'Rednote Published At'],
  nextAction: ['Next action', 'Next Action'],
  scheduledDate: ['ScheduledDate'],
} as const;

export type CanonicalProperty = keyof typeof PROPERTY_ALIASES;
export type ResolvedSchema = Record<CanonicalProperty, string | null>;

export class NotionPostsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

export function normalizeNotionPostsError(error: unknown) {
  if (error instanceof NotionPostsError) return error;
  if (
    isNotionClientError(error) &&
    (
      error.code === APIErrorCode.ObjectNotFound ||
      error.code === APIErrorCode.RestrictedResource ||
      error.code === APIErrorCode.Unauthorized
    )
  ) {
    return new NotionPostsError(
      'The configured Notion integration cannot access the Posts database. ' +
      'Reconnect the database to the integration, then refresh.',
      'NOTION_DATABASE_UNAVAILABLE',
      503,
    );
  }
  return new NotionPostsError(
    'Failed to load ready posts',
    'READY_POSTS_LOAD_FAILED',
    502,
  );
}

function getClient() {
  const auth = process.env.NOTION_API_KEY?.trim();
  if (!auth) {
    throw new NotionPostsError(
      'NOTION_API_KEY is not configured',
      'NOTION_NOT_CONFIGURED',
      503,
    );
  }
  return new Client({ auth, timeoutMs: NOTION_TIMEOUT_MS });
}

function getDatabaseId() {
  const databaseId = process.env.NOTION_POSTS_DB_ID?.trim();
  if (!databaseId) {
    throw new NotionPostsError(
      'NOTION_POSTS_DB_ID is not configured',
      'NOTION_NOT_CONFIGURED',
      503,
    );
  }
  return databaseId;
}

export function resolvePostsSchema(properties: PropertyMap) {
  const resolved = {} as ResolvedSchema;
  const duplicateAliases: Partial<Record<CanonicalProperty, string[]>> = {};
  const warnings: string[] = [];

  for (const [canonical, aliases] of Object.entries(PROPERTY_ALIASES) as [
    CanonicalProperty,
    readonly string[],
  ][]) {
    const present = aliases.filter((alias) => Boolean(properties[alias]));
    resolved[canonical] = present[0] ?? null;
    if (present.length > 1) {
      duplicateAliases[canonical] = present;
      warnings.push(`${canonical} has multiple schema aliases: ${present.join(', ')}`);
    }
  }

  return { resolved, duplicateAliases, warnings };
}

function property(page: PageObjectResponse, schema: ResolvedSchema, key: CanonicalProperty) {
  const name = schema[key];
  return name ? page.properties[name] : undefined;
}

function plainText(value: PageProperty | undefined): string {
  if (!value) return '';
  if (value.type === 'title') return value.title.map((item) => item.plain_text).join('');
  if (value.type === 'rich_text') return value.rich_text.map((item) => item.plain_text).join('');
  if (value.type === 'select') return value.select?.name ?? '';
  if (value.type === 'status') return value.status?.name ?? '';
  if (value.type === 'url') return value.url ?? '';
  return '';
}

function values(value: PageProperty | undefined): string[] {
  if (!value) return [];
  if (value.type === 'multi_select') return value.multi_select.map((item) => item.name);
  const text = plainText(value);
  return text ? [text] : [];
}

function multiSelectNames(value: PageProperty | undefined): string[] {
  return value?.type === 'multi_select'
    ? value.multi_select.map((item) => item.name)
    : [];
}

function checkbox(value: PageProperty | undefined): boolean {
  if (!value) return false;
  if (value.type === 'checkbox') return value.checkbox;
  if (value.type === 'formula' && value.formula.type === 'boolean') {
    return value.formula.boolean ?? false;
  }
  return plainText(value).trim().toLowerCase() === 'true';
}

function date(value: PageProperty | undefined): string {
  return value?.type === 'date' ? value.date?.start ?? '' : '';
}

const ISO_DATETIME_WITH_TIMEZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

export function canonicalPublishAt(value: string) {
  const candidate = value.trim();
  const parts = candidate.match(ISO_DATETIME_WITH_TIMEZONE);
  if (!parts) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] =
    parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText ?? '0');
  const offsetHour = Number(offsetHourText ?? '0');
  const offsetMinute = Number(offsetMinuteText ?? '0');
  const daysInMonth = month >= 1 && month <= 12
    ? new Date(Date.UTC(year, month, 0)).getUTCDate()
    : 0;
  if (
    year < 1 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return undefined;
  }
  const timestamp = new Date(candidate);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

export function extractLegacyTrailingHashtags(caption: string) {
  const match = caption.match(/(?:^|\s)((?:#[^\s#]+(?:\s+|$))+)\s*$/);
  if (!match || match.index === undefined) {
    return { caption: caption.trim(), tags: [] as string[] };
  }
  const tags = Array.from(new Set(
    Array.from(match[1].matchAll(/#([^\s#]+)/g), (item) => item[1]),
  ));
  return {
    caption: caption.slice(0, match.index).trimEnd(),
    tags,
  };
}

function urls(value: PageProperty | undefined): string[] {
  if (!value) return [];
  if (value.type === 'files') {
    return value.files.flatMap((file) => {
      if (file.type === 'external') return file.external.url;
      if (file.type === 'file') return file.file.url;
      return [];
    });
  }
  return plainText(value)
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter((item) => /^https?:\/\//i.test(item));
}

export function isCanonicalMediaVideo(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'images.xhs.justlikekatie.com' &&
      parsed.pathname.startsWith('/videos/assets/') &&
      parsed.pathname.toLowerCase().endsWith('.mp4');
  } catch {
    return false;
  }
}

export function isCanonicalMediaMov(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'images.xhs.justlikekatie.com' &&
      parsed.pathname.startsWith('/videos/assets/') &&
      parsed.pathname.toLowerCase().endsWith('.mov');
  } catch {
    return false;
  }
}

export function isCanonicalMediaImage(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'images.xhs.justlikekatie.com' &&
      /\.(?:jpe?g|png|webp)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function normalized(value: string) {
  return value.trim().toLowerCase();
}

function mappedBlockers(
  page: PageObjectResponse,
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  caption: string,
  hasInvalidScheduledDate: boolean,
) {
  const blockers: string[] = [];
  for (const key of ['status', 'xhsShareUrl'] as const) {
    if (!schema[key]) blockers.push(`Posts DB has no mapped ${key} property`);
    if (duplicates[key]) blockers.push(`${key} has multiple aliases in the Posts DB`);
  }
  if (!plainText(property(page, schema, 'headline')).trim()) blockers.push('Headline is empty');
  if (!caption) blockers.push('Weibo text is empty');
  if (hasInvalidScheduledDate) {
    blockers.push('ScheduledDate must include a valid publish time and timezone');
  }
  if (checkbox(property(page, schema, 'needsMedia'))) blockers.push('Needs media is still checked');
  if (checkbox(property(page, schema, 'needsCaption'))) blockers.push('Needs caption is still checked');
  if (!urls(property(page, schema, 'mediaUrls')).some((url) =>
    isCanonicalMediaVideo(url) || isCanonicalMediaImage(url))) {
    blockers.push('No canonical HTTPS Rednote media is attached');
  }
  return blockers;
}

export function mapReadyXhsPost(
  page: PageObjectResponse,
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>> = {},
): XhsPost {
  const mediaUrls = urls(property(page, schema, 'mediaUrls'));
  const rawCaption = plainText(property(page, schema, 'caption'));
  const finalTags = multiSelectNames(property(page, schema, 'tags'));
  const legacyCopy = finalTags.length === 0
    ? extractLegacyTrailingHashtags(rawCaption)
    : { caption: rawCaption.trim(), tags: [] };
  const scheduledDate = date(property(page, schema, 'scheduledDate'));
  const publishAt = canonicalPublishAt(scheduledDate);
  const tags = finalTags.length > 0 ? finalTags : legacyCopy.tags;
  const tagsSource = finalTags.length > 0
    ? 'final-tags' as const
    : 'legacy-caption' as const;
  return {
    id: page.id,
    pageUrl: page.url,
    headline: plainText(property(page, schema, 'headline')),
    caption: legacyCopy.caption,
    status: plainText(property(page, schema, 'status')),
    publishPacketReady: checkbox(property(page, schema, 'publishPacketReady')),
    hasVideo: checkbox(property(page, schema, 'hasVideo')),
    needsMedia: checkbox(property(page, schema, 'needsMedia')),
    needsCaption: checkbox(property(page, schema, 'needsCaption')),
    mediaUrls,
    imageUrls: mediaUrls.filter(isCanonicalMediaImage),
    videoUrls: mediaUrls.filter(isCanonicalMediaVideo),
    compatibilityTrialVideoUrls: mediaUrls.filter(isCanonicalMediaMov),
    thumbnailUrl: urls(property(page, schema, 'thumbnail'))[0] ?? '',
    tags,
    tagsSource,
    ...(publishAt ? { publishAt } : {}),
    lastEditedTime: page.last_edited_time,
    publishBlockers: mappedBlockers(
      page,
      schema,
      duplicates,
      legacyCopy.caption,
      Boolean(scheduledDate) && !publishAt,
    ),
  };
}

function isUnpublishedRednotePost(page: PageObjectResponse, schema: ResolvedSchema) {
  const platforms = values(property(page, schema, 'platform')).map(normalized);
  const isRednote = platforms.some((platform) =>
    platform === 'xhs' ||
    platform.includes('rednote') ||
    platform.includes('xiaohongshu') ||
    platform.includes('小红书'),
  );
  return isRednote && normalized(plainText(property(page, schema, 'status'))) !== 'published';
}

export function classifyReadyPostCandidate(post: XhsPost): ReadyPostCandidateKind | null {
  if (post.publishPacketReady) return 'packet_ready';
  if (isMovCompatibilityTrialEligible(post)) return 'mov_compatibility_trial';
  return null;
}

export function toReadyPostCandidate(
  page: PageObjectResponse,
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
): ReadyXhsPost | null {
  if (!isUnpublishedRednotePost(page, schema)) return null;
  const post = mapReadyXhsPost(page, schema, duplicates);
  const candidateKind = classifyReadyPostCandidate(post);
  return candidateKind ? { ...post, candidateKind } : null;
}

function assertPageId(pageId: string) {
  if (!/^[0-9a-f]{32}$/i.test(pageId.replaceAll('-', ''))) {
    throw new NotionPostsError('Invalid Notion page id', 'VALIDATION_ERROR', 400);
  }
}

function assertPostsDatabaseParent(page: PageObjectResponse) {
  const parentId = page.parent.type === 'database_id'
    ? page.parent.database_id.replaceAll('-', '').toLowerCase()
    : '';
  if (parentId !== getDatabaseId().replaceAll('-', '').toLowerCase()) {
    throw new NotionPostsError(
      'Post was not found in the configured Posts database',
      'POST_NOT_FOUND',
      404,
    );
  }
}

async function loadSchema(client: Client) {
  const database = await client.databases.retrieve({ database_id: getDatabaseId() });
  if (!isFullDatabase(database)) {
    throw new NotionPostsError(
      'Notion returned a partial database schema',
      'NOTION_SCHEMA_ERROR',
      502,
    );
  }
  return {
    ...resolvePostsSchema(database.properties),
    properties: database.properties,
  };
}

export function buildReadyPostCandidatesQueryFilter(
  packetPropertyName: string | null,
  packetPropertyType: string | undefined,
  mediaPropertyName: string | null,
  mediaPropertyType: string | undefined,
): DatabaseFilter | undefined {
  if (
    !packetPropertyName ||
    packetPropertyType !== 'checkbox' ||
    !mediaPropertyName ||
    mediaPropertyType !== 'rich_text'
  ) {
    return undefined;
  }
  return {
    or: [
      { property: packetPropertyName, checkbox: { equals: true } },
      { property: mediaPropertyName, rich_text: { contains: '.mov' } },
    ],
  };
}

export async function queryReadyCandidatePages(
  client: Client,
  schema: ResolvedSchema,
  properties: PropertyMap,
  databaseId = getDatabaseId(),
) {
  const filter = buildReadyPostCandidatesQueryFilter(
    schema.publishPacketReady,
    schema.publishPacketReady
      ? properties[schema.publishPacketReady]?.type
      : undefined,
    schema.mediaUrls,
    schema.mediaUrls ? properties[schema.mediaUrls]?.type : undefined,
  );
  const response: QueryDatabaseResponse = await client.databases.query({
    database_id: databaseId,
    page_size: 100,
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    ...(filter ? { filter } : {}),
  });
  if (response.has_more) {
    throw new NotionPostsError(
      filter
        ? 'More than 100 ready or MOV trial candidates were found; reduce the queue before retrying'
        : 'The Posts schema requires a bounded candidate scan, but more than 100 records matched; ' +
          'restore checkbox/rich-text query fields or reduce the database before retrying',
      'READY_POSTS_LIMIT_EXCEEDED',
      503,
    );
  }
  return response.results.filter(isFullPage);
}

async function notionBoundary<T>(
  boundary: 'schema' | 'query',
  requestId: string,
  operation: () => Promise<T>,
) {
  const startedAt = Date.now();
  console.info('Ready posts Notion boundary started', { requestId, boundary });
  try {
    const result = await operation();
    console.info('Ready posts Notion boundary completed', {
      requestId,
      boundary,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    console.error('Ready posts Notion boundary failed', {
      requestId,
      boundary,
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function listReadyXhsPosts(
  { requestId = crypto.randomUUID() }: { requestId?: string } = {},
) {
  const client = getClient();
  const schema = await notionBoundary('schema', requestId, () => loadSchema(client));
  const { resolved, duplicateAliases, warnings, properties } = schema;
  const pages = await notionBoundary('query', requestId, () =>
    queryReadyCandidatePages(client, resolved, properties));
  const posts = pages.flatMap((page) => {
    const post = toReadyPostCandidate(page, resolved, duplicateAliases);
    return post ? [post] : [];
  });
  return { posts, warnings };
}

export async function getReadyXhsPost(pageId: string) {
  assertPageId(pageId);
  const client = getClient();
  const { resolved, duplicateAliases } = await loadSchema(client);
  const rawPage = await client.pages.retrieve({ page_id: pageId });
  if (!isFullPage(rawPage)) {
    throw new NotionPostsError('Notion returned a partial page', 'NOTION_PAGE_ERROR', 502);
  }
  assertPostsDatabaseParent(rawPage);
  const post = toReadyPostCandidate(rawPage, resolved, duplicateAliases);
  if (!post) {
    throw new NotionPostsError(
      'Post is no longer packet-ready or eligible for a MOV staging trial',
      'POST_NOT_READY',
      409,
    );
  }
  return post;
}

function richText(content: string) {
  return content.match(/[\s\S]{1,2000}/g)?.map((chunk) => ({
    type: 'text' as const,
    text: { content: chunk },
  })) ?? [];
}

function textUpdate(type: string, content: string) {
  if (type === 'title') return { title: richText(content) };
  if (type === 'rich_text') return { rich_text: richText(content) };
  if (type === 'url') return { url: content };
  if (type === 'select') return { select: { name: content } };
  if (type === 'status') return { status: { name: content } };
  throw new NotionPostsError(
    `Notion property type ${type} cannot store publish metadata`,
    'NOTION_SCHEMA_ERROR',
    503,
  );
}

function assertWritable(
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  key: CanonicalProperty,
  required: true,
  useResolvedAliasPrecedence?: boolean,
): string;
function assertWritable(
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  key: CanonicalProperty,
  required: false,
  useResolvedAliasPrecedence?: boolean,
): string | null;
function assertWritable(
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  key: CanonicalProperty,
  required: boolean,
  useResolvedAliasPrecedence = false,
) {
  const name = schema[key];
  if (!name) {
    if (!required) return null;
    throw new NotionPostsError(
      `Cannot backfill ${key}: no Notion property is mapped`,
      'NOTION_SCHEMA_ERROR',
      503,
    );
  }

  if (duplicates[key] && !useResolvedAliasPrecedence) {
    throw new NotionPostsError(
      `Cannot backfill ${key}: multiple aliases are present (${duplicates[key]?.join(', ')})`,
      'NOTION_SCHEMA_AMBIGUOUS',
      503,
    );
  }
  return name;
}

export function publishedNextAction(
  properties: PropertyMap,
  propertyName: string | null,
) {
  if (!propertyName || properties[propertyName]?.type !== 'select') return null;
  const options = properties[propertyName].select?.options.map((option) => option.name) ?? [];
  return options.find((option) => normalized(option) === 'backfill url/metrics') ??
    options.find((option) => normalized(option) === 'no action') ??
    null;
}

export function buildPublishedProperties(
  page: PageObjectResponse,
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  schemaProperties: PropertyMap,
  result: PublishReadyPostResponse,
  publishedAt: string,
) {
  const properties: PropertyUpdates = {};
  const statusName = assertWritable(schema, duplicates, 'status', true);
  const shareUrlName = assertWritable(schema, duplicates, 'xhsShareUrl', true);
  properties[statusName!] = textUpdate(page.properties[statusName!].type, 'Published');
  properties[shareUrlName!] = textUpdate(page.properties[shareUrlName!].type, result.shareUrl);

  const noteIdName = duplicates.xhsNoteId
    ? null
    : assertWritable(schema, duplicates, 'xhsNoteId', false);
  if (noteIdName) {
    properties[noteIdName] = textUpdate(page.properties[noteIdName].type, result.noteId);
  }
  const publishedAtName = duplicates.publishedAt
    ? null
    : assertWritable(schema, duplicates, 'publishedAt', false);
  if (publishedAtName) {
    const type = page.properties[publishedAtName].type;
    properties[publishedAtName] = type === 'date'
      ? { date: { start: publishedAt } }
      : textUpdate(type, publishedAt);
  }
  if (!duplicates.nextAction) {
    const nextActionName = schema.nextAction;
    const nextAction = publishedNextAction(schemaProperties, nextActionName);
    if (nextActionName && nextAction) {
      properties[nextActionName] = textUpdate(
        page.properties[nextActionName].type,
        nextAction,
      );
    }
  }
  return properties;
}

export function publishedResultState(
  page: PageObjectResponse,
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  result: PublishReadyPostResponse,
) {
  const status = normalized(plainText(property(page, schema, 'status')));
  if (status !== 'published') return 'unpublished' as const;

  const shareUrlMatches = plainText(property(page, schema, 'xhsShareUrl')) === result.shareUrl;
  const noteIdName = duplicates.xhsNoteId ? null : schema.xhsNoteId;
  const noteIdMatches = !noteIdName ||
    plainText(page.properties[noteIdName]).trim() === result.noteId;
  return shareUrlMatches && noteIdMatches ? 'match' as const : 'conflict' as const;
}

export async function markXhsPostPublished(
  pageId: string,
  result: PublishReadyPostResponse,
) {
  assertPageId(pageId);
  const client = getClient();
  const { resolved, duplicateAliases, properties: schemaProperties } = await loadSchema(client);
  const rawPage = await client.pages.retrieve({ page_id: pageId });
  if (!isFullPage(rawPage)) {
    throw new NotionPostsError('Notion returned a partial page', 'NOTION_PAGE_ERROR', 502);
  }
  assertPostsDatabaseParent(rawPage);

  const currentResult = publishedResultState(
    rawPage,
    resolved,
    duplicateAliases,
    result,
  );
  if (currentResult === 'match') return;
  if (currentResult === 'conflict') {
    throw new NotionPostsError(
      'The Notion post is already Published with different RedNote metadata',
      'NOTION_PUBLISH_CONFLICT',
      409,
    );
  }

  const properties = buildPublishedProperties(
    rawPage,
    resolved,
    duplicateAliases,
    schemaProperties,
    result,
    new Date().toISOString(),
  );

  await client.pages.update({ page_id: pageId, properties });
}

export function buildExternalPostQueryFilter(
  propertyName: string,
  propertyType: string,
  value: string,
): DatabaseFilter {
  if (propertyType === 'title') {
    return { property: propertyName, title: { equals: value } };
  }
  if (propertyType === 'rich_text') {
    return { property: propertyName, rich_text: { equals: value } };
  }
  if (propertyType === 'url') {
    return { property: propertyName, url: { equals: value } };
  }
  throw new NotionPostsError(
    `Notion property ${propertyName} cannot be queried exactly`,
    'NOTION_SCHEMA_ERROR',
    503,
  );
}

export function chooseExternalReconciliationTarget(
  noteMatches: PageObjectResponse[],
  urlMatches: PageObjectResponse[],
): { page: PageObjectResponse | null; outcome: ExternalReconciliationOutcome } {
  if (noteMatches.length > 1 || urlMatches.length > 1) {
    throw new NotionPostsError(
      'Multiple Notion posts match the verified RedNote identity',
      'NOTION_RECONCILIATION_AMBIGUOUS',
      409,
    );
  }
  const noteMatch = noteMatches[0];
  const urlMatch = urlMatches[0];
  if (noteMatch && urlMatch && noteMatch.id !== urlMatch.id) {
    throw new NotionPostsError(
      'RedNote note ID and URL match different Notion posts',
      'NOTION_RECONCILIATION_CONFLICT',
      409,
    );
  }
  if (noteMatch) return { page: noteMatch, outcome: 'matched_note_id' };
  if (urlMatch) return { page: urlMatch, outcome: 'matched_url' };
  return { page: null, outcome: 'created' };
}

function platformUpdate(type: string, current?: PageProperty) {
  if (type === 'multi_select') {
    const existing = current?.type === 'multi_select'
      ? current.multi_select.map((option) => ({ name: option.name }))
      : [];
    if (!existing.some((option) => normalized(option.name) === 'rednote')) {
      existing.push({ name: 'RedNote' });
    }
    return { multi_select: existing };
  }
  return textUpdate(type, 'RedNote');
}

function checkboxUpdate(type: string, value: boolean) {
  if (type !== 'checkbox') {
    throw new NotionPostsError(
      `Notion property type ${type} cannot store a reconciliation flag`,
      'NOTION_SCHEMA_ERROR',
      503,
    );
  }
  return { checkbox: value };
}

export function buildExternalPublishedProperties(
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  schemaProperties: PropertyMap,
  snapshot: ExternalPostSnapshot,
  reconciledAt: string,
  existingPage?: PageObjectResponse,
) {
  const properties: CreatePageParameters['properties'] = {};
  const requiredKeys = [
    'headline',
    'caption',
    'platform',
    'status',
    'hasVideo',
    'needsMedia',
    'needsCaption',
    'xhsNoteId',
    'xhsShareUrl',
    'nextAction',
  ] as const;
  const names = Object.fromEntries(requiredKeys.map((key) => [
    key,
    assertWritable(
      schema,
      duplicates,
      key,
      true,
      key === 'platform',
    ),
  ])) as Record<(typeof requiredKeys)[number], string>;

  const nextActionOptions = schemaProperties[names.nextAction]?.select?.options ?? [];
  const nextAction = nextActionOptions.find(
    (option) => normalized(option.name) === 'backfill url/metrics',
  )?.name;
  if (!nextAction) {
    throw new NotionPostsError(
      'Next action has no Backfill URL/metrics option',
      'NOTION_SCHEMA_ERROR',
      503,
    );
  }

  properties[names.headline] = textUpdate(
    schemaProperties[names.headline].type,
    snapshot.title,
  );
  properties[names.caption] = textUpdate(
    schemaProperties[names.caption].type,
    snapshot.caption,
  );
  properties[names.platform] = platformUpdate(
    schemaProperties[names.platform].type,
    existingPage?.properties[names.platform],
  );
  properties[names.status] = textUpdate(schemaProperties[names.status].type, 'Published');
  properties[names.hasVideo] = checkboxUpdate(
    schemaProperties[names.hasVideo].type,
    snapshot.mediaType === 'video',
  );
  properties[names.needsMedia] = checkboxUpdate(
    schemaProperties[names.needsMedia].type,
    false,
  );
  properties[names.needsCaption] = checkboxUpdate(
    schemaProperties[names.needsCaption].type,
    false,
  );
  properties[names.xhsNoteId] = textUpdate(
    schemaProperties[names.xhsNoteId].type,
    snapshot.noteId,
  );
  properties[names.xhsShareUrl] = textUpdate(
    schemaProperties[names.xhsShareUrl].type,
    snapshot.shareUrl,
  );
  properties[names.nextAction] = textUpdate(
    schemaProperties[names.nextAction].type,
    nextAction,
  );

  const packetReadyName = duplicates.publishPacketReady
    ? null
    : assertWritable(schema, duplicates, 'publishPacketReady', false);
  if (packetReadyName && schemaProperties[packetReadyName].type === 'checkbox') {
    properties[packetReadyName] = { checkbox: false };
  }
  const publishedAtName = duplicates.publishedAt
    ? null
    : assertWritable(schema, duplicates, 'publishedAt', false);
  if (publishedAtName) {
    const type = schemaProperties[publishedAtName].type;
    properties[publishedAtName] = type === 'date'
      ? { date: { start: reconciledAt } }
      : textUpdate(type, reconciledAt);
  }
  return properties;
}

function externalReconciliationNote(noteId: string) {
  return `Reconciled externally from verified RedNote post ${noteId}. ` +
    'No canonical MEDIA URL was added.';
}

function reconciliationNoteChildren(note: string): NonNullable<CreatePageParameters['children']> {
  return [{
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: richText(note) },
  }];
}

async function queryExactPosts(
  client: Client,
  propertyName: string,
  propertyType: string,
  value: string,
) {
  const results = await collectPaginatedAPI(client.databases.query, {
    database_id: getDatabaseId(),
    page_size: 100,
    filter: buildExternalPostQueryFilter(propertyName, propertyType, value),
  });
  return results.filter(isFullPage);
}

async function ensureExternalReconciliationNote(
  client: Client,
  pageId: string,
  note: string,
) {
  const blocks = await collectPaginatedAPI(client.blocks.children.list, {
    block_id: pageId,
    page_size: 100,
  });
  const exists = blocks.some((block) =>
    isFullBlock(block) &&
    block.type === 'paragraph' &&
    block.paragraph.rich_text.map((item) => item.plain_text).join('') === note);
  if (exists) return;
  await client.blocks.children.append({
    block_id: pageId,
    children: reconciliationNoteChildren(note),
  });
}

export async function reconcileExternalXhsPost(
  snapshot: ExternalPostSnapshot,
  reconciledAt: string,
  targetPageId?: string,
) {
  const client = getClient();
  const { resolved, duplicateAliases, properties: schemaProperties } =
    await loadSchema(client);
  const noteIdName = assertWritable(
    resolved,
    duplicateAliases,
    'xhsNoteId',
    true,
  );
  const shareUrlName = assertWritable(
    resolved,
    duplicateAliases,
    'xhsShareUrl',
    true,
  );
  const [noteMatches, urlMatches] = await Promise.all([
    queryExactPosts(
      client,
      noteIdName,
      schemaProperties[noteIdName].type,
      snapshot.noteId,
    ),
    queryExactPosts(
      client,
      shareUrlName,
      schemaProperties[shareUrlName].type,
      snapshot.shareUrl,
    ),
  ]);
  if (targetPageId) {
    assertPageId(targetPageId);
    const rawTarget = await client.pages.retrieve({ page_id: targetPageId });
    if (!isFullPage(rawTarget)) {
      throw new NotionPostsError(
        'Notion returned a partial reconciliation target',
        'NOTION_PAGE_ERROR',
        502,
      );
    }
    assertPostsDatabaseParent(rawTarget);
    const conflictingMatch = [...noteMatches, ...urlMatches].find(
      (page) => page.id !== rawTarget.id,
    );
    if (conflictingMatch) {
      throw new NotionPostsError(
        'The verified RedNote identity belongs to another canonical post',
        'NOTION_RECONCILIATION_CONFLICT',
        409,
      );
    }
    const result = { status: 'success' as const, noteId: snapshot.noteId, shareUrl: snapshot.shareUrl };
    const currentResult = publishedResultState(
      rawTarget,
      resolved,
      duplicateAliases,
      result,
    );
    if (currentResult === 'conflict') {
      throw new NotionPostsError(
        'The canonical post is already Published with different RedNote metadata',
        'NOTION_PUBLISH_CONFLICT',
        409,
      );
    }
    const note = externalReconciliationNote(snapshot.noteId);
    if (currentResult === 'match') {
      await ensureExternalReconciliationNote(client, rawTarget.id, note);
      return {
        notionPageId: rawTarget.id,
        outcome: 'targeted_page' as const,
      };
    }
    if (!isReadyRednotePost(rawTarget, resolved)) {
      throw new NotionPostsError(
        'The canonical post changed and is no longer eligible for manual reconciliation',
        'NOTION_RECONCILIATION_TARGET_CHANGED',
        409,
      );
    }
    const current = mapReadyXhsPost(rawTarget, resolved, duplicateAliases);
    const currentMediaType = current.hasVideo ? 'video' : 'image';
    if (
      current.headline.trim() !== snapshot.title ||
      current.caption !== snapshot.caption ||
      currentMediaType !== snapshot.mediaType
    ) {
      throw new NotionPostsError(
        'The canonical post metadata changed after reconciliation was requested',
        'NOTION_RECONCILIATION_TARGET_CHANGED',
        409,
      );
    }
    const properties = buildExternalPublishedProperties(
      resolved,
      duplicateAliases,
      schemaProperties,
      snapshot,
      reconciledAt,
      rawTarget,
    );
    await client.pages.update({ page_id: rawTarget.id, properties });
    await ensureExternalReconciliationNote(client, rawTarget.id, note);
    return {
      notionPageId: rawTarget.id,
      outcome: 'targeted_page' as const,
    };
  }
  const target = chooseExternalReconciliationTarget(noteMatches, urlMatches);
  const properties = buildExternalPublishedProperties(
    resolved,
    duplicateAliases,
    schemaProperties,
    snapshot,
    reconciledAt,
    target.page ?? undefined,
  );
  const note = externalReconciliationNote(snapshot.noteId);

  if (target.page) {
    await client.pages.update({ page_id: target.page.id, properties });
    await ensureExternalReconciliationNote(client, target.page.id, note);
    return { notionPageId: target.page.id, outcome: target.outcome };
  }

  const created = await client.pages.create({
    parent: { database_id: getDatabaseId() },
    properties,
    children: reconciliationNoteChildren(note),
  });
  if (!isFullPage(created)) {
    throw new NotionPostsError(
      'Notion returned a partial page after reconciliation',
      'NOTION_PAGE_ERROR',
      502,
    );
  }
  return { notionPageId: created.id, outcome: target.outcome };
}

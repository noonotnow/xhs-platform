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
import type { PublishReadyPostResponse, ReadyXhsPost } from '@/types/ready-post';
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
  tags: ['Tags', 'Topics', 'Hashtags'],
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
  scheduledDate: ['Scheduled date', 'Scheduled Date', 'Publish date', 'Publish Date'],
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
) {
  const blockers: string[] = [];
  for (const key of ['status', 'xhsShareUrl'] as const) {
    if (!schema[key]) blockers.push(`Posts DB has no mapped ${key} property`);
    if (duplicates[key]) blockers.push(`${key} has multiple aliases in the Posts DB`);
  }
  if (!plainText(property(page, schema, 'headline')).trim()) blockers.push('Headline is empty');
  if (!plainText(property(page, schema, 'caption')).trim()) blockers.push('Weibo text is empty');
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
): ReadyXhsPost {
  const mediaUrls = urls(property(page, schema, 'mediaUrls'));
  return {
    id: page.id,
    pageUrl: page.url,
    headline: plainText(property(page, schema, 'headline')),
    caption: plainText(property(page, schema, 'caption')),
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
    tags: values(property(page, schema, 'tags')),
    scheduledDate: date(property(page, schema, 'scheduledDate')) || undefined,
    lastEditedTime: page.last_edited_time,
    publishBlockers: mappedBlockers(page, schema, duplicates),
  };
}

function isReadyRednotePost(page: PageObjectResponse, schema: ResolvedSchema) {
  const platforms = values(property(page, schema, 'platform')).map(normalized);
  const isRednote = platforms.some((platform) =>
    platform === 'xhs' ||
    platform.includes('rednote') ||
    platform.includes('xiaohongshu') ||
    platform.includes('小红书'),
  );
  return isRednote &&
    checkbox(property(page, schema, 'publishPacketReady')) &&
    normalized(plainText(property(page, schema, 'status'))) !== 'published';
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

export function buildReadyPostsQueryFilter(
  propertyName: string | null,
  propertyType: string | undefined,
): DatabaseFilter | undefined {
  return propertyName && propertyType === 'checkbox'
    ? { property: propertyName, checkbox: { equals: true } }
    : undefined;
}

async function queryReadyCandidatePages(
  client: Client,
  schema: ResolvedSchema,
  properties: PropertyMap,
) {
  const filter = buildReadyPostsQueryFilter(
    schema.publishPacketReady,
    schema.publishPacketReady
      ? properties[schema.publishPacketReady]?.type
      : undefined,
  );
  const response: QueryDatabaseResponse = await client.databases.query({
    database_id: getDatabaseId(),
    page_size: 100,
    sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    ...(filter ? { filter } : {}),
  });
  if (response.has_more) {
    throw new NotionPostsError(
      'More than 100 publish-ready posts were found; reduce the ready queue before retrying',
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
  const posts = pages
    .filter((page) => isReadyRednotePost(page, resolved))
    .map((page) => mapReadyXhsPost(page, resolved, duplicateAliases));
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
  if (!isReadyRednotePost(rawPage, resolved)) {
    throw new NotionPostsError(
      'Post is no longer ready for Rednote publishing',
      'POST_NOT_READY',
      409,
    );
  }
  return mapReadyXhsPost(rawPage, resolved, duplicateAliases);
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
): string;
function assertWritable(
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  key: CanonicalProperty,
  required: false,
): string | null;
function assertWritable(
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  key: CanonicalProperty,
  required: boolean,
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

  if (duplicates[key]) {
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
    assertWritable(schema, duplicates, key, true),
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

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
import {
  canonicalEditorialInstant,
  compareReadyPostsBySchedule,
} from '@/lib/editorial-schedule';
import { isMovCompatibilityTrialEligible } from '@/lib/mov-compatibility-trial';
import {
  isRednoteNoteId,
  normalizeRednoteShareUrl,
} from '@/lib/rednote-publication';
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
  status?: { options: Array<{ name: string }> };
}>;
type PageProperty = PageObjectResponse['properties'][string];
type PropertyUpdates = UpdatePageParameters['properties'];
type DatabaseFilter = NonNullable<QueryDatabaseParameters['filter']>;

const NOTION_TIMEOUT_MS = 10_000;

const PROPERTY_ALIASES = {
  headline: ['Headline', 'Name', 'Title'],
  platform: ['Platform', 'Platforms'],
  status: ['Status'],
  productionNextStep: ['Production Next Step'],
  publicationStatus: ['Publication Status'],
  publicationNextStep: ['Publication Next Step'],
  thumbnail: ['Thumbnail', 'Thumbnail URL'],
  mediaUrls: ['Image URLs', 'Image URL', 'Images'],
  caption: ['Caption', 'Caption text', 'Weibo text', 'Weibo Text', 'Weibo'],
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

export function canonicalPublishAt(value: string) {
  return canonicalEditorialInstant(value);
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
  scheduledDate: string,
  publishPacketReady: boolean,
) {
  const blockers: string[] = [];
  for (const key of ['status', 'xhsShareUrl'] as const) {
    if (!schema[key]) blockers.push(`Posts DB has no mapped ${key} property`);
    if (duplicates[key]) blockers.push(`${key} has multiple aliases in the Posts DB`);
  }
  if (!plainText(property(page, schema, 'headline')).trim()) blockers.push('Headline is empty');
  if (!caption) blockers.push('Caption is empty');
  if (!scheduledDate) {
    blockers.push('ScheduledDate is missing');
  } else if (!canonicalPublishAt(scheduledDate)) {
    blockers.push('ScheduledDate must include a valid publish time and timezone');
  }
  if (!publishPacketReady) blockers.push('Publish packet is not ready');
  if (checkbox(property(page, schema, 'needsMedia'))) blockers.push('Needs media is still checked');
  if (checkbox(property(page, schema, 'needsCaption'))) blockers.push('Needs caption is still checked');
  const mediaUrls = urls(property(page, schema, 'mediaUrls'));
  const hasCanonicalPrimaryMedia = schema.hasVideo
    ? checkbox(property(page, schema, 'hasVideo'))
      ? mediaUrls.some(isCanonicalMediaVideo)
      : mediaUrls.some(isCanonicalMediaImage)
    : mediaUrls.some((url) => isCanonicalMediaVideo(url) || isCanonicalMediaImage(url));
  if (!hasCanonicalPrimaryMedia) {
    blockers.push('No canonical HTTPS Rednote media is attached');
  }
  if (mediaUrls.some(isCanonicalMediaMov)) {
    blockers.push('MOV media requires the CapCut compatibility workflow');
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
  const publishPacketReady = checkbox(property(page, schema, 'publishPacketReady'));
  const tags = finalTags.length > 0 ? finalTags : legacyCopy.tags;
  const tagsSource = finalTags.length > 0
    ? 'final-tags' as const
    : 'legacy-caption' as const;
  const automationBlockers = mappedBlockers(
    page,
    schema,
    duplicates,
    legacyCopy.caption,
    scheduledDate,
    publishPacketReady,
  );
  const thumbnailUrl = urls(property(page, schema, 'thumbnail'))[0] ?? '';
  const manualWarnings = [...automationBlockers];
  if (!thumbnailUrl) manualWarnings.push('Cover thumbnail is missing');
  return {
    id: page.id,
    pageUrl: page.url,
    headline: plainText(property(page, schema, 'headline')),
    caption: legacyCopy.caption,
    status: plainText(property(page, schema, 'status')),
    productionNextStep: plainText(property(page, schema, 'productionNextStep')),
    publicationStatus: plainText(property(page, schema, 'publicationStatus')),
    publicationNextStep: plainText(property(page, schema, 'publicationNextStep')),
    publishPacketReady,
    hasVideo: checkbox(property(page, schema, 'hasVideo')),
    needsMedia: checkbox(property(page, schema, 'needsMedia')),
    needsCaption: checkbox(property(page, schema, 'needsCaption')),
    mediaUrls,
    imageUrls: mediaUrls.filter(isCanonicalMediaImage),
    videoUrls: mediaUrls.filter(isCanonicalMediaVideo),
    compatibilityTrialVideoUrls: mediaUrls.filter(isCanonicalMediaMov),
    thumbnailUrl,
    tags,
    tagsSource,
    scheduledDate: scheduledDate || null,
    ...(publishAt ? { publishAt } : {}),
    lastEditedTime: page.last_edited_time,
    automationBlockers,
    manualWarnings,
    publishBlockers: automationBlockers,
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
  const publicationStatus = normalized(
    plainText(property(page, schema, 'publicationStatus')),
  );
  const legacyStatus = normalized(plainText(property(page, schema, 'status')));
  const isPublished = publicationStatus
    ? publicationStatus === 'published'
    : legacyStatus === 'published';
  return isRednote && !isPublished;
}

export function classifyReadyPostCandidate(post: XhsPost): ReadyPostCandidateKind {
  if (post.publishPacketReady) return 'packet_ready';
  if (isMovCompatibilityTrialEligible(post)) return 'mov_compatibility_trial';
  return 'active_unpublished';
}

export function toReadyPostCandidate(
  page: PageObjectResponse,
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  includePublished = false,
): ReadyXhsPost | null {
  const publicationStatus = normalized(
    plainText(property(page, schema, 'publicationStatus')),
  );
  const isPublished = publicationStatus
    ? publicationStatus === 'published'
    : normalized(plainText(property(page, schema, 'status'))) === 'published';
  if (
    !isUnpublishedRednotePost(page, schema) &&
    !(includePublished && isPublished && values(property(page, schema, 'platform'))
      .map(normalized)
      .some((platform) =>
        platform === 'xhs' ||
        platform.includes('rednote') ||
        platform.includes('xiaohongshu') ||
        platform.includes('小红书')))
  ) {
    return null;
  }
  const post = mapReadyXhsPost(page, schema, duplicates);
  const candidateKind = classifyReadyPostCandidate(post);
  if (
    candidateKind === 'mov_compatibility_trial' &&
    (!schema.publishPacketReady || duplicates.publishPacketReady)
  ) {
    return { ...post, candidateKind: 'active_unpublished' };
  }
  return { ...post, candidateKind };
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
  includePublishedCandidates = false,
) {
  const platformName = schema.platform;
  const platformType = platformName ? properties[platformName]?.type : undefined;
  // Scope to Rednote posts only — this is the XHS admin panel.
  const platformFilter: DatabaseFilter | undefined =
    platformName && platformType === 'select'
      ? { property: platformName, select: { equals: 'Rednote' } }
      : platformName && platformType === 'multi_select'
        ? { property: platformName, multi_select: { contains: 'Rednote' } }
        : undefined;

  const publicationStatusName = schema.publicationStatus ?? schema.status;
  const publicationStatusType = publicationStatusName
    ? properties[publicationStatusName]?.type
    : undefined;
  const unpublishedFilter: DatabaseFilter | undefined =
    publicationStatusName && publicationStatusType === 'status'
    ? { property: publicationStatusName, status: { does_not_equal: 'Published' } }
    : publicationStatusName && publicationStatusType === 'select'
      ? { property: publicationStatusName, select: { does_not_equal: 'Published' } }
      : undefined;
  const supportsServerCandidateFilter =
    schema.publishPacketReady &&
    properties[schema.publishPacketReady]?.type === 'checkbox' &&
    schema.mediaUrls &&
    properties[schema.mediaUrls]?.type === 'rich_text';
  const filter: DatabaseFilter | undefined =
    includePublishedCandidates &&
      publicationStatusName &&
      publicationStatusType === 'status' &&
      supportsServerCandidateFilter
      ? {
          or: [
            {
              property: publicationStatusName,
              status: { does_not_equal: 'Published' },
            },
            {
              and: [
                { property: publicationStatusName, status: { equals: 'Published' } },
                {
                  property: schema.publishPacketReady!,
                  checkbox: { equals: true },
                },
              ],
            },
            {
              and: [
                { property: publicationStatusName, status: { equals: 'Published' } },
                {
                  property: schema.mediaUrls!,
                  rich_text: { contains: '.mov' },
                },
              ],
            },
          ],
        }
      : includePublishedCandidates &&
          publicationStatusName &&
          publicationStatusType === 'select' &&
          supportsServerCandidateFilter
        ? {
            or: [
              {
                property: publicationStatusName,
                select: { does_not_equal: 'Published' },
              },
              {
                and: [
                  { property: publicationStatusName, select: { equals: 'Published' } },
                  {
                    property: schema.publishPacketReady!,
                    checkbox: { equals: true },
                  },
                ],
              },
              {
                and: [
                  { property: publicationStatusName, select: { equals: 'Published' } },
                  {
                    property: schema.mediaUrls!,
                    rich_text: { contains: '.mov' },
                  },
                ],
              },
            ],
          }
        : includePublishedCandidates
          ? undefined
          : unpublishedFilter;
  // Combine the publication-status filter with the platform filter.
  const combinedFilter: DatabaseFilter | undefined =
    filter && platformFilter
      ? { and: [platformFilter, filter] }
      : (filter ?? platformFilter);

  // Paginate until all results are fetched. A safety cap prevents runaway
  // queries if the database grows very large.
  const PAGE_CAP = 500;
  const allResults: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const response: QueryDatabaseResponse = await client.databases.query({
      database_id: databaseId,
      page_size: 100,
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      ...(combinedFilter ? { filter: combinedFilter } : {}),
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    const page = response.results.filter(isFullPage);
    allResults.push(...page);
    cursor = response.has_more && response.next_cursor
      ? response.next_cursor
      : undefined;
  } while (cursor && allResults.length < PAGE_CAP);
  if (allResults.length >= PAGE_CAP) {
    throw new NotionPostsError(
      `More than ${PAGE_CAP} active Posts records were found; reduce or archive the database before retrying`,
      'READY_POSTS_LIMIT_EXCEEDED',
      503,
    );
  }
  return allResults;
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
  {
    requestId = crypto.randomUUID(),
    includePublishedCandidates = false,
  }: {
    requestId?: string;
    includePublishedCandidates?: boolean;
  } = {},
) {
  const client = getClient();
  const schema = await notionBoundary('schema', requestId, () => loadSchema(client));
  const { resolved, duplicateAliases, warnings, properties } = schema;
  const pages = await notionBoundary('query', requestId, () =>
    queryReadyCandidatePages(
      client,
      resolved,
      properties,
      getDatabaseId(),
      includePublishedCandidates,
    ));
  const posts = pages.flatMap((page) => {
    const post = toReadyPostCandidate(
      page,
      resolved,
      duplicateAliases,
      includePublishedCandidates,
    );
    return post ? [post] : [];
  }).sort(compareReadyPostsBySchedule);
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

export async function getXhsPostForManualHandling(pageId: string) {
  assertPageId(pageId);
  const client = getClient();
  const { resolved, duplicateAliases } = await loadSchema(client);
  const rawPage = await client.pages.retrieve({ page_id: pageId });
  if (!isFullPage(rawPage)) {
    throw new NotionPostsError('Notion returned a partial page', 'NOTION_PAGE_ERROR', 502);
  }
  assertPostsDatabaseParent(rawPage);
  const post = toReadyPostCandidate(rawPage, resolved, duplicateAliases, true);
  if (!post) {
    throw new NotionPostsError(
      'Post is not a canonical RedNote record',
      'POST_NOT_FOUND',
      404,
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

function requiredPublicationOption(
  properties: PropertyMap,
  propertyName: string,
  expected: string,
) {
  const property = properties[propertyName];
  const options = property?.type === 'status'
    ? property.status?.options
    : property?.select?.options;
  const option = options?.find(
    (candidate) => normalized(candidate.name) === normalized(expected),
  )?.name;
  if (!option) {
    throw new NotionPostsError(
      `${propertyName} has no ${expected} option`,
      'NOTION_SCHEMA_ERROR',
      503,
    );
  }
  return option;
}

function buildVerifiedPublicationProperties(
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  schemaProperties: PropertyMap,
  result: Pick<PublishReadyPostResponse, 'noteId' | 'shareUrl'>,
  publishedAt: string,
) {
  const shareUrl = normalizeRednoteShareUrl(result.noteId, result.shareUrl);
  if (!isRednoteNoteId(result.noteId) || !shareUrl) {
    throw new NotionPostsError(
      'The publication result does not contain both stable RedNote identifiers',
      'INVALID_SUCCESS_RESULT',
      400,
    );
  }
  const publicationStatusName = assertWritable(
    schema,
    duplicates,
    'publicationStatus',
    true,
  );
  const publicationNextStepName = assertWritable(
    schema,
    duplicates,
    'publicationNextStep',
    true,
  );
  const noteIdName = assertWritable(schema, duplicates, 'xhsNoteId', true);
  const shareUrlName = assertWritable(schema, duplicates, 'xhsShareUrl', true);
  const properties: PropertyUpdates = {
    [publicationStatusName]: textUpdate(
      schemaProperties[publicationStatusName].type,
      requiredPublicationOption(
        schemaProperties,
        publicationStatusName,
        'Published',
      ),
    ),
    [publicationNextStepName]: textUpdate(
      schemaProperties[publicationNextStepName].type,
      requiredPublicationOption(
        schemaProperties,
        publicationNextStepName,
        'Backfill metrics',
      ),
    ),
    [noteIdName]: textUpdate(
      schemaProperties[noteIdName].type,
      result.noteId,
    ),
    [shareUrlName]: textUpdate(
      schemaProperties[shareUrlName].type,
      shareUrl,
    ),
  };
  const publishedAtName = assertWritable(
    schema,
    duplicates,
    'publishedAt',
    false,
  );
  if (publishedAtName) {
    const type = schemaProperties[publishedAtName].type;
    properties[publishedAtName] = type === 'date'
      ? { date: { start: publishedAt } }
      : textUpdate(type, publishedAt);
  }
  return properties;
}

export function buildPublishedProperties(
  page: PageObjectResponse,
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  schemaProperties: PropertyMap,
  result: PublishReadyPostResponse,
  publishedAt: string,
) {
  void page;
  return buildVerifiedPublicationProperties(
    schema,
    duplicates,
    schemaProperties,
    result,
    publishedAt,
  );
}

export function publishedResultState(
  page: PageObjectResponse,
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  result: PublishReadyPostResponse,
) {
  const shareUrl = normalizeRednoteShareUrl(result.noteId, result.shareUrl);
  if (!shareUrl) return 'conflict' as const;
  const storedShareUrl = plainText(property(page, schema, 'xhsShareUrl'));
  const normalizedStoredShareUrl = normalizeRednoteShareUrl(
    result.noteId,
    storedShareUrl,
  );
  const noteIdName = duplicates.xhsNoteId ? null : schema.xhsNoteId;
  const storedNoteId = noteIdName
    ? plainText(page.properties[noteIdName]).trim()
    : '';
  if (
    (storedShareUrl && normalizedStoredShareUrl !== shareUrl) ||
    (storedNoteId && storedNoteId !== result.noteId)
  ) {
    return 'conflict' as const;
  }
  if (!storedShareUrl || !storedNoteId) return 'unpublished' as const;
  const status = normalized(
    plainText(property(page, schema, 'publicationStatus')),
  );
  const publishedAtMatches = !schema.publishedAt ||
    Boolean(
      date(property(page, schema, 'publishedAt')) ||
      plainText(property(page, schema, 'publishedAt')).trim(),
    );
  const nextStep = normalized(
    plainText(property(page, schema, 'publicationNextStep')),
  );
  const canonicalUrlMatches = storedShareUrl === shareUrl;
  return canonicalUrlMatches &&
      status === 'published' &&
      nextStep === 'backfill metrics' &&
      publishedAtMatches
    ? 'match' as const
    : 'unpublished' as const;
}

export function buildPublicationAwaitingReceiptProperties(
  page: PageObjectResponse,
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  schemaProperties: PropertyMap,
) {
  const storedShareUrl = plainText(property(page, schema, 'xhsShareUrl')).trim();
  const storedNoteId = plainText(property(page, schema, 'xhsNoteId')).trim();
  if (Boolean(storedShareUrl) !== Boolean(storedNoteId)) {
    throw new NotionPostsError(
      'The canonical post has a partial RedNote identity and requires operator reconciliation',
      'NOTION_PUBLISH_CONFLICT',
      409,
    );
  }
  if (storedShareUrl && storedNoteId) {
    const status = normalized(
      plainText(property(page, schema, 'publicationStatus')),
    );
    const nextStep = normalized(
      plainText(property(page, schema, 'publicationNextStep')),
    );
    if (status === 'published' && nextStep === 'backfill metrics') {
      return {};
    }
    throw new NotionPostsError(
      'The canonical post already has a complete RedNote identity and requires receipt reconciliation',
      'NOTION_PUBLISH_CONFLICT',
      409,
    );
  }
  if (
    normalized(plainText(property(page, schema, 'publicationStatus'))) ===
      'published'
  ) {
    throw new NotionPostsError(
      'Publication Status cannot be Published without both stable RedNote identifiers',
      'NOTION_PUBLISH_CONFLICT',
      409,
    );
  }
  const publicationStatusName = assertWritable(
    schema,
    duplicates,
    'publicationStatus',
    true,
  );
  const publicationNextStepName = assertWritable(
    schema,
    duplicates,
    'publicationNextStep',
    true,
  );
  return {
    [publicationStatusName]: textUpdate(
      schemaProperties[publicationStatusName].type,
      requiredPublicationOption(
        schemaProperties,
        publicationStatusName,
        'Verify receipt',
      ),
    ),
    [publicationNextStepName]: textUpdate(
      schemaProperties[publicationNextStepName].type,
      requiredPublicationOption(
        schemaProperties,
        publicationNextStepName,
        'Verify receipt',
      ),
    ),
  };
}

export async function markXhsPostAwaitingReceipt(pageId: string) {
  assertPageId(pageId);
  const client = getClient();
  const { resolved, duplicateAliases, properties: schemaProperties } =
    await loadSchema(client);
  const rawPage = await client.pages.retrieve({ page_id: pageId });
  if (!isFullPage(rawPage)) {
    throw new NotionPostsError('Notion returned a partial page', 'NOTION_PAGE_ERROR', 502);
  }
  assertPostsDatabaseParent(rawPage);
  const properties = buildPublicationAwaitingReceiptProperties(
    rawPage,
    resolved,
    duplicateAliases,
    schemaProperties,
  );
  if (Object.keys(properties).length > 0) {
    await client.pages.update({ page_id: pageId, properties });
  }
}

export async function markXhsPostPublished(
  pageId: string,
  result: PublishReadyPostResponse,
  publishedAt = new Date().toISOString(),
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
    publishedAt,
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

export function buildExternalPublishedProperties(
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  schemaProperties: PropertyMap,
  snapshot: ExternalPostSnapshot,
  reconciledAt: string,
  existingPage?: PageObjectResponse,
) {
  void existingPage;
  return buildVerifiedPublicationProperties(
    schema,
    duplicates,
    schemaProperties,
    snapshot,
    reconciledAt,
  ) as CreatePageParameters['properties'];
}

export function buildManualPublishedProperties(
  schema: ResolvedSchema,
  duplicates: Partial<Record<CanonicalProperty, string[]>>,
  schemaProperties: PropertyMap,
  snapshot: ExternalPostSnapshot,
  reconciledAt: string,
  existingPage: PageObjectResponse,
) {
  void existingPage;
  return buildVerifiedPublicationProperties(
    schema,
    duplicates,
    schemaProperties,
    snapshot,
    reconciledAt,
  ) as CreatePageParameters['properties'];
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
  manualHandling?: Record<string, never>,
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
    const properties = manualHandling
      ? buildManualPublishedProperties(
          resolved,
          duplicateAliases,
          schemaProperties,
          snapshot,
          reconciledAt,
          rawTarget,
        )
      : buildExternalPublishedProperties(
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
  if (!target.page) {
    throw new NotionPostsError(
      'A verified receipt cannot create or select a CREATE-owned Posts record',
      'NOTION_RECONCILIATION_TARGET_REQUIRED',
      409,
    );
  }
  const properties = buildExternalPublishedProperties(
    resolved,
    duplicateAliases,
    schemaProperties,
    snapshot,
    reconciledAt,
    target.page,
  );
  const note = externalReconciliationNote(snapshot.noteId);

  await client.pages.update({ page_id: target.page.id, properties });
  await ensureExternalReconciliationNote(client, target.page.id, note);
  return { notionPageId: target.page.id, outcome: target.outcome };
}

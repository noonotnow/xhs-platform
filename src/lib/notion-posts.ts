import { Client, isFullDatabase, isFullPage } from '@notionhq/client';
import type {
  PageObjectResponse,
  QueryDatabaseResponse,
  UpdatePageParameters,
} from '@notionhq/client/build/src/api-endpoints';
import type { PublishReadyPostResponse, ReadyXhsPost } from '@/types/ready-post';

type PropertyMap = Record<string, {
  type: string;
  select?: { options: Array<{ name: string }> };
}>;
type PageProperty = PageObjectResponse['properties'][string];
type PropertyUpdates = UpdatePageParameters['properties'];

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
} as const;

type CanonicalProperty = keyof typeof PROPERTY_ALIASES;
type ResolvedSchema = Record<CanonicalProperty, string | null>;

export class NotionPostsError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 500,
  ) {
    super(message);
  }
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
  return new Client({ auth });
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

function isImageUrl(url: string) {
  try {
    return /\.(?:jpe?g|png|webp)$/i.test(new URL(url).pathname);
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
  if (!checkbox(property(page, schema, 'hasVideo'))) blockers.push('Has video is not checked');
  if (checkbox(property(page, schema, 'needsMedia'))) blockers.push('Needs media is still checked');
  if (checkbox(property(page, schema, 'needsCaption'))) blockers.push('Needs caption is still checked');
  if (!urls(property(page, schema, 'mediaUrls')).some(isCanonicalMediaVideo)) {
    blockers.push('No canonical MEDIA MP4 is attached');
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
    imageUrls: mediaUrls.filter(isImageUrl),
    videoUrls: mediaUrls.filter((url) => {
      try {
        return /\.(?:mp4|mov|webm)$/i.test(new URL(url).pathname);
      } catch {
        return false;
      }
    }),
    thumbnailUrl: urls(property(page, schema, 'thumbnail'))[0] ?? '',
    tags: values(property(page, schema, 'tags')),
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

async function queryAllPages(client: Client) {
  const pages: PageObjectResponse[] = [];
  let cursor: string | undefined;
  do {
    const response: QueryDatabaseResponse = await client.databases.query({
      database_id: getDatabaseId(),
      page_size: 100,
      start_cursor: cursor,
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
    });
    pages.push(...response.results.filter(isFullPage));
    cursor = response.has_more ? response.next_cursor ?? undefined : undefined;
  } while (cursor);
  return pages;
}

export async function listReadyXhsPosts() {
  const client = getClient();
  const { resolved, duplicateAliases, warnings } = await loadSchema(client);
  const posts = (await queryAllPages(client))
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

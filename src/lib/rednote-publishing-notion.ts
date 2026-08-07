import {
  APIErrorCode,
  Client,
  isFullDatabase,
  isFullPage,
  isNotionClientError,
} from '@notionhq/client';
import type {
  PageObjectResponse,
  UpdatePageParameters,
} from '@notionhq/client/build/src/api-endpoints';
import {
  REDNOTE_CANONICAL_PROPERTIES,
  REDNOTE_NEXT_ACTIONS,
  REDNOTE_POST_STATUSES,
  REDNOTE_PUBLISH_EXECUTIONS,
  type RednoteNextAction,
  type RednotePostStatus,
  type RednotePublishExecution,
} from '@/lib/rednote-publishing-contract-v1';
import { normalizeNotionPageId } from '@/lib/rednote-publishing-input';
import type {
  ObservedRednotePostExecution,
  RednotePostMutationView,
} from '@/lib/rednote-publishing-store';

type PropertyUpdates = UpdatePageParameters['properties'];
type PageProperty = PageObjectResponse['properties'][string];
type CanonicalKey = keyof typeof REDNOTE_CANONICAL_PROPERTIES;

const NOTION_TIMEOUT_MS = 10_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RednotePostsSchema {
  properties: Record<CanonicalKey, {
    name: string;
    type: string;
  }>;
  packetAuthorized: {
    name: 'Publish packet ready';
    type: string;
  };
}

export class RednotePostProjectionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 503,
  ) {
    super(message);
  }
}

function getClient() {
  const auth = process.env.NOTION_API_KEY?.trim();
  if (!auth) {
    throw new RednotePostProjectionError(
      'NOTION_API_KEY is not configured',
      'REDNOTE_NOTION_NOT_CONFIGURED',
    );
  }
  return new Client({ auth, timeoutMs: NOTION_TIMEOUT_MS });
}

function getDatabaseId() {
  const databaseId = process.env.NOTION_POSTS_DB_ID?.trim();
  if (!databaseId) {
    throw new RednotePostProjectionError(
      'NOTION_POSTS_DB_ID is not configured',
      'REDNOTE_NOTION_NOT_CONFIGURED',
    );
  }
  return databaseId;
}

function projectionError(error: unknown) {
  if (error instanceof RednotePostProjectionError) return error;
  if (
    isNotionClientError(error) &&
    (
      error.code === APIErrorCode.ObjectNotFound ||
      error.code === APIErrorCode.RestrictedResource ||
      error.code === APIErrorCode.Unauthorized
    )
  ) {
    return new RednotePostProjectionError(
      'The Notion integration cannot access the canonical Posts database',
      'REDNOTE_NOTION_UNAVAILABLE',
    );
  }
  return new RednotePostProjectionError(
    'The canonical Posts projection is unavailable',
    'REDNOTE_NOTION_UNAVAILABLE',
  );
}

function assertProperty(
  properties: Record<string, { type: string }>,
  name: string,
  allowedTypes: readonly string[],
) {
  const descriptor = properties[name];
  if (!descriptor || !allowedTypes.includes(descriptor.type)) {
    throw new RednotePostProjectionError(
      `Canonical Posts property ${name} must be ${allowedTypes.join(' or ')}`,
      'REDNOTE_NOTION_SCHEMA_INVALID',
    );
  }
  return { name, type: descriptor.type };
}

export function resolveRednotePostsSchema(
  properties: Record<string, { type: string }>,
): RednotePostsSchema {
  return {
    properties: {
      status: assertProperty(
        properties,
        REDNOTE_CANONICAL_PROPERTIES.status,
        ['status', 'select'],
      ),
      nextAction: assertProperty(
        properties,
        REDNOTE_CANONICAL_PROPERTIES.nextAction,
        ['select', 'status'],
      ),
      publishExecution: assertProperty(
        properties,
        REDNOTE_CANONICAL_PROPERTIES.publishExecution,
        ['select', 'status'],
      ),
      activeAttemptId: assertProperty(
        properties,
        REDNOTE_CANONICAL_PROPERTIES.activeAttemptId,
        ['rich_text'],
      ),
      scheduledDate: assertProperty(
        properties,
        REDNOTE_CANONICAL_PROPERTIES.scheduledDate,
        ['date'],
      ),
      platformPublishTime: assertProperty(
        properties,
        REDNOTE_CANONICAL_PROPERTIES.platformPublishTime,
        ['date'],
      ),
      rednoteUrl: assertProperty(
        properties,
        REDNOTE_CANONICAL_PROPERTIES.rednoteUrl,
        ['url'],
      ),
      rednoteNoteId: assertProperty(
        properties,
        REDNOTE_CANONICAL_PROPERTIES.rednoteNoteId,
        ['rich_text'],
      ),
    },
    packetAuthorized: {
      ...assertProperty(properties, 'Publish packet ready', ['checkbox']),
      name: 'Publish packet ready',
    },
  };
}

function plainText(value: PageProperty | undefined) {
  if (!value) return '';
  if (value.type === 'rich_text') {
    return value.rich_text.map((item) => item.plain_text).join('');
  }
  if (value.type === 'title') {
    return value.title.map((item) => item.plain_text).join('');
  }
  if (value.type === 'select') return value.select?.name ?? '';
  if (value.type === 'status') return value.status?.name ?? '';
  if (value.type === 'url') return value.url ?? '';
  return '';
}

function canonicalValue<T extends string>(
  value: string,
  allowed: readonly T[],
  propertyName: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new RednotePostProjectionError(
      `Posts property ${propertyName} has a non-canonical value`,
      'REDNOTE_NOTION_STATE_INVALID',
      409,
    );
  }
  return value as T;
}

function assertPostsParent(page: PageObjectResponse, databaseId: string) {
  if (
    page.parent.type !== 'database_id' ||
    normalizeNotionPageId(page.parent.database_id) !==
      normalizeNotionPageId(databaseId)
  ) {
    throw new RednotePostProjectionError(
      'The source page is not in the configured Posts database',
      'REDNOTE_NOTION_POST_IDENTITY_CONFLICT',
      409,
    );
  }
}

export function rednotePostExecutionFromPage(
  page: PageObjectResponse,
  schema: RednotePostsSchema,
): ObservedRednotePostExecution {
  const property = (key: CanonicalKey) =>
    page.properties[schema.properties[key].name];
  const activeAttemptId = plainText(property('activeAttemptId')).trim();
  if (activeAttemptId && !UUID_PATTERN.test(activeAttemptId)) {
    throw new RednotePostProjectionError(
      'Active XHS attempt ID is not a canonical UUID',
      'REDNOTE_NOTION_STATE_INVALID',
      409,
    );
  }
  const packet = page.properties[schema.packetAuthorized.name];
  return {
    activeAttemptId: activeAttemptId || null,
    sourcePostRevision: page.last_edited_time,
    status: canonicalValue<RednotePostStatus>(
      plainText(property('status')),
      REDNOTE_POST_STATUSES,
      schema.properties.status.name,
    ),
    nextAction: canonicalValue<RednoteNextAction>(
      plainText(property('nextAction')),
      REDNOTE_NEXT_ACTIONS,
      schema.properties.nextAction.name,
    ),
    publishExecution: canonicalValue<RednotePublishExecution>(
      plainText(property('publishExecution')),
      REDNOTE_PUBLISH_EXECUTIONS,
      schema.properties.publishExecution.name,
    ),
    packetAuthorized:
      packet?.type === 'checkbox' ? packet.checkbox : false,
  };
}

function richText(content: string) {
  return content
    ? [{ type: 'text' as const, text: { content } }]
    : [];
}

function selectionUpdate(type: string, value: string) {
  if (type === 'select') return { select: { name: value } };
  if (type === 'status') return { status: { name: value } };
  throw new RednotePostProjectionError(
    'Canonical Posts selection property has changed type',
    'REDNOTE_NOTION_SCHEMA_INVALID',
  );
}

export function buildRednotePostMutationProperties(
  mutation: RednotePostMutationView,
  schema: RednotePostsSchema,
): PropertyUpdates {
  const properties: PropertyUpdates = {
    [schema.properties.activeAttemptId.name]: {
      rich_text: richText(mutation.desired.activeAttemptId ?? ''),
    },
  };
  if (mutation.desired.status) {
    properties[schema.properties.status.name] = selectionUpdate(
      schema.properties.status.type,
      mutation.desired.status,
    );
  }
  if (mutation.desired.nextAction) {
    properties[schema.properties.nextAction.name] = selectionUpdate(
      schema.properties.nextAction.type,
      mutation.desired.nextAction,
    );
  }
  if (mutation.desired.publishExecution) {
    properties[schema.properties.publishExecution.name] = selectionUpdate(
      schema.properties.publishExecution.type,
      mutation.desired.publishExecution,
    );
  }
  if (mutation.desired.rednoteUrl) {
    properties[schema.properties.rednoteUrl.name] = {
      url: mutation.desired.rednoteUrl,
    };
  }
  if (mutation.desired.rednoteNoteId) {
    properties[schema.properties.rednoteNoteId.name] = {
      rich_text: richText(mutation.desired.rednoteNoteId),
    };
  }
  if (mutation.desired.platformPublishTime) {
    properties[schema.properties.platformPublishTime.name] = {
      date: { start: mutation.desired.platformPublishTime },
    };
  }
  return properties;
}

function pageReceiptValue(
  page: PageObjectResponse,
  schema: RednotePostsSchema,
  key: 'rednoteUrl' | 'rednoteNoteId',
) {
  return plainText(page.properties[schema.properties[key].name]).trim();
}

function pagePlatformPublishTime(
  page: PageObjectResponse,
  schema: RednotePostsSchema,
) {
  const value = page.properties[schema.properties.platformPublishTime.name];
  return value?.type === 'date' ? value.date?.start ?? '' : '';
}

function sameInstant(left: string, right: string) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  return Number.isFinite(leftTime) &&
    Number.isFinite(rightTime) &&
    leftTime === rightTime;
}

export function rednoteMutationMatchesDesired(
  page: PageObjectResponse,
  schema: RednotePostsSchema,
  mutation: RednotePostMutationView,
) {
  const observed = rednotePostExecutionFromPage(page, schema);
  return (
    observed.activeAttemptId === mutation.desired.activeAttemptId &&
    (!mutation.desired.status ||
      observed.status === mutation.desired.status) &&
    (!mutation.desired.nextAction ||
      observed.nextAction === mutation.desired.nextAction) &&
    (!mutation.desired.publishExecution ||
      observed.publishExecution === mutation.desired.publishExecution) &&
    (!mutation.desired.rednoteUrl ||
      pageReceiptValue(page, schema, 'rednoteUrl') ===
        mutation.desired.rednoteUrl) &&
    (!mutation.desired.rednoteNoteId ||
      pageReceiptValue(page, schema, 'rednoteNoteId') ===
        mutation.desired.rednoteNoteId) &&
    (!mutation.desired.platformPublishTime ||
      sameInstant(
        pagePlatformPublishTime(page, schema),
        mutation.desired.platformPublishTime,
      ))
  );
}

export function rednoteMutationMatchesExpected(
  page: PageObjectResponse,
  schema: RednotePostsSchema,
  mutation: RednotePostMutationView,
) {
  const observed = rednotePostExecutionFromPage(page, schema);
  return (
    observed.activeAttemptId === mutation.expected.activeAttemptId &&
    (!mutation.expected.sourcePostRevision ||
      observed.sourcePostRevision === mutation.expected.sourcePostRevision) &&
    (!mutation.expected.status ||
      observed.status === mutation.expected.status) &&
    (!mutation.expected.nextAction ||
      observed.nextAction === mutation.expected.nextAction) &&
    (!mutation.expected.publishExecution ||
      observed.publishExecution === mutation.expected.publishExecution)
  );
}

export interface RednoteNotionProjectionAdapter {
  read(pageId: string): Promise<{
    page: PageObjectResponse;
    schema: RednotePostsSchema;
  }>;
  update(pageId: string, properties: PropertyUpdates): Promise<void>;
}

export function defaultRednoteNotionProjectionAdapter():
RednoteNotionProjectionAdapter {
  const client = getClient();
  const databaseId = getDatabaseId();
  return {
    async read(pageId) {
      try {
        const [database, page] = await Promise.all([
          client.databases.retrieve({ database_id: databaseId }),
          client.pages.retrieve({ page_id: pageId }),
        ]);
        if (!isFullDatabase(database) || !isFullPage(page)) {
          throw new RednotePostProjectionError(
            'Notion returned a partial Posts object',
            'REDNOTE_NOTION_PARTIAL_RESPONSE',
          );
        }
        assertPostsParent(page, databaseId);
        return {
          page,
          schema: resolveRednotePostsSchema(database.properties),
        };
      } catch (error) {
        throw projectionError(error);
      }
    },
    async update(pageId, properties) {
      try {
        await client.pages.update({ page_id: pageId, properties });
      } catch (error) {
        throw projectionError(error);
      }
    },
  };
}

export async function readRednotePostExecution(
  pageId: string,
  adapter = defaultRednoteNotionProjectionAdapter(),
) {
  const { page, schema } = await adapter.read(pageId);
  return rednotePostExecutionFromPage(page, schema);
}

export async function projectRednotePostMutation(
  mutation: RednotePostMutationView,
  adapter = defaultRednoteNotionProjectionAdapter(),
) {
  const current = await adapter.read(mutation.sourceNotionPageId);
  if (rednoteMutationMatchesDesired(current.page, current.schema, mutation)) {
    return { outcome: 'verified' as const };
  }
  if (!rednoteMutationMatchesExpected(current.page, current.schema, mutation)) {
    return {
      outcome: 'conflict' as const,
      observed: rednotePostExecutionFromPage(current.page, current.schema),
    };
  }
  await adapter.update(
    mutation.sourceNotionPageId,
    buildRednotePostMutationProperties(mutation, current.schema),
  );
  const verified = await adapter.read(mutation.sourceNotionPageId);
  if (!rednoteMutationMatchesDesired(
    verified.page,
    verified.schema,
    mutation,
  )) {
    throw new RednotePostProjectionError(
      'Notion accepted the update but the canonical Posts bundle did not verify',
      'REDNOTE_NOTION_VERIFY_FAILED',
    );
  }
  return { outcome: 'applied' as const };
}

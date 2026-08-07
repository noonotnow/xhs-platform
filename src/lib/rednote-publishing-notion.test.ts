import { describe, expect, it, vi } from 'vitest';
import type {
  PageObjectResponse,
  UpdatePageParameters,
} from '@notionhq/client/build/src/api-endpoints';
import {
  buildRednotePostMutationProperties,
  projectRednotePostMutation,
  rednoteMutationMatchesExpected,
  rednoteMutationMatchesDesired,
  rednotePostExecutionFromPage,
  resolveRednotePostsSchema,
  type RednoteNotionProjectionAdapter,
} from '@/lib/rednote-publishing-notion';
import type { RednotePostMutationView } from '@/lib/rednote-publishing-store';

function richText(content: string) {
  return content
    ? [{
        type: 'text' as const,
        text: { content, link: null },
        annotations: {
          bold: false,
          italic: false,
          strikethrough: false,
          underline: false,
          code: false,
          color: 'default' as const,
        },
        plain_text: content,
        href: null,
      }]
    : [];
}

const schema = resolveRednotePostsSchema({
  Status: { type: 'status' },
  'Next action': { type: 'select' },
  'Publish execution': { type: 'select' },
  'Active XHS attempt ID': { type: 'rich_text' },
  ScheduledDate: { type: 'date' },
  'Platform publish time': { type: 'date' },
  'Rednote URL': { type: 'url' },
  'Rednote Note ID': { type: 'rich_text' },
  'Publish packet ready': { type: 'checkbox' },
});

function select(name: string) {
  return {
    id: name,
    type: 'select' as const,
    select: { id: name, name, color: 'default' as const },
  };
}

function pageFixture(input: {
  revision?: string;
  activeAttemptId?: string | null;
  status?: string;
  nextAction?: string;
  publishExecution?: string;
  rednoteUrl?: string | null;
  rednoteNoteId?: string;
  platformPublishTime?: string | null;
} = {}): PageObjectResponse {
  const status = input.status ?? 'Ready';
  return {
    object: 'page',
    id: '11111111-1111-4111-8111-111111111111',
    created_time: '2026-08-07T15:00:00.000Z',
    last_edited_time:
      input.revision ?? '2026-08-07T16:00:00.000Z',
    created_by: { object: 'user', id: 'user' },
    last_edited_by: { object: 'user', id: 'user' },
    cover: null,
    icon: null,
    parent: { type: 'database_id', database_id: 'database' },
    archived: false,
    in_trash: false,
    properties: {
      Status: {
        id: 'status',
        type: 'status',
        status: { id: status, name: status, color: 'default' },
      },
      'Next action': select(
        input.nextAction ?? 'Ready for publication',
      ),
      'Publish execution': select(
        input.publishExecution ?? 'Not attempted',
      ),
      'Active XHS attempt ID': {
        id: 'active',
        type: 'rich_text',
        rich_text: richText(input.activeAttemptId ?? ''),
      },
      ScheduledDate: {
        id: 'schedule',
        type: 'date',
        date: null,
      },
      'Platform publish time': {
        id: 'published-at',
        type: 'date',
        date: input.platformPublishTime
          ? {
              start: input.platformPublishTime,
              end: null,
              time_zone: null,
            }
          : null,
      },
      'Rednote URL': {
        id: 'url',
        type: 'url',
        url: input.rednoteUrl ?? null,
      },
      'Rednote Note ID': {
        id: 'note',
        type: 'rich_text',
        rich_text: richText(input.rednoteNoteId ?? ''),
      },
      'Publish packet ready': {
        id: 'packet',
        type: 'checkbox',
        checkbox: true,
      },
    },
    url: 'https://notion.so/post',
    public_url: null,
  };
}

const attemptId = '22222222-2222-4222-8222-222222222222';
const workerClaim: RednotePostMutationView = {
  id: '33333333-3333-4333-8333-333333333333',
  attemptId,
  sourceNotionPageId: '11111111-1111-4111-8111-111111111111',
  kind: 'worker_claim',
  expected: {
    activeAttemptId: null,
    sourcePostRevision: '2026-08-07T16:00:00.000Z',
    status: 'Ready',
    nextAction: 'Ready for publication',
    publishExecution: 'Not attempted',
  },
  desired: {
    activeAttemptId: attemptId,
    status: 'Ready',
    nextAction: 'Resolve attempt',
    publishExecution: 'Worker claimed',
  },
  state: 'pending',
  diagnostics: {},
  createdAt: '2026-08-07T16:01:00.000Z',
};

const receiptMutation: RednotePostMutationView = {
  ...workerClaim,
  id: '44444444-4444-4444-8444-444444444444',
  kind: 'receipt_capture',
  expected: {
    activeAttemptId: attemptId,
    sourcePostRevision: '2026-08-07T16:10:00.000Z',
    status: 'Ready',
    nextAction: 'Backfill receipt',
    publishExecution: 'Worker batched',
  },
  desired: {
    activeAttemptId: null,
    status: 'Published',
    nextAction: 'Backfill metrics',
    publishExecution: 'Worker batched',
    rednoteUrl:
      'https://www.xiaohongshu.com/explore/0123456789abcdef01234567',
    rednoteNoteId: '0123456789abcdef01234567',
    platformPublishTime: '2026-08-07T16:09:00.000Z',
  },
};

describe('Rednote Posts projection', () => {
  it('requires every exact protected execution property', () => {
    expect(() => resolveRednotePostsSchema({
      Status: { type: 'status' },
    })).toThrowError(/Next action/);
    expect(() => resolveRednotePostsSchema({
      Status: { type: 'status' },
      'Next action': { type: 'select' },
      'Publish execution': { type: 'select' },
      'Active XHS attempt ID': { type: 'title' },
      ScheduledDate: { type: 'date' },
      'Platform publish time': { type: 'date' },
      'Rednote URL': { type: 'url' },
      'Rednote Note ID': { type: 'rich_text' },
      'Publish packet ready': { type: 'checkbox' },
    })).toThrowError(/Active XHS attempt ID/);
  });

  it('reads the canonical tuple without classifying legacy queue wording', () => {
    expect(rednotePostExecutionFromPage(pageFixture(), schema)).toEqual({
      activeAttemptId: null,
      sourcePostRevision: '2026-08-07T16:00:00.000Z',
      status: 'Ready',
      nextAction: 'Ready for publication',
      publishExecution: 'Not attempted',
      packetAuthorized: true,
    });
    expect(() => rednotePostExecutionFromPage(pageFixture({
      nextAction: 'Backfill URL/metrics',
    }), schema)).toThrowError(/non-canonical/);
  });

  it('compares expected revision only before write and desired state after write', () => {
    expect(rednoteMutationMatchesExpected(
      pageFixture(),
      schema,
      workerClaim,
    )).toBe(true);
    expect(rednoteMutationMatchesDesired(
      pageFixture({
        revision: '2026-08-07T16:02:00.000Z',
        activeAttemptId: attemptId,
        nextAction: 'Resolve attempt',
        publishExecution: 'Worker claimed',
      }),
      schema,
      workerClaim,
    )).toBe(true);
  });

  it('builds URL, Note ID, platform time, lifecycle, and pointer as one bundle', () => {
    expect(buildRednotePostMutationProperties(
      receiptMutation,
      schema,
    )).toMatchObject({
      Status: { status: { name: 'Published' } },
      'Next action': { select: { name: 'Backfill metrics' } },
      'Publish execution': { select: { name: 'Worker batched' } },
      'Active XHS attempt ID': { rich_text: [] },
      'Rednote URL': { url: receiptMutation.desired.rednoteUrl },
      'Rednote Note ID': {
        rich_text: [{
          text: { content: receiptMutation.desired.rednoteNoteId },
        }],
      },
      'Platform publish time': {
        date: { start: receiptMutation.desired.platformPublishTime },
      },
    });
  });

  it('does not write when the compare tuple changed', async () => {
    const update = vi.fn();
    const adapter: RednoteNotionProjectionAdapter = {
      read: async () => ({
        page: pageFixture({ status: 'Draft' }),
        schema,
      }),
      update,
    };
    await expect(projectRednotePostMutation(
      workerClaim,
      adapter,
    )).resolves.toMatchObject({ outcome: 'conflict' });
    expect(update).not.toHaveBeenCalled();
  });

  it('re-reads and verifies a publication bundle after one update', async () => {
    const before = pageFixture({
      revision: '2026-08-07T16:10:00.000Z',
      activeAttemptId: attemptId,
      nextAction: 'Backfill receipt',
      publishExecution: 'Worker batched',
    });
    const after = pageFixture({
      revision: '2026-08-07T16:11:00.000Z',
      status: 'Published',
      nextAction: 'Backfill metrics',
      publishExecution: 'Worker batched',
      rednoteUrl: receiptMutation.desired.rednoteUrl,
      rednoteNoteId: receiptMutation.desired.rednoteNoteId,
      platformPublishTime: receiptMutation.desired.platformPublishTime,
    });
    const update = vi.fn<
      (pageId: string, properties: UpdatePageParameters['properties']) =>
      Promise<void>
    >(async () => undefined);
    let reads = 0;
    const adapter: RednoteNotionProjectionAdapter = {
      read: async () => ({
        page: reads++ === 0 ? before : after,
        schema,
      }),
      update,
    };
    await expect(projectRednotePostMutation(
      receiptMutation,
      adapter,
    )).resolves.toEqual({ outcome: 'applied' });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('treats an already-applied bundle as verified crash recovery', async () => {
    const update = vi.fn();
    const adapter: RednoteNotionProjectionAdapter = {
      read: async () => ({
        page: pageFixture({
          revision: '2026-08-07T16:02:00.000Z',
          activeAttemptId: attemptId,
          nextAction: 'Resolve attempt',
          publishExecution: 'Worker claimed',
        }),
        schema,
      }),
      update,
    };
    await expect(projectRednotePostMutation(
      workerClaim,
      adapter,
    )).resolves.toEqual({ outcome: 'verified' });
    expect(update).not.toHaveBeenCalled();
  });
});

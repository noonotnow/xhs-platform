import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    connect: vi.fn().mockResolvedValue({
      query: mocks.query,
      release: mocks.release,
    }),
  }),
}));

import {
  createRednotePublishAttempt,
  frozenPayloadDigest,
  requeueReadyX3InvalidClaimFailure,
  requeueReadyX3NotLoggedInFailure,
  requeueReadyX3ScheduleReadbackMismatch,
  requeueReadyX3StaleBrowserFrameFailure,
  supersedeUnclaimedReadyX3Schedule,
  withReadyX3SourceLock,
} from '@/lib/rednote-publishing-attempt-store';
import { REDNOTE_PUBLISHING_CONTRACT_REVISION } from '@/lib/rednote-publishing-contract-v1';

const input = {
  workspaceId: 'workspace-1',
  jobId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  sourceNotionPageId: 'notion-page-1',
  revision: '2026-08-31T15:56:00.000Z',
};

function mockEligibleRecovery(eligible: boolean) {
  mocks.query.mockImplementation(async (statement: string) => {
    if (statement.includes('UPDATE local_publish_jobs job')) {
      return { rows: eligible ? [{ id: input.jobId }] : [] };
    }
    return { rows: [], rowCount: 1 };
  });
}

describe('Ready x3 pre-provider failure recovery', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.release.mockReset();
  });

  it('requeues the same attempt after a guarded NOT_LOGGED_IN failure', async () => {
    mockEligibleRecovery(true);

    await expect(requeueReadyX3NotLoggedInFailure(input)).resolves.toEqual({
      requeued: true,
      jobId: input.jobId,
      attemptId: input.attemptId,
      publicationMayHaveStarted: false,
    });

    const eligibleCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE local_publish_jobs job'));
    expect(eligibleCall?.[1]).toEqual([
      input.workspaceId,
      input.jobId,
      input.attemptId,
      input.sourceNotionPageId,
      input.revision,
      'NOT_LOGGED_IN',
      null,
    ]);

    const eligibleSql = String(eligibleCall?.[0]);
    expect(eligibleSql).toContain("job.status='failed'");
    expect(eligibleSql).toContain('job.staged_at IS NULL');
    expect(eligibleSql).toContain('job.dispatch_authorized_at IS NULL');
    expect(eligibleSql).toContain('job.dispatched_at IS NULL');
    expect(eligibleSql).toContain('job.note_id IS NULL');
    expect(eligibleSql).toContain('job.share_url IS NULL');
    expect(eligibleSql).toContain('job.success_attestation_id IS NULL');
    expect(eligibleSql).toContain('job.external_disposition_request_id IS NULL');
    expect(eligibleSql).toContain('attempt.dispatch_authorized_at IS NULL');
    expect(eligibleSql).toContain("event.event_type='execution_started'");
    expect(eligibleSql).toContain('FROM rednote_publish_attempt_receipts receipt');

    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements.some((statement) =>
      statement.includes('INSERT INTO local_publish_jobs'))).toBe(false);
    expect(statements.some((statement) =>
      statement.includes("'not_logged_in_failure_requeued'"))).toBe(false);
    expect(mocks.query.mock.calls.some(([, params]) =>
      Array.isArray(params) &&
      params.includes('not_logged_in_failure_requeued'))).toBe(true);
  });

  it('fails closed when any eligibility guard rejects the login recovery', async () => {
    mockEligibleRecovery(false);

    await expect(requeueReadyX3NotLoggedInFailure(input)).rejects.toMatchObject({
      code: 'READY_X3_NOT_LOGGED_IN_RECOVERY_UNSAFE',
      status: 409,
    });
    expect(mocks.query.mock.calls.some(([statement]) =>
      String(statement) === 'ROLLBACK')).toBe(true);
  });

  it('preserves the existing INVALID_CLAIM recovery predicate', async () => {
    mockEligibleRecovery(true);

    await requeueReadyX3InvalidClaimFailure(input);

    const eligibleCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE local_publish_jobs job'));
    expect(eligibleCall?.[1]?.[5]).toBe('INVALID_CLAIM');
  });

  it('requires the exact pre-provider stale browser frame failure', async () => {
    mockEligibleRecovery(true);

    await expect(requeueReadyX3StaleBrowserFrameFailure(input)).resolves.toMatchObject({
      requeued: true,
      jobId: input.jobId,
      attemptId: input.attemptId,
      publicationMayHaveStarted: false,
    });

    const eligibleCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE local_publish_jobs job'));
    expect(eligibleCall?.[1]?.[5]).toBe('INTERNAL_ERROR');
    expect(eligibleCall?.[1]?.[6]).toBe(
      'page.goto: Protocol error (Page.navigate): No frame with given id found%',
    );
    expect(String(eligibleCall?.[0])).toContain(
      '($7::text IS NULL OR job.error_message LIKE $7)',
    );
  });

  it('requires the exact pre-provider schedule readback failure', async () => {
    mockEligibleRecovery(true);

    await expect(requeueReadyX3ScheduleReadbackMismatch(input)).resolves.toMatchObject({
      requeued: true,
      jobId: input.jobId,
      attemptId: input.attemptId,
      publicationMayHaveStarted: false,
    });

    const eligibleCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE local_publish_jobs job'));
    expect(eligibleCall?.[1]?.[5]).toBe('SCHEDULE_READBACK_MISMATCH');
    expect(eligibleCall?.[1]?.[6]).toBe(
      'Creator date-picker did not retain the scheduled time (got %',
    );
  });
});

describe('Ready x3 source serialization', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.release.mockReset();
  });

  it('holds one transaction-scoped advisory lock for the source operation', async () => {
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    const operation = vi.fn().mockResolvedValue('created');

    await expect(withReadyX3SourceLock(
      'workspace-1',
      'notion-page-1',
      operation,
    )).resolves.toBe('created');

    const lock = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('pg_advisory_xact_lock'));
    expect(lock?.[1]).toEqual(['workspace-1:notion-page-1']);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not reacquire the same source lock while creating the linked attempt', async () => {
    const requestedAt = '2026-08-31T18:00:00.000Z';
    const payload = {
      contractRevision: REDNOTE_PUBLISHING_CONTRACT_REVISION,
      sourceNotionPageId: 'notion-page-1',
      sourceLocalPublishJobId: '11111111-1111-4111-8111-111111111111',
      payloadRevision: '2026-08-31T17:00:00.000Z',
      payloadDigest: '',
      requestedAt,
      executor: { type: 'worker' as const, kind: 'playwright' as const, id: 'worker-1' },
      browserPayload: {
        sourcePostId: 'notion-page-1',
        title: 'Title',
        caption: 'Caption',
        tags: ['Tag'],
        scheduledDate: '2026-08-31T18:15:00.000Z',
        targetPublishAt: requestedAt,
        timingMode: 'post_now' as const,
        visibility: 'public' as const,
        publishMode: 'image' as const,
        mediaAssets: [{
          assetId: 'image-0',
          deliveryUrl: 'https://images.xhs.justlikekatie.com/post.jpg',
          sha256: 'a'.repeat(64),
          mediaType: 'image' as const,
          role: 'content' as const,
        }],
      },
    };
    payload.payloadDigest = frozenPayloadDigest(payload);
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('SELECT * FROM rednote_publish_attempts')) {
        return { rows: [], rowCount: 0 };
      }
      if (statement.includes('INSERT INTO rednote_publish_attempts')) {
        return {
          rows: [{
            id: '22222222-2222-4222-8222-222222222222',
            workspace_id: 'workspace-1',
            source_notion_page_id: 'notion-page-1',
            source_local_publish_job_id: payload.sourceLocalPublishJobId,
            frozen_payload: payload,
            payload_digest: payload.payloadDigest,
            payload_revision: payload.payloadRevision,
            executor_type: 'worker',
            executor_kind: 'playwright',
            executor_id: 'worker-1',
            requested_at: requestedAt,
            created_at: requestedAt,
            approved_at: null,
            terminal_outcome: null,
            terminal_at: null,
            receipt_lookup_state: 'not_required',
            receipt_lookup_updated_at: null,
            active: true,
            supersedes_attempt_id: null,
            superseded_by_attempt_id: null,
            authorization_kind: 'ready_x3',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await withReadyX3SourceLock('workspace-1', 'notion-page-1', () =>
      createRednotePublishAttempt({
        workspaceId: 'workspace-1',
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
        payload,
        readyX3: true,
      }));

    const lockCalls = mocks.query.mock.calls.filter(([statement]) =>
      String(statement).includes('pg_advisory_xact_lock'));
    expect(lockCalls).toHaveLength(1);
  });

  it('supersedes the same frozen packet across schedule and Post now actions', async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('SELECT job.id AS job_id')) {
        return {
          rows: [{
            job_id: '11111111-1111-4111-8111-111111111111',
            attempt_id: '22222222-2222-4222-8222-222222222222',
            job_status: 'queued',
            job_claim_token: null,
            job_dispatch_authorized_at: null,
            attempt_claim_token: null,
            attempt_dispatch_authorized_at: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(supersedeUnclaimedReadyX3Schedule(
      'workspace-1',
      {
        notionPageId: 'notion-page-1',
        headline: 'Headline',
        title: 'Title',
        caption: 'Caption',
        tags: ['Tag'],
        platform: 'RedNote',
        mediaType: 'video',
        mediaIndex: 0,
        mediaUrl: 'https://images.xhs.justlikekatie.com/post.mp4',
        thumbnailUrl: 'https://images.xhs.justlikekatie.com/cover.jpg',
        publishAt: '2020-08-31T18:00:00.000Z',
        notionLastEditedTime: '2020-08-31T17:00:00.000Z',
      },
      'post_now',
    )).resolves.toBe(true);

    const select = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('SELECT job.id AS job_id'));
    expect(String(select?.[0])).not.toContain('frozen_payload');
    expect(select?.[1]).toEqual(['workspace-1', 'notion-page-1']);
  });

  it('blocks replacement after the existing authorization enters worker execution', async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('SELECT job.id AS job_id')) {
        return {
          rows: [{
            job_id: '11111111-1111-4111-8111-111111111111',
            attempt_id: '22222222-2222-4222-8222-222222222222',
            job_status: 'staged',
            job_claim_token: '33333333-3333-4333-8333-333333333333',
            job_dispatch_authorized_at: null,
            attempt_claim_token: '33333333-3333-4333-8333-333333333333',
            attempt_dispatch_authorized_at: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(supersedeUnclaimedReadyX3Schedule(
      'workspace-1',
      {
        notionPageId: 'notion-page-1',
        headline: 'Headline',
        title: 'Title',
        caption: 'Caption',
        tags: ['Tag'],
        platform: 'RedNote',
        mediaType: 'image',
        mediaIndex: 0,
        mediaUrl: 'https://images.xhs.justlikekatie.com/post.jpg',
        publishAt: '2099-08-31T18:00:00.000Z',
        notionLastEditedTime: '2099-08-31T17:00:00.000Z',
      },
      'post_now',
    )).rejects.toMatchObject({
      code: 'READY_X3_ATTEMPT_IN_PROGRESS',
      status: 409,
    });
    expect(mocks.query.mock.calls.some(([statement]) =>
      String(statement).includes('UPDATE rednote_publish_attempts'))).toBe(false);
  });
});
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
  requeueReadyX3InvalidClaimFailure,
  requeueReadyX3NotLoggedInFailure,
  requeueReadyX3StaleBrowserFrameFailure,
} from '@/lib/rednote-publishing-attempt-store';

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
});
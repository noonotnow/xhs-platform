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

import { recoverStoredApprovedPublishJob } from '@/lib/rednote-publish-job-recovery-store';
import type { RednotePublishJobRecoveryInput } from '@/lib/rednote-publish-job-recovery';

const input: RednotePublishJobRecoveryInput = {
  batchId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
  itemHash: 'b'.repeat(64),
  snapshotRevision: '2026-08-04T13:12:00.000Z',
};
const recoveryId = '55555555-5555-4555-8555-555555555555';
const actor = 'operator@example.com';
const snapshot = {
  notionPageId: '44444444-4444-4444-8444-444444444444',
  headline: 'Approved',
  title: 'Approved',
  caption: 'Frozen',
  tags: [],
  platform: 'RedNote',
  mediaType: 'video',
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/post.mp4',
  publishAt: '2026-08-04T18:00:00.000Z',
  notionLastEditedTime: input.snapshotRevision,
};

function row(recovered = false, generation = 1) {
  return {
    batch_id: input.batchId,
    batch_status: 'approved',
    manifest_hash: input.manifestHash,
    approved_at: '2026-08-04T17:03:59.881Z',
    item_id: input.itemId,
    item_batch_id: input.batchId,
    item_hash: input.itemHash,
    item_state: recovered ? 'queued' : 'failed',
    item_local_publish_job_id: input.jobId,
    item_snapshot: snapshot,
    job_id: input.jobId,
    job_batch_item_id: input.itemId,
    job_status: recovered ? 'queued' : 'failed',
    job_snapshot: snapshot,
    notion_page_id: snapshot.notionPageId,
    job_error_code: recovered ? null : 'BOUNDED_BATCH_BYPASS_DISABLED',
    job_error_message: recovered ? null : 'Worker bypass is disabled',
    claim_token: recovered ? null : '66666666-6666-4666-8666-666666666666',
    claim_attempts: generation,
    claimed_at: recovered ? null : '2026-08-04T17:04:33.424Z',
    claimed_at_raw: recovered ? null : '2026-08-04 17:04:33.424+00',
    claim_expires_at: recovered ? null : '2026-08-04T19:04:33.424Z',
    completed_at: recovered ? null : '2026-08-04T17:04:33.963Z',
    completed_at_raw: recovered ? null : '2026-08-04 17:04:33.963+00',
    staged_at: null,
    dispatch_authorized_at: null,
    dispatched_at: null,
    note_id: null,
    share_url: null,
    verification_attempts: 0,
    next_verification_at: null,
    verified_at: null,
    reconciled_at: null,
    recovery_id: recovered ? recoveryId : null,
    recovered_by: recovered ? actor : null,
    recovered_at: recovered ? '2026-08-04T17:30:00.000Z' : null,
    recovery_batch_id: recovered ? input.batchId : null,
    recovery_manifest_hash: recovered ? input.manifestHash : null,
    recovery_item_id: recovered ? input.itemId : null,
    recovery_item_hash: recovered ? input.itemHash : null,
    recovery_snapshot_revision: recovered ? input.snapshotRevision : null,
    recovery_prior_claim_attempts: recovered ? 1 : null,
    recovery_prior_claimed_at: recovered ? '2026-08-04T17:04:33.424Z' : null,
    recovery_prior_completed_at: recovered ? '2026-08-04T17:04:33.963Z' : null,
  };
}

describe('stored approved publish job recovery', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.release.mockReset();
  });

  it('writes one audit and requeues the same job without changing approval or identity', async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('FROM local_publish_jobs AS job')) return { rows: [row()] };
      if (statement.includes('AS active_ownership')) {
        return { rows: [{ active_ownership: false }] };
      }
      if (statement.includes('INSERT INTO rednote_publish_job_recoveries')) {
        return {
          rows: [{
            id: recoveryId,
            recovered_at: '2026-08-04T17:30:00.000Z',
          }],
        };
      }
      if (statement.includes('UPDATE local_publish_jobs')) {
        return { rows: [], rowCount: 1 };
      }
      if (statement.includes('FROM rednote_publish_batch_items')) {
        return {
          rows: [{
            state: 'queued',
            local_publish_job_id: input.jobId,
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(recoverStoredApprovedPublishJob(input, actor)).resolves.toMatchObject({
      id: recoveryId,
      ...input,
      recoveredBy: actor,
      priorClaimAttempts: 1,
      alreadyRecovered: false,
    });

    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements.filter((value) =>
      value.includes('INSERT INTO rednote_publish_job_recoveries'))).toHaveLength(1);
    expect(statements.filter((value) =>
      value.includes('UPDATE local_publish_jobs'))).toHaveLength(1);
    expect(statements.some((value) =>
      value.includes('INSERT INTO local_publish_jobs'))).toBe(false);
    expect(statements.some((value) =>
      value.includes('INSERT INTO rednote_publish_batch_items'))).toBe(false);
    expect(statements.some((value) =>
      value.includes('UPDATE rednote_publish_batches'))).toBe(false);
    expect(statements.some((value) =>
      value.includes('plan_operator_scheduled_posts'))).toBe(true);
    expect(statements.some((value) =>
      value.includes('operator_scheduled.reconciled_at IS NULL'))).toBe(false);
    const update = statements.find((value) => value.includes('UPDATE local_publish_jobs'))!;
    expect(update).toContain("SET status = 'queued'");
    expect(update.split('WHERE')[0]).not.toContain('claim_attempts');
    expect(update).not.toContain('snapshot =');
    expect(update).toContain('AND claim_attempts = $3');
    expect(update).toContain('external_disposition_request_id IS NULL');
    expect(update).toContain('AND claimed_at = $4::timestamptz');
    expect(update).toContain('AND completed_at = $5::timestamptz');
    expect(update).toContain('AND error_code = $6');
    expect(update).toContain('AND error_message IS NOT DISTINCT FROM $7');
    const auditCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('INSERT INTO rednote_publish_job_recoveries'));
    expect(auditCall?.[1]).toEqual([
      input.jobId,
      input.itemId,
      input.batchId,
      input.manifestHash,
      input.itemHash,
      input.snapshotRevision,
      'BOUNDED_BATCH_BYPASS_DISABLED',
      'Worker bypass is disabled',
      1,
      '2026-08-04 17:04:33.424+00',
      '2026-08-04 17:04:33.963+00',
      actor,
    ]);
    const updateCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE local_publish_jobs'));
    expect(updateCall?.[1]).toEqual([
      input.jobId,
      input.itemId,
      1,
      '2026-08-04 17:04:33.424+00',
      '2026-08-04 17:04:33.963+00',
      'BOUNDED_BATCH_BYPASS_DISABLED',
      'Worker bypass is disabled',
    ]);
    const ownership = statements.find((value) => value.includes('AS active_ownership'))!;
    expect(ownership).toContain('manual_reconciliation_requests');
    expect(ownership).toContain('external_post_reconciliations');
    expect(ownership).toContain('other_job');
    expect(ownership).toContain('other_item');
    expect(statements).toContain('COMMIT');
  });

  it('selects the latest audit and appends generation two after the active-drain race', async () => {
    const generationTwoId = '77777777-7777-4777-8777-777777777777';
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('FROM local_publish_jobs AS job')) {
        return {
          rows: [{
            ...row(true, 2),
            item_state: 'failed',
            job_status: 'failed',
            job_error_code: 'BOUNDED_BATCH_BYPASS_DISABLED',
            job_error_message: 'Worker bypass is disabled',
            claim_token: '88888888-8888-4888-8888-888888888888',
            claimed_at: new Date('2026-08-04T18:35:27.626Z'),
            claimed_at_raw: '2026-08-04 18:35:27.626710+00',
            claim_expires_at: '2026-08-04T19:30:08.000Z',
            completed_at: new Date('2026-08-04T18:35:28.151Z'),
            completed_at_raw: '2026-08-04 18:35:28.151762+00',
          }],
        };
      }
      if (statement.includes('AS active_ownership')) {
        return { rows: [{ active_ownership: false }] };
      }
      if (statement.includes('INSERT INTO rednote_publish_job_recoveries')) {
        return {
          rows: [{
            id: generationTwoId,
            recovered_at: '2026-08-04T17:31:00.000Z',
          }],
        };
      }
      if (statement.includes('UPDATE local_publish_jobs')) return { rows: [], rowCount: 1 };
      if (statement.includes('FROM rednote_publish_batch_items')) {
        return { rows: [{ state: 'queued', local_publish_job_id: input.jobId }] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(recoverStoredApprovedPublishJob(input, actor)).resolves.toMatchObject({
      id: generationTwoId,
      priorClaimAttempts: 2,
      alreadyRecovered: false,
    });
    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    const candidateQuery = statements.find((value) =>
      value.includes('FROM local_publish_jobs AS job'))!;
    expect(candidateQuery).toContain('LEFT JOIN LATERAL');
    expect(candidateQuery).toContain('ORDER BY prior_claim_attempts DESC, recovered_at DESC');
    expect(candidateQuery).toContain('job.claimed_at::text AS claimed_at_raw');
    expect(candidateQuery).toContain('job.completed_at::text AS completed_at_raw');
    const insertCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('INSERT INTO rednote_publish_job_recoveries'));
    expect(insertCall?.[1]?.[8]).toBe(2);
    expect(insertCall?.[1]?.slice(9, 11)).toEqual([
      '2026-08-04 18:35:27.626710+00',
      '2026-08-04 18:35:28.151762+00',
    ]);
    const updateCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE local_publish_jobs'));
    expect(updateCall?.[1]?.slice(3, 5)).toEqual([
      '2026-08-04 18:35:27.626710+00',
      '2026-08-04 18:35:28.151762+00',
    ]);
    expect(statements.indexOf(
      "SELECT pg_advisory_xact_lock(hashtextextended('rednote-bootstrap-batch', 0))",
    )).toBeLessThan(statements.indexOf(candidateQuery));
  });

  it('returns the same audit for an exact queued retry without another write', async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('FROM local_publish_jobs AS job')) {
        return {
          rows: [{
            ...row(true),
            claim_attempts: 2,
            recovery_prior_claim_attempts: 2,
            recovery_prior_claimed_at: '2026-08-04 18:35:27.626710+00',
            recovery_prior_completed_at: '2026-08-04 18:35:28.151762+00',
          }],
        };
      }
      if (statement.includes('AS active_ownership')) {
        return { rows: [{ active_ownership: false }] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(recoverStoredApprovedPublishJob(input, actor)).resolves.toMatchObject({
      id: recoveryId,
      jobId: input.jobId,
      priorClaimAttempts: 2,
      alreadyRecovered: true,
    });
    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements.some((value) => value.startsWith('INSERT'))).toBe(false);
    expect(statements.some((value) => value.startsWith('UPDATE'))).toBe(false);
    expect(statements).toContain('COMMIT');
  });

  it('appends and requeues the exact generation-three image-mode hydration failure', async () => {
    const generationThreeId = '99999999-9999-4999-8999-999999999999';
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('FROM local_publish_jobs AS job')) {
        return {
          rows: [{
            ...row(true, 3),
            item_state: 'failed',
            job_status: 'failed',
            job_error_code: 'AMBIGUOUS_CREATOR_UI',
            job_error_message: 'Could not uniquely identify the image upload mode',
            claim_token: '88888888-8888-4888-8888-888888888888',
            claimed_at: new Date('2026-08-04T19:16:27.900Z'),
            claimed_at_raw: '2026-08-04 19:16:27.900123+00',
            claim_expires_at: '2026-08-04T21:16:27.900Z',
            completed_at: new Date('2026-08-04T19:16:28.333Z'),
            completed_at_raw: '2026-08-04 19:16:28.333669+00',
            recovery_prior_claim_attempts: 2,
            recovery_prior_claimed_at: '2026-08-04 18:35:27.626710+00',
            recovery_prior_completed_at: '2026-08-04 18:35:28.151762+00',
            recovered_at: '2026-08-04T18:40:00.000Z',
          }],
        };
      }
      if (statement.includes('AS active_ownership')) {
        return { rows: [{ active_ownership: false }] };
      }
      if (statement.includes('INSERT INTO rednote_publish_job_recoveries')) {
        return {
          rows: [{ id: generationThreeId, recovered_at: '2026-08-04T19:30:00.000Z' }],
        };
      }
      if (statement.includes('UPDATE local_publish_jobs')) return { rows: [], rowCount: 1 };
      if (statement.includes('FROM rednote_publish_batch_items')) {
        return { rows: [{ state: 'queued', local_publish_job_id: input.jobId }] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(recoverStoredApprovedPublishJob(input, actor)).resolves.toMatchObject({
      id: generationThreeId,
      priorClaimAttempts: 3,
      alreadyRecovered: false,
    });
    const updateCall = mocks.query.mock.calls.find(([statement]) =>
      String(statement).includes('UPDATE local_publish_jobs'));
    expect(updateCall?.[1]).toEqual([
      input.jobId,
      input.itemId,
      3,
      '2026-08-04 19:16:27.900123+00',
      '2026-08-04 19:16:28.333669+00',
      'AMBIGUOUS_CREATOR_UI',
      'Could not uniquely identify the image upload mode',
    ]);
  });

  it('rolls back the audit when the exact timestamp compare-and-set fails', async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('FROM local_publish_jobs AS job')) return { rows: [row()] };
      if (statement.includes('AS active_ownership')) {
        return { rows: [{ active_ownership: false }] };
      }
      if (statement.includes('INSERT INTO rednote_publish_job_recoveries')) {
        return {
          rows: [{ id: recoveryId, recovered_at: '2026-08-04T17:30:00.000Z' }],
        };
      }
      if (statement.includes('UPDATE local_publish_jobs')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    await expect(recoverStoredApprovedPublishJob(input, actor)).rejects.toThrow(
      'The publish job changed before recovery could be committed.',
    );
    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(statements.some((value) =>
      value.includes('SELECT state, local_publish_job_id'))).toBe(false);
  });
});

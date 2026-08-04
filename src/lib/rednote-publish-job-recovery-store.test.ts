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

function row(recovered = false) {
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
    claim_attempts: 1,
    claimed_at: recovered ? null : '2026-08-04T17:04:33.424Z',
    claim_expires_at: recovered ? null : '2026-08-04T19:04:33.424Z',
    completed_at: recovered ? null : '2026-08-04T17:04:33.963Z',
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
    const update = statements.find((value) => value.includes('UPDATE local_publish_jobs'))!;
    expect(update).toContain("SET status = 'queued'");
    expect(update).not.toContain('claim_attempts =');
    expect(update).not.toContain('snapshot =');
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
      '2026-08-04T17:04:33.424Z',
      '2026-08-04T17:04:33.963Z',
      actor,
    ]);
    const ownership = statements.find((value) => value.includes('AS active_ownership'))!;
    expect(ownership).toContain('manual_reconciliation_requests');
    expect(ownership).toContain('external_post_reconciliations');
    expect(ownership).toContain('other_job');
    expect(ownership).toContain('other_item');
    expect(statements).toContain('COMMIT');
  });

  it('returns the same audit for an exact queued retry without another write', async () => {
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('FROM local_publish_jobs AS job')) {
        return { rows: [row(true)] };
      }
      if (statement.includes('AS active_ownership')) {
        return { rows: [{ active_ownership: false }] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(recoverStoredApprovedPublishJob(input, actor)).resolves.toMatchObject({
      id: recoveryId,
      jobId: input.jobId,
      alreadyRecovered: true,
    });
    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements.some((value) => value.startsWith('INSERT'))).toBe(false);
    expect(statements.some((value) => value.startsWith('UPDATE'))).toBe(false);
    expect(statements).toContain('COMMIT');
  });
});

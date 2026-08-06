import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueryResultRow } from 'pg';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    connect: vi.fn().mockResolvedValue({
      query: mocks.query,
      release: mocks.release,
    }),
  }),
  sql: mocks.sql,
}));

import {
  approveStoredPublishBatch,
  createStoredPublishBatch,
  listStoredPublishBatches,
} from '@/lib/rednote-publish-batch-store';
import type {
  LocalPublishSnapshot,
  PublishBatchStatus,
} from '@/types/local-publish-job';

const snapshot: LocalPublishSnapshot = {
  notionPageId: '11111111-1111-4111-8111-111111111111',
  headline: 'Replacement sibling',
  title: 'Replacement sibling',
  caption: 'Frozen caption',
  tags: ['FrozenTag'],
  platform: 'RedNote',
  mediaType: 'video',
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/videos/assets/post.mp4',
  publishAt: '2026-08-04T18:00:00.000Z',
  notionLastEditedTime: '2026-08-04T12:00:00.000Z',
};

function batchRow(
  id: string,
  status: PublishBatchStatus,
  manifestHash: string,
): QueryResultRow {
  return {
    id,
    kind: 'bootstrap',
    status,
    manifest_hash: manifestHash,
    candidate_report: [],
    window_start: null,
    window_end: null,
    approved_at: status === 'approved' ? '2026-08-04T17:03:59.881Z' : null,
    approved_by: status === 'approved' ? 'operator@example.com' : null,
    superseded_at: status === 'superseded'
      ? '2026-08-04T16:00:00.000Z'
      : null,
    superseded_by_batch_id: null,
    created_at: '2026-08-04T15:00:00.000Z',
  };
}

describe('stored RedNote bootstrap replacement', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.release.mockReset();
    mocks.sql.mockReset();
  });

  it('atomically supersedes the old audit row and creates a replacement manifest', async () => {
    const oldId = '22222222-2222-4222-8222-222222222222';
    const newId = '33333333-3333-4333-8333-333333333333';
    const oldHash = 'a'.repeat(64);
    const newHash = 'b'.repeat(64);
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('SELECT DISTINCT ON')) return { rows: [] };
      if (statement.includes("SET status = 'superseded'")) {
        return { rows: [batchRow(oldId, 'superseded', oldHash)] };
      }
      if (statement.includes('INSERT INTO rednote_publish_batches')) {
        return { rows: [batchRow(newId, 'pending_approval', newHash)] };
      }
      if (statement.includes('INSERT INTO rednote_publish_batch_items')) {
        return {
          rows: [{
            id: '44444444-4444-4444-8444-444444444444',
            batch_id: newId,
            notion_page_id: snapshot.notionPageId,
            snapshot,
            item_hash: newHash,
            state: 'needs_approval',
            dispatch_mode: 'scheduled',
            late_by_seconds: 0,
            invalidation_reason: null,
            local_publish_job_id: null,
          }],
        };
      }
      if (statement.includes('SET manifest_hash = $1')) {
        return { rows: [batchRow(newId, 'pending_approval', 'c'.repeat(64))] };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await createStoredPublishBatch({
      kind: 'bootstrap',
      manifestHash: newHash,
      items: [{
        notionPageId: snapshot.notionPageId,
        snapshot,
        itemHash: newHash,
        dispatchMode: 'scheduled',
        lateBySeconds: 0,
      }],
      blockedCandidates: [],
    });

    expect(result).toMatchObject({
      id: newId,
      status: 'pending_approval',
      items: [expect.objectContaining({ notionPageId: snapshot.notionPageId })],
    });
    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining("SET status = 'superseded'"),
      expect.stringContaining('Batch superseded before approval'),
      expect.stringContaining('SET superseded_by_batch_id = $1::uuid'),
      'COMMIT',
    ]));
  });

  it('rejects a superseded manifest before changing any item', async () => {
    const oldHash = 'a'.repeat(64);
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('FOR UPDATE')) {
        return { rows: [batchRow('old', 'superseded', oldHash)] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(approveStoredPublishBatch(
      '22222222-2222-4222-8222-222222222222',
      oldHash,
      'operator@example.com',
      [],
    )).rejects.toThrow(/superseded and can never be approved/i);
    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements).toContain('ROLLBACK');
    expect(statements.some((statement) =>
      statement.includes('INSERT INTO local_publish_jobs'))).toBe(false);
  });

  it('serializes approval on the bootstrap lock and commits atomically', async () => {
    const batchId = '22222222-2222-4222-8222-222222222222';
    const manifestHash = 'a'.repeat(64);
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes('FOR UPDATE')) {
        return { rows: [batchRow(batchId, 'pending_approval', manifestHash)] };
      }
      if (statement.includes('UPDATE rednote_publish_batches AS batch')) {
        return { rows: [batchRow(batchId, 'approved', manifestHash)] };
      }
      return { rows: [], rowCount: 1 };
    });
    mocks.sql
      .mockResolvedValueOnce({
        rows: [batchRow(batchId, 'approved', manifestHash)],
      })
      .mockResolvedValueOnce({ rows: [] });

    await expect(approveStoredPublishBatch(
      batchId,
      manifestHash,
      'operator@example.com',
      [{
        itemId: '44444444-4444-4444-8444-444444444444',
        approved: true,
      }],
    )).resolves.toMatchObject({ id: batchId, status: 'approved' });

    const statements = mocks.query.mock.calls.map(([statement]) => String(statement));
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining("hashtextextended('rednote-bootstrap-batch', 0)"),
      expect.stringContaining('FOR UPDATE'),
      expect.stringContaining('INSERT INTO local_publish_jobs'),
      expect.stringContaining('plan_operator_scheduled_posts'),
      'COMMIT',
    ]));
  });

  it('still supersedes an unsafe old manifest when every current candidate is blocked', async () => {
    const oldId = '22222222-2222-4222-8222-222222222222';
    const newId = '33333333-3333-4333-8333-333333333333';
    const emptyHash =
      '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
    mocks.query.mockImplementation(async (statement: string) => {
      if (statement.includes("SET status = 'superseded'")) {
        return { rows: [batchRow(oldId, 'superseded', 'a'.repeat(64))] };
      }
      if (statement.includes('INSERT INTO rednote_publish_batches')) {
        return { rows: [batchRow(newId, 'pending_approval', emptyHash)] };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(createStoredPublishBatch({
      kind: 'bootstrap',
      manifestHash: emptyHash,
      items: [],
      blockedCandidates: [{
        notionPageId: snapshot.notionPageId,
        headline: snapshot.headline,
        reason: 'Existing scheduled job owns this post.',
      }],
    })).resolves.toMatchObject({
      id: newId,
      manifestHash: emptyHash,
      status: 'pending_approval',
      items: [],
    });
    expect(mocks.query.mock.calls.map(([statement]) => String(statement)))
      .toContain('COMMIT');
  });

  it('exposes recovery evidence only for the exact safe bypass-disabled failure', async () => {
    const batchId = '22222222-2222-4222-8222-222222222222';
    const itemId = '44444444-4444-4444-8444-444444444444';
    const jobId = '55555555-5555-4555-8555-555555555555';
    const hash = 'a'.repeat(64);
    const item = {
      id: itemId,
      batch_id: batchId,
      notion_page_id: snapshot.notionPageId,
      snapshot,
      item_hash: hash,
      state: 'failed',
      dispatch_mode: 'scheduled',
      late_by_seconds: 0,
      invalidation_reason: null,
      local_publish_job_id: jobId,
      recovery_job_id: jobId,
      recovery_job_status: 'failed',
      recovery_job_error_code: 'BOUNDED_BATCH_BYPASS_DISABLED',
      recovery_job_error_message: 'Worker bypass is disabled',
      recovery_job_snapshot: snapshot,
      recovery_claim_attempts: 1,
      recovery_claimed_at: '2026-08-04T17:04:33.424Z',
      recovery_completed_at: '2026-08-04T17:04:33.963Z',
      recovery_staged_at: null,
      recovery_dispatch_authorized_at: null,
      recovery_dispatched_at: null,
      recovery_note_id: null,
      recovery_share_url: null,
      recovery_next_verification_at: null,
      recovery_verified_at: null,
      recovery_reconciled_at: null,
      recovery_verification_attempts: 0,
      recovery_audit_id: null,
      recovery_audit_batch_id: null,
      recovery_audit_manifest_hash: null,
      recovery_audit_item_id: null,
      recovery_audit_item_hash: null,
      recovery_audit_snapshot_revision: null,
      recovery_audit_claim_attempts: null,
      recovery_audit_completed_at: null,
      recovery_audit_recovered_at: null,
      recovery_no_active_ownership: true,
    };
    mocks.sql
      .mockResolvedValueOnce({ rows: [batchRow(batchId, 'approved', hash)] })
      .mockResolvedValueOnce({ rows: [item] });
    await expect(listStoredPublishBatches(batchId)).resolves.toMatchObject([{
      items: [{
        recoveryEvidence: {
          batchId,
          itemId,
          jobId,
          manifestHash: hash,
          itemHash: hash,
          snapshotRevision: snapshot.notionLastEditedTime,
          priorErrorCode: 'BOUNDED_BATCH_BYPASS_DISABLED',
          claimAttempts: 1,
        },
      }],
    }]);

    mocks.sql
      .mockResolvedValueOnce({ rows: [batchRow(batchId, 'approved', hash)] })
      .mockResolvedValueOnce({
        rows: [{
          ...item,
          recovery_job_error_code: 'AMBIGUOUS_CREATOR_UI',
          recovery_job_error_message: 'Could not uniquely identify the image upload mode',
          recovery_claim_attempts: 3,
          recovery_claimed_at: '2026-08-04T19:16:27.900Z',
          recovery_completed_at: '2026-08-04T19:16:28.333669Z',
          recovery_audit_id: '66666666-6666-4666-8666-666666666666',
          recovery_audit_batch_id: batchId,
          recovery_audit_manifest_hash: hash,
          recovery_audit_item_id: itemId,
          recovery_audit_item_hash: hash,
          recovery_audit_snapshot_revision: snapshot.notionLastEditedTime,
          recovery_audit_claim_attempts: 2,
          recovery_audit_completed_at: '2026-08-04T18:35:28.151762Z',
          recovery_audit_recovered_at: '2026-08-04T18:40:00.000Z',
        }],
      });
    await expect(listStoredPublishBatches(batchId)).resolves.toMatchObject([{
      items: [{
        recoveryEvidence: {
          priorErrorCode: 'AMBIGUOUS_CREATOR_UI',
          claimAttempts: 3,
          latestAuditedClaimAttempts: 2,
        },
      }],
    }]);

    mocks.sql
      .mockResolvedValueOnce({ rows: [batchRow(batchId, 'approved', hash)] })
      .mockResolvedValueOnce({
        rows: [{ ...item, recovery_job_error_code: 'STAGING_FAILED' }],
      });
    const unsafe = await listStoredPublishBatches(batchId);
    expect(unsafe[0].items[0].recoveryEvidence).toBeUndefined();

    mocks.sql
      .mockResolvedValueOnce({ rows: [batchRow(batchId, 'approved', hash)] })
      .mockResolvedValueOnce({
        rows: [{
          ...item,
          recovery_audit_id: '66666666-6666-4666-8666-666666666666',
          recovery_audit_batch_id: batchId,
          recovery_audit_manifest_hash: hash,
          recovery_audit_item_id: itemId,
          recovery_audit_item_hash: hash,
          recovery_audit_snapshot_revision: snapshot.notionLastEditedTime,
        }],
      });
    const alreadyAudited = await listStoredPublishBatches(batchId);
    expect(alreadyAudited[0].items[0].recoveryEvidence).toBeUndefined();

    mocks.sql
      .mockResolvedValueOnce({ rows: [batchRow(batchId, 'approved', hash)] })
      .mockResolvedValueOnce({
        rows: [{
          ...item,
          recovery_claim_attempts: 2,
          recovery_claimed_at: '2026-08-04T17:30:08.000Z',
          recovery_completed_at: '2026-08-04T17:30:08.500Z',
          recovery_audit_id: '66666666-6666-4666-8666-666666666666',
          recovery_audit_batch_id: batchId,
          recovery_audit_manifest_hash: hash,
          recovery_audit_item_id: itemId,
          recovery_audit_item_hash: hash,
          recovery_audit_snapshot_revision: snapshot.notionLastEditedTime,
          recovery_audit_claim_attempts: 1,
          recovery_audit_completed_at: '2026-08-04T17:04:33.963Z',
          recovery_audit_recovered_at: '2026-08-04T17:30:00.000Z',
        }],
      });
    await expect(listStoredPublishBatches(batchId)).resolves.toMatchObject([{
      items: [{
        recoveryEvidence: {
          claimAttempts: 2,
          latestAuditedClaimAttempts: 1,
        },
      }],
    }]);

    mocks.sql
      .mockResolvedValueOnce({ rows: [batchRow(batchId, 'approved', hash)] })
      .mockResolvedValueOnce({
        rows: [{
          ...item,
          recovery_job_error_code: 'AMBIGUOUS_CREATOR_UI',
          recovery_job_error_message: 'Could not uniquely identify the image upload mode',
          recovery_claim_attempts: 3,
          recovery_claimed_at: '2026-08-04T19:16:27.900Z',
          recovery_completed_at: '2026-08-04T19:16:28.333669Z',
          recovery_audit_id: '66666666-6666-4666-8666-666666666666',
          recovery_audit_batch_id: batchId,
          recovery_audit_manifest_hash: 'c'.repeat(64),
          recovery_audit_item_id: itemId,
          recovery_audit_item_hash: hash,
          recovery_audit_snapshot_revision: snapshot.notionLastEditedTime,
          recovery_audit_claim_attempts: 2,
          recovery_audit_completed_at: '2026-08-04T18:35:28.151762Z',
          recovery_audit_recovered_at: '2026-08-04T18:40:00.000Z',
        }],
      });
    const changedAudit = await listStoredPublishBatches(batchId);
    expect(changedAudit[0].items[0].recoveryEvidence).toBeUndefined();

    const itemQuery = mocks.sql.mock.calls
      .map(([strings]) => Array.isArray(strings) ? strings.join('') : String(strings))
      .find((statement) => statement.includes('FROM rednote_publish_batch_items AS item'));
    expect(itemQuery).toContain('LEFT JOIN LATERAL');
    expect(itemQuery).toContain('ORDER BY prior_claim_attempts DESC, recovered_at DESC');
    expect(itemQuery).toContain('job.error_message AS recovery_job_error_message');
  });
});

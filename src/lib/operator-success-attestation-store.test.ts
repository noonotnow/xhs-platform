import { beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestHash } from '@/lib/rednote-publish-batches';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  sql: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({
    connect: async () => ({ query: mocks.query, release: mocks.release }),
    query: mocks.query,
  }),
  sql: mocks.sql,
}));

import { attestStoredScheduledAmbiguity } from '@/lib/operator-success-attestation-store';
import { claimTokenDigest } from '@/lib/operator-success-attestation';

const snapshot = {
  notionPageId: 'page',
  headline: 'Day 5',
  title: 'Day 5',
  caption: 'Caption',
  tags: [],
  platform: 'RedNote' as const,
  mediaType: 'image' as const,
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/image.jpg',
  publishAt: '2026-08-05T13:00:00.000Z',
  notionLastEditedTime: '2026-08-05T12:00:00.000Z',
};
const digest = manifestHash(snapshot);
const identity = {
  jobId: '11111111-1111-4111-8111-111111111111',
  pageId: 'page',
  batchId: '22222222-2222-4222-8222-222222222222',
  itemId: '33333333-3333-4333-8333-333333333333',
  snapshotDigest: digest,
  itemHash: digest,
  scheduledAt: snapshot.publishAt,
  claimTokenDigest: claimTokenDigest('44444444-4444-4444-8444-444444444444'),
};

describe('operator success attestation store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockImplementation(async (query: string) => {
      if (query === 'BEGIN' || query === 'COMMIT' || query === 'ROLLBACK') return { rows: [] };
      if (query.includes('FROM local_publish_operator_success_attestations')) return { rows: [] };
      if (query.includes('FROM local_publish_worker_capabilities')) return { rows: [{ ok: 1 }] };
      if (query.includes('FROM local_publish_jobs AS job')) return {
        rows: [{
          job_id: identity.jobId,
          notion_page_id: identity.pageId,
          job_status: 'failed',
          job_snapshot: snapshot,
          claim_token: '44444444-4444-4444-8444-444444444444',
          job_error_code: 'SCHEDULED_DISPATCH_AMBIGUOUS',
          dispatch_authorized_at: '2026-08-05T12:59:00.000Z',
          dispatched_at: null,
          note_id: null,
          share_url: null,
          batch_item_id: identity.itemId,
          item_id: identity.itemId,
          item_job_id: identity.jobId,
          item_state: 'failed',
          item_hash: digest,
          item_snapshot: snapshot,
          dispatch_mode: 'scheduled',
          batch_id: identity.batchId,
          batch_status: 'approved',
          approved_at: '2026-08-04T12:00:00.000Z',
        }],
      };
      if (query.includes('INSERT INTO local_publish_operator_success_attestations')) return {
        rows: [{
          id: '55555555-5555-4555-8555-555555555555',
          revision: 'rednote.operator-success-attestation.v1',
          local_publish_job_id: identity.jobId,
          notion_page_id: identity.pageId,
          batch_id: identity.batchId,
          batch_item_id: identity.itemId,
          snapshot_digest: digest,
          item_hash: digest,
          scheduled_at: snapshot.publishAt,
          claim_token_digest: identity.claimTokenDigest,
          attested_by: 'operator@example.com',
          receipt_status: 'pending',
          receipt_code: null,
          receipt_message: null,
          receipt_note_id: null,
          receipt_share_url: null,
        }],
      };
      if (query.includes('UPDATE rednote_publish_batch_items') ||
          query.includes('UPDATE local_publish_jobs')) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${query}`);
    });
  });

  it('atomically appends the audit, terminalizes both linked rows, and clears the claim', async () => {
    const result = await attestStoredScheduledAmbiguity(identity, 'operator@example.com');
    expect(result.created).toBe(true);
    expect(result.attestation).toMatchObject({
      state: 'operator_attested',
      publicationVerified: false,
    });
    expect(result.release).toMatchObject({
      disposition: 'release_compose_slot',
      dispatchTerminal: true,
      publicationVerified: false,
    });
    expect(result.release.identity).not.toHaveProperty('itemId');
    const statements = mocks.query.mock.calls.map(([query]) => query).join('\n');
    expect(statements).toContain("SET state = 'operator_attested'");
    expect(statements).toContain("SET status = 'operator_attested', claim_token = NULL");
  });

  it('rejects any identity disagreement with the named 409 code', async () => {
    await expect(attestStoredScheduledAmbiguity(
      { ...identity, pageId: 'other-page' },
      'operator@example.com',
    )).rejects.toMatchObject({ code: 'ATTESTATION_IDENTITY_CONFLICT', status: 409 });
  });
});

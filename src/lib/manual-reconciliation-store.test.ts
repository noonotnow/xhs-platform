import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock('@/lib/db', () => ({ sql: mocks.sql }));

import {
  claimDueManualReconciliations,
  deferManualReconciliation,
  failManualReconciliation,
  insertManualReconciliation,
  retryManualReconciliation,
} from '@/lib/manual-reconciliation-store';

const expected = {
  title: 'Final title',
  caption: 'Final caption',
  mediaType: 'video' as const,
};

function row(status: 'queued' | 'verifying' | 'reconciled' | 'failed') {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    notion_page_id: '22222222-2222-4222-8222-222222222222',
    source_local_job_id: '33333333-3333-4333-8333-333333333333',
    requested_note_id: 'note_123',
    requested_share_url: 'https://www.rednote.com/explore/note_123',
    expected_snapshot: expected,
    request_kind: 'notion_only',
    status,
    idempotency_key: '44444444-4444-4444-8444-444444444444',
    claim_token:
      status === 'verifying'
        ? '55555555-5555-4555-8555-555555555555'
        : null,
    claim_attempts: status === 'verifying' ? 1 : 0,
    claimed_at: status === 'verifying' ? '2026-08-03T12:00:00.000Z' : null,
    claim_expires_at: status === 'verifying' ? '2026-08-03T12:30:00.000Z' : null,
    verification_attempts: 0,
    next_attempt_at: '2026-08-03T12:00:00.000Z',
    external_reconciliation_id: null,
    error_code: null,
    error_message: null,
    created_at: '2026-08-03T11:00:00.000Z',
    updated_at: '2026-08-03T12:00:00.000Z',
    completed_at: null,
  };
}

describe('manual reconciliation persistence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serializes creation against publish jobs and preserves failed source audit', async () => {
    mocks.sql.mockResolvedValue({ rows: [row('queued')] });
    await expect(insertManualReconciliation({
      notionPageId: row('queued').notion_page_id,
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
      expected,
      idempotencyKey: row('queued').idempotency_key,
    })).resolves.toMatchObject({
      created: true,
      request: {
        sourceLocalJobId: row('queued').source_local_job_id,
        status: 'queued',
      },
    });
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain('pg_advisory_xact_lock');
    expect(query).toContain("status = 'failed'");
    expect(query).toContain("status NOT IN ('reconciled', 'succeeded', 'failed')");
    expect(query).not.toContain('DELETE');
  });

  it('claims a bounded batch with independent leases and SKIP LOCKED', async () => {
    mocks.sql.mockResolvedValue({ rows: [row('verifying')] });
    await expect(claimDueManualReconciliations(10, 1_800)).resolves.toEqual([{
      id: row('verifying').id,
      notionPageId: row('verifying').notion_page_id,
      kind: 'notion_only',
      noteId: 'note_123',
      shareUrl: 'https://www.rednote.com/explore/note_123',
      expected,
      verificationAttempts: 0,
      claimToken: row('verifying').claim_token,
      claimExpiresAt: '2026-08-03T12:30:00.000Z',
    }]);
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain('FOR UPDATE SKIP LOCKED');
    expect(query).toContain('LIMIT');
    expect(query).toContain('claim_token = gen_random_uuid()');
    expect(query).toContain('claim_attempts >= 12');
    expect(query).toContain('RECONCILIATION_WORKER_UNAVAILABLE');
  });

  it('requeues retryable failures and makes the fourth attempt terminal', async () => {
    mocks.sql.mockResolvedValue({
      rows: [{
        ...row('failed'),
        verification_attempts: 4,
        error_code: 'REDNOTE_NOT_VISIBLE',
        error_message: 'Post is not visible yet',
        completed_at: '2026-08-03T12:01:00.000Z',
      }],
    });
    await expect(deferManualReconciliation(
      row('verifying').id,
      row('verifying').claim_token!,
      'REDNOTE_NOT_VISIBLE',
      'Post is not visible yet',
      [900, 3600, 21600, 86400],
    )).resolves.toMatchObject({ status: 'failed', verificationAttempts: 4 });
    const query = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(query).toContain('verification_attempts + 1 >= 4');
  });

  it('returns an exact failed-result replay after the claim lease closes', async () => {
    const failed = {
      ...row('failed'),
      claim_token: row('verifying').claim_token,
      claim_expires_at: '2026-08-03T12:01:00.000Z',
      error_code: 'NOTION_ERROR',
      error_message: 'Notion unavailable',
      completed_at: '2026-08-03T12:01:00.000Z',
    };
    mocks.sql
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [failed] });

    await expect(failManualReconciliation(
      failed.id,
      failed.claim_token!,
      failed.error_code,
      failed.error_message,
    )).resolves.toMatchObject({
      status: 'failed',
      errorCode: failed.error_code,
    });
  });

  it('returns a conflict when a newer reconciliation is active on retry', async () => {
    mocks.sql
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [row('failed')] })
      .mockResolvedValueOnce({ rows: [{ id: 'newer-request' }] });
    await expect(retryManualReconciliation(
      row('failed').id,
      expected,
    )).rejects.toMatchObject({
      code: 'ACTIVE_RECONCILIATION_EXISTS',
      status: 409,
    });
    const update = (mocks.sql.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(update).toContain('active.status IN');
    expect(update).toContain('active.id != request.id');
  });
});

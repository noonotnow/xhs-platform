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
  sql: vi.fn(),
}));

import { insertManualPostHandling } from '@/lib/manual-post-handling-store';

const input = {
  notionPageId: '11111111-1111-4111-8111-111111111111',
  notionVersion: '2026-08-06T16:00:00.000Z',
  mode: 'published' as const,
  warnings: ['Needs media is still checked'],
  recordedBy: 'admin' as const,
  idempotencyKey: '22222222-2222-4222-8222-222222222222',
};

function result(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function handlingRow() {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    notion_page_id: input.notionPageId,
    notion_last_edited_time: input.notionVersion,
    handling_mode: input.mode,
    receipt_status: 'pending',
    recorded_by: input.recordedBy,
    warnings: input.warnings,
    scheduled_at: null,
    manual_reconciliation_id: null,
    note_id: null,
    share_url: null,
    published_at: null,
    reconciled_at: null,
    idempotency_key: input.idempotencyKey,
    recorded_at: '2026-08-06T16:05:00.000Z',
    updated_at: '2026-08-06T16:05:00.000Z',
  };
}

function configure(
  jobs: unknown[] = [],
  receiptRows: unknown[] = [],
  batchRows: unknown[] = [],
) {
  mocks.query.mockImplementation(async (text: string) => {
    if (text.includes('FROM local_publish_jobs')) return result(jobs);
    if (text.includes('FROM xhs_publish_receipts')) return result(receiptRows);
    if (text.includes('FROM rednote_publish_batch_items')) return result(batchRows);
    if (text.includes('INSERT INTO plan_operator_scheduled_posts')) {
      return result([handlingRow()]);
    }
    return result();
  });
}

describe('manual post handling store', () => {
  beforeEach(() => vi.clearAllMocks());

  it('atomically records handling and quarantines expired automation', async () => {
    configure([{
      id: 'job',
      status: 'claimed',
      claim_expires_at: '2026-01-01T00:00:00.000Z',
      staged_at: null,
      dispatch_authorized_at: null,
      dispatched_at: null,
      note_id: null,
      share_url: null,
      verified_at: null,
      reconciled_at: null,
      success_attestation_id: null,
    }]);
    await expect(insertManualPostHandling(input)).resolves.toMatchObject({
      created: true,
      handling: { receiptStatus: 'pending' },
    });
    const statements = mocks.query.mock.calls.map(([query]) => String(query));
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining('rednote-bootstrap-batch'),
      expect.stringContaining('UPDATE local_publish_jobs'),
      expect.stringContaining('UPDATE rednote_publish_batch_items'),
      expect.stringContaining('INSERT INTO plan_operator_scheduled_posts'),
      'COMMIT',
    ]));
  });

  it('rejects only a live unsafe claim', async () => {
    configure([{
      id: 'job',
      status: 'claimed',
      claim_expires_at: '2099-01-01T00:00:00.000Z',
      staged_at: null,
      dispatch_authorized_at: null,
      dispatched_at: null,
      note_id: null,
      share_url: null,
      verified_at: null,
      reconciled_at: null,
      success_attestation_id: null,
    }]);
    await expect(insertManualPostHandling(input)).rejects.toMatchObject({
      code: 'LIVE_AUTOMATION_OWNERSHIP',
      status: 409,
    });
    expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('supersedes an expired staged job and its abandoned staged batch item', async () => {
    configure([{
      id: 'job',
      status: 'staged',
      claim_expires_at: '2026-01-01T00:00:00.000Z',
      staged_at: '2026-01-01T00:00:00.000Z',
      dispatch_authorized_at: null,
      dispatched_at: null,
      note_id: null,
      share_url: null,
      verified_at: null,
      reconciled_at: null,
      success_attestation_id: null,
    }], [], [{ id: 'item', state: 'staged' }]);

    await expect(insertManualPostHandling(input)).resolves.toMatchObject({
      created: true,
    });
    const statements = mocks.query.mock.calls.map(([query]) => String(query));
    expect(statements.find((value) =>
      value.includes('UPDATE rednote_publish_batch_items')))
      .toContain("'claimed', 'staged'");
  });

  it('rejects incompatible verified publication evidence', async () => {
    configure([], [{ conflict: true }]);
    await expect(insertManualPostHandling(input)).rejects.toMatchObject({
      code: 'VERIFIED_PUBLICATION_EXISTS',
      status: 409,
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { manifestHash } from '@/lib/rednote-publish-batches';

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

import { supersedeAmbiguousLocalAttemptWithManualReceipt } from
  '@/lib/manual-public-receipt-supersession-store';

const snapshot = {
  notionPageId: 'ff813547-96bc-472c-8ec4-c4bcc9c058c0',
  headline: 'Day 5',
  title: 'Day 5',
  caption: 'Caption',
  tags: ['rednote'],
  platform: 'RedNote' as const,
  mediaType: 'video' as const,
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/day-5.mp4',
  publishAt: '2026-08-04T19:30:00.000Z',
  notionLastEditedTime: '2026-08-04T09:44:00.000Z',
};
const request = {
  notionPageId: snapshot.notionPageId,
  expectedNotionVersion: '2026-08-06T18:30:00.000Z',
  jobId: 'a682cbdd-8392-4757-87b3-adb2ae729cfb',
  batchId: 'c05ef8d9-f4a0-4d5e-b75d-a99367ec8305',
  batchItemId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemHash: manifestHash(snapshot),
  snapshotRevision: snapshot.notionLastEditedTime,
  noteId: '6a723ae5000000000f03a000',
  shareUrl: 'https://www.rednote.com/explore/6a723ae5000000000f03a000',
  provenance: 'manual' as const,
};
const input = {
  request,
  expected: {
    title: snapshot.title,
    caption: snapshot.caption,
    mediaType: snapshot.mediaType,
    notionVersion: request.expectedNotionVersion,
    matchFields: ['title', 'caption', 'mediaType'] as
      Array<'title' | 'caption' | 'mediaType'>,
  },
  warnings: [],
  scheduledAt: snapshot.publishAt,
  idempotencyKey: '22222222-2222-4222-8222-222222222222',
  operatorEmail: 'operator@example.com',
};

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: request.jobId,
    notion_page_id: request.notionPageId,
    snapshot,
    status: 'staged',
    claim_token: '33333333-3333-4333-8333-333333333333',
    claim_attempts: 1,
    claim_expires_at: '2026-08-04T20:00:00.000Z',
    staged_at: '2026-08-04T19:15:00.000Z',
    dispatch_authorized_at: '2026-08-04T19:16:00.000Z',
    dispatched_at: null,
    note_id: null,
    share_url: null,
    verified_at: null,
    reconciled_at: null,
    success_attestation_id: null,
    external_disposition_request_id: null,
    error_code: null,
    error_message: null,
    batch_item_id: request.batchItemId,
    claim_expired: true,
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    batch_id: request.batchId,
    batch_status: 'approved',
    manifest_hash: request.manifestHash,
    approved_at: '2026-08-04T18:00:00.000Z',
    item_id: request.batchItemId,
    notion_page_id: request.notionPageId,
    snapshot,
    item_hash: request.itemHash,
    state: 'staged',
    local_publish_job_id: request.jobId,
    ...overrides,
  };
}

function auditRow() {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    idempotency_key: input.idempotencyKey,
    manual_handling_id: '55555555-5555-4555-8555-555555555555',
    manual_reconciliation_id: '66666666-6666-4666-8666-666666666666',
    local_publish_job_id: request.jobId,
    notion_page_id: request.notionPageId,
    batch_id: request.batchId,
    batch_item_id: request.batchItemId,
    manifest_hash: request.manifestHash,
    item_hash: request.itemHash,
    snapshot_revision: request.snapshotRevision,
    canonical_notion_revision: request.expectedNotionVersion,
    requested_note_id: request.noteId,
    requested_share_url: request.shareUrl,
    provenance: 'manual',
    superseded_by: input.operatorEmail,
    superseded_at: '2026-08-07T20:00:00.000Z',
  };
}

function configure(options: {
  jobs?: unknown[];
  evidence?: unknown[];
  receipt?: boolean;
  external?: boolean;
} = {}) {
  mocks.query.mockImplementation(async (text: string) => {
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
      return { rows: [] };
    }
    if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (text.includes('WHERE idempotency_key = $1::uuid')) return { rows: [] };
    if (text.includes('FROM manual_public_receipt_supersessions')) return { rows: [] };
    if (text.includes('FROM plan_operator_scheduled_posts')) return { rows: [] };
    if (text.includes('FROM manual_reconciliation_requests')) return { rows: [] };
    if (text.includes('FROM xhs_publish_receipts')) {
      return { rows: options.receipt ? [{ id: 'receipt' }] : [] };
    }
    if (text.includes('FROM external_post_reconciliations')) {
      return { rows: options.external ? [{ id: 'external' }] : [] };
    }
    if (text.includes('FROM local_publish_jobs')) {
      return { rows: options.jobs ?? [job()] };
    }
    if (text.includes('FROM rednote_publish_batches AS batch')) {
      return { rows: options.evidence ?? [evidence()] };
    }
    if (text.includes('INSERT INTO plan_operator_scheduled_posts')) {
      return { rows: [{ id: auditRow().manual_handling_id }] };
    }
    if (text.includes('INSERT INTO manual_reconciliation_requests')) {
      return { rows: [{ id: auditRow().manual_reconciliation_id }] };
    }
    if (text.includes('INSERT INTO manual_public_receipt_supersessions')) {
      return { rows: [auditRow()] };
    }
    if (text.includes('UPDATE local_publish_jobs')) {
      return { rows: [{ id: request.jobId }], rowCount: 1 };
    }
    if (text.includes('UPDATE rednote_publish_batch_items')) {
      return { rows: [{ id: request.batchItemId }], rowCount: 1 };
    }
    return { rows: [] };
  });
}

describe('manual public receipt supersession store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configure();
  });

  it('atomically audits manual provenance and permanently quarantines one attempt', async () => {
    await expect(
      supersedeAmbiguousLocalAttemptWithManualReceipt(input),
    ).resolves.toMatchObject({
      created: true,
      record: {
        jobId: request.jobId,
        provenance: 'manual',
        reconciliationId: auditRow().manual_reconciliation_id,
      },
    });
    const statements = mocks.query.mock.calls.map(([text]) => String(text));
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO plan_operator_scheduled_posts'),
      expect.stringContaining('INSERT INTO manual_reconciliation_requests'),
      expect.stringContaining('INSERT INTO manual_public_receipt_supersessions'),
      expect.stringContaining('UPDATE local_publish_jobs'),
      expect.stringContaining('UPDATE rednote_publish_batch_items'),
      'COMMIT',
    ]));
    expect(statements.join('\n')).toContain('MANUAL_PUBLIC_RECEIPT_SUPERSESSION');
    expect(statements.join('\n')).toContain("state = 'invalidated'");
    expect(statements.join('\n')).toContain('OR note_id = $2');
    expect(statements.join('\n')).toContain('OR share_url = $3');
    expect(statements.join('\n')).not.toContain('DELETE');
  });

  it('accepts the existing terminal ambiguous equivalent', async () => {
    configure({
      jobs: [job({
        status: 'failed',
        error_code: 'AMBIGUOUS_CREATOR_UI',
        error_message: 'Could not uniquely identify the image upload mode',
      })],
      evidence: [evidence({ state: 'failed' })],
    });
    await expect(
      supersedeAmbiguousLocalAttemptWithManualReceipt(input),
    ).resolves.toMatchObject({ created: true });
  });

  it.each([
    ['active staged claim', { jobs: [job({ claim_expired: false })] },
      'LOCAL_ATTEMPT_NOT_ELIGIBLE'],
    ['existing receipt', { receipt: true }, 'PUBLIC_IDENTITY_EXISTS'],
    ['existing external identity', { external: true }, 'PUBLIC_IDENTITY_EXISTS'],
    ['wrong job page', { jobs: [job({ notion_page_id: 'other-page' })] },
      'LOCAL_ATTEMPT_NOT_ELIGIBLE'],
    ['wrong item hash', { evidence: [evidence({ item_hash: 'c'.repeat(64) })] },
      'SUPERSESSION_EVIDENCE_MISMATCH'],
    ['wrong batch', { evidence: [] }, 'SUPERSESSION_EVIDENCE_MISMATCH'],
    ['dispatched job', { jobs: [job({ dispatched_at: '2026-08-04T19:17:57.159Z' })] },
      'LOCAL_ATTEMPT_NOT_ELIGIBLE'],
    ['job public identity', { jobs: [job({ note_id: request.noteId })] },
      'LOCAL_ATTEMPT_NOT_ELIGIBLE'],
    ['reconciled job ownership', {
      jobs: [
        job(),
        job({
          id: '77777777-7777-4777-8777-777777777777',
          status: 'reconciled',
          note_id: 'other-note-id',
          reconciled_at: '2026-08-05T19:17:57.159Z',
        }),
      ],
    }, 'MANUAL_RECEIPT_SUPERSESSION_CONFLICT'],
  ])('rejects %s', async (_label, options, code) => {
    configure(options);
    await expect(
      supersedeAmbiguousLocalAttemptWithManualReceipt(input),
    ).rejects.toMatchObject({ code, status: 409 });
    expect(mocks.query.mock.calls.map(([text]) => String(text)).join('\n'))
      .not.toContain('INSERT INTO manual_public_receipt_supersessions');
  });

  it('exactly replays the same durable audit', async () => {
    mocks.query.mockImplementation(async (text: string) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return { rows: [] };
      }
      if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (text.includes('WHERE idempotency_key = $1::uuid')) {
        return { rows: [auditRow()] };
      }
      return { rows: [] };
    });
    await expect(
      supersedeAmbiguousLocalAttemptWithManualReceipt(input),
    ).resolves.toMatchObject({ created: false, record: { jobId: request.jobId } });
    expect(mocks.query.mock.calls.map(([text]) => String(text)))
      .not.toEqual(expect.arrayContaining([
        expect.stringContaining('UPDATE local_publish_jobs'),
      ]));
  });
});

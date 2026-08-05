import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  load: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  getPool: () => ({ connect: mocks.connect }),
}));
vi.mock('@/lib/manual-reconciliation-store', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/lib/manual-reconciliation-store')
  >();
  return { ...original, loadManualReconciliation: mocks.load };
});

import {
  completeExternalJobDisposition,
  insertExternalJobDisposition,
  prepareExternalJobDisposition,
  retryExternalJobDisposition,
} from '@/lib/external-job-disposition-store';

const input = {
  notionPageId: 'notion-page',
  localJobId: '11111111-1111-4111-8111-111111111111',
  noteId: 'note_123',
  shareUrl: 'https://www.rednote.com/explore/note_123',
};
const idempotencyKey = '22222222-2222-4222-8222-222222222222';
const claimToken = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const externalId = '55555555-5555-4555-8555-555555555555';
const batchItemId = '66666666-6666-4666-8666-666666666666';
const expected = {
  title: 'Title',
  caption: 'Caption',
  mediaType: 'video' as const,
};
const snapshot = {
  notionPageId: input.notionPageId,
  headline: 'Headline',
  title: expected.title,
  caption: expected.caption,
  tags: ['Tag'],
  platform: 'RedNote' as const,
  mediaType: expected.mediaType,
  mediaIndex: 0,
  mediaUrl: 'https://images.xhs.justlikekatie.com/post.mp4',
  notionLastEditedTime: '2026-08-04T12:00:00.000Z',
};

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: input.localJobId,
    notion_page_id: input.notionPageId,
    snapshot,
    status: 'queued',
    claim_token: null,
    claim_expires_at: null,
    claim_expired: false,
    staged_at: null,
    dispatch_authorized_at: null,
    dispatched_at: null,
    note_id: null,
    share_url: null,
    verified_at: null,
    reconciled_at: null,
    completed_at: null,
    batch_item_id: batchItemId,
    external_disposition_request_id: null,
    success_attestation_id: null,
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    id: requestId,
    notion_page_id: input.notionPageId,
    source_local_job_id: input.localJobId,
    requested_note_id: input.noteId,
    requested_share_url: input.shareUrl,
    expected_snapshot: expected,
    request_kind: 'targeted_local_job',
    status: 'verifying',
    idempotency_key: idempotencyKey,
    claim_token: claimToken,
    claim_valid: true,
    external_reconciliation_id: null,
    ...overrides,
  };
}

function stored(overrides: Record<string, unknown> = {}) {
  return {
    id: requestId,
    notionPageId: input.notionPageId,
    sourceLocalJobId: input.localJobId,
    noteId: input.noteId,
    shareUrl: input.shareUrl,
    expected,
    kind: 'targeted_local_job',
    status: 'queued',
    idempotencyKey,
    claimAttempts: 0,
    verificationAttempts: 0,
    createdAt: '2026-08-04T12:00:00.000Z',
    updatedAt: '2026-08-04T12:00:00.000Z',
    ...overrides,
  };
}

function result(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function queueCreation(options: {
  targetJob?: ReturnType<typeof job>;
  receipts?: unknown[];
  localIdentities?: unknown[];
  requests?: unknown[];
  external?: unknown[];
  batch?: unknown[];
  release?: unknown[];
} = {}) {
  mocks.query
    .mockResolvedValueOnce(result())
    .mockResolvedValueOnce(result([options.targetJob ?? job()]))
    .mockResolvedValueOnce(result())
    .mockResolvedValueOnce(result());
  if (options.targetJob?.status === 'operator_attested') {
    mocks.query.mockResolvedValueOnce(result(options.release ?? [{ released: 1 }]));
  }
  mocks.query
    .mockResolvedValueOnce(result(options.batch ?? [{
      id: batchItemId,
      notion_page_id: input.notionPageId,
      local_publish_job_id: input.localJobId,
      state: options.targetJob?.status ?? 'queued',
    }]))
    .mockResolvedValueOnce(result())
    .mockResolvedValueOnce(result())
    .mockResolvedValueOnce(result(options.receipts ?? []))
    .mockResolvedValueOnce(result(options.localIdentities ?? []))
    .mockResolvedValueOnce(result(options.requests ?? []))
    .mockResolvedValueOnce(result(options.external ?? []));
}

describe('external job disposition persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockReset();
    mocks.query.mockReset();
    mocks.load.mockReset();
    mocks.connect.mockResolvedValue({
      query: mocks.query,
      release: mocks.release,
    });
    mocks.load.mockResolvedValue(stored());
  });

  it('atomically creates ownership for an exact queued job and linked batch item', async () => {
    queueCreation({
      receipts: [{
        notion_page_id: input.notionPageId,
        status: 'published',
        note_id: input.noteId,
        share_url: input.shareUrl,
      }],
    });
    mocks.query
      .mockResolvedValueOnce(result([{ id: requestId }]))
      .mockResolvedValueOnce(result([{ id: input.localJobId }], 1))
      .mockResolvedValueOnce(result());

    await expect(insertExternalJobDisposition(input, idempotencyKey))
      .resolves.toMatchObject({ created: true, request: { id: requestId } });
    const queries = mocks.query.mock.calls.map(([text]) => String(text));
    expect(queries.some((text) => text.includes('FOR UPDATE'))).toBe(true);
    expect(queries.some((text) =>
      text.includes("'targeted_local_job'"))).toBe(true);
    expect(queries.some((text) =>
      text.includes('SET external_disposition_request_id'))).toBe(true);
    expect(queries.some((text) => text.includes('xhs_publish_receipts'))).toBe(true);
  });

  it('accepts an expired claim but rejects active ownership and dispatch evidence', async () => {
    queueCreation({
      targetJob: job({
        status: 'claimed',
        claim_token: claimToken,
        claim_expires_at: '2026-08-04T11:00:00.000Z',
        claim_expired: true,
      }),
      batch: [{
        id: batchItemId,
        notion_page_id: input.notionPageId,
        local_publish_job_id: input.localJobId,
        state: 'claimed',
      }],
    });
    mocks.query
      .mockResolvedValueOnce(result([{ id: requestId }]))
      .mockResolvedValueOnce(result([{ id: input.localJobId }], 1))
      .mockResolvedValueOnce(result());
    await expect(insertExternalJobDisposition(input, idempotencyKey))
      .resolves.toMatchObject({ created: true });

    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([job({
        status: 'claimed',
        claim_expired: false,
      })]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result());
    await expect(insertExternalJobDisposition(input, idempotencyKey))
      .rejects.toMatchObject({ code: 'ACTIVE_DISPATCH_OWNERSHIP' });

    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([job({
        staged_at: '2026-08-04T12:01:00.000Z',
      })]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result());
    await expect(insertExternalJobDisposition(input, idempotencyKey))
      .rejects.toMatchObject({ code: 'DISPOSITION_ALREADY_DISPATCHED' });
  });

  it('blocks operator-attested jobs until release ack and accepts exact released ownership', async () => {
    const targetJob = job({
      status: 'operator_attested',
      staged_at: '2026-08-04T12:01:00.000Z',
      dispatch_authorized_at: '2026-08-04T12:02:00.000Z',
      success_attestation_id: '77777777-7777-4777-8777-777777777777',
    });
    queueCreation({
      targetJob,
      release: [],
      batch: [{
        id: batchItemId,
        notion_page_id: input.notionPageId,
        local_publish_job_id: input.localJobId,
        state: 'operator_attested',
      }],
    });
    await expect(insertExternalJobDisposition(input, idempotencyKey))
      .rejects.toMatchObject({
        code: 'DISPOSITION_RELEASE_REQUIRED',
        status: 409,
      });

    vi.clearAllMocks();
    mocks.query.mockReset();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    queueCreation({
      targetJob,
      release: [{ released: 1 }],
      batch: [{
        id: batchItemId,
        notion_page_id: input.notionPageId,
        local_publish_job_id: input.localJobId,
        state: 'operator_attested',
      }],
    });
    mocks.query
      .mockResolvedValueOnce(result([{ id: requestId }]))
      .mockResolvedValueOnce(result([{ id: input.localJobId }], 1))
      .mockResolvedValueOnce(result());
    await expect(insertExternalJobDisposition(input, idempotencyKey))
      .resolves.toMatchObject({ created: true });
  });

  it.each([
    ['receipt', { receipts: [{
      notion_page_id: input.notionPageId,
      status: 'publishing',
      note_id: null,
      share_url: null,
    }] }, 'DISPOSITION_RECEIPT_CONFLICT'],
    ['identity', { localIdentities: [{ id: 'other-job' }] }, 'DISPOSITION_IDENTITY_CONFLICT'],
    ['batch', { batch: [] }, 'DISPOSITION_BATCH_CONFLICT'],
  ])('rejects a conflicting durable %s', async (_label, options, code) => {
    queueCreation(options);
    mocks.query.mockResolvedValueOnce(result());
    await expect(insertExternalJobDisposition(input, idempotencyKey))
      .rejects.toMatchObject({ code });
  });

  it('returns only an exact idempotent replay', async () => {
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([job({
        external_disposition_request_id: requestId,
      })]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([request({ status: 'queued' })]))
      .mockResolvedValueOnce(result());
    await expect(insertExternalJobDisposition(input, idempotencyKey))
      .resolves.toMatchObject({ created: false });

    vi.clearAllMocks();
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([job({
        external_disposition_request_id: requestId,
      })]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([request({ requested_note_id: 'different' })]))
      .mockResolvedValueOnce(result());
    await expect(insertExternalJobDisposition(input, idempotencyKey))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects a notion-only key reused for a targeted disposition', async () => {
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([job()]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([request({
        request_kind: 'notion_only',
        source_local_job_id: null,
      })]))
      .mockResolvedValueOnce(result());

    await expect(insertExternalJobDisposition(input, idempotencyKey))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('marks the job and batch verified in one transaction before external work', async () => {
    mocks.load.mockResolvedValue(stored({ status: 'verifying' }));
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{
        request_kind: 'targeted_local_job',
        source_local_job_id: input.localJobId,
      }]))
      .mockResolvedValueOnce(result([job({
        external_disposition_request_id: requestId,
      })]))
      .mockResolvedValueOnce(result([request()]))
      .mockResolvedValueOnce(result([{
        id: batchItemId,
        notion_page_id: input.notionPageId,
        local_publish_job_id: input.localJobId,
        state: 'queued',
      }]))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([{ id: batchItemId }], 1))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result());

    await prepareExternalJobDisposition(requestId, claimToken, {
      noteId: input.noteId,
      shareUrl: input.shareUrl,
      ...expected,
    });
    const queries = mocks.query.mock.calls.map(([text]) => String(text));
    const verifyJob = queries.findIndex((text) =>
      text.includes("SET status = 'verified'"));
    const verifyBatch = queries.findIndex((text) =>
      text.includes("SET state = 'verified'"));
    const receipt = queries.findIndex((text) =>
      text.includes('INSERT INTO xhs_publish_receipts'));
    const commit = queries.findIndex((text) => text === 'COMMIT');
    expect(verifyJob).toBeGreaterThan(-1);
    expect(verifyBatch).toBeGreaterThan(verifyJob);
    expect(receipt).toBeGreaterThan(verifyBatch);
    expect(commit).toBeGreaterThan(receipt);
  });

  it('rechecks release ownership before verifying an operator-attested job', async () => {
    mocks.load.mockResolvedValue(stored({ status: 'verifying' }));
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{
        request_kind: 'targeted_local_job',
        source_local_job_id: input.localJobId,
      }]))
      .mockResolvedValueOnce(result([job({
        status: 'operator_attested',
        staged_at: '2026-08-04T12:01:00.000Z',
        dispatch_authorized_at: '2026-08-04T12:02:00.000Z',
        success_attestation_id: '77777777-7777-4777-8777-777777777777',
        external_disposition_request_id: requestId,
      })]))
      .mockResolvedValueOnce(result([request()]))
      .mockResolvedValueOnce(result([{ released: 1 }]))
      .mockResolvedValueOnce(result([{
        id: batchItemId,
        notion_page_id: input.notionPageId,
        local_publish_job_id: input.localJobId,
        state: 'operator_attested',
      }]))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([{ id: batchItemId }], 1))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result());

    await expect(prepareExternalJobDisposition(requestId, claimToken, {
      noteId: input.noteId,
      shareUrl: input.shareUrl,
      ...expected,
    })).resolves.toMatchObject({ status: 'verifying' });
    expect(mocks.query.mock.calls.some(([text]) =>
      String(text).includes('success_attestation_release_acks'))).toBe(true);
  });

  it('atomically completes the verified job, batch item, and request', async () => {
    mocks.load.mockResolvedValue(stored({
      status: 'reconciled',
      externalReconciliationId: externalId,
    }));
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{
        request_kind: 'targeted_local_job',
        source_local_job_id: input.localJobId,
      }]))
      .mockResolvedValueOnce(result([job({
        status: 'verified',
        note_id: input.noteId,
        share_url: input.shareUrl,
        verified_at: '2026-08-04T12:05:00.000Z',
        external_disposition_request_id: requestId,
      })]))
      .mockResolvedValueOnce(result([request()]))
      .mockResolvedValueOnce(result([{
        id: batchItemId,
        notion_page_id: input.notionPageId,
        local_publish_job_id: input.localJobId,
        state: 'verified',
      }]))
      .mockResolvedValueOnce(result([{
        notion_page_id: input.notionPageId,
        status: 'published',
        note_id: input.noteId,
        share_url: input.shareUrl,
      }]))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result([{ id: batchItemId }], 1))
      .mockResolvedValueOnce(result([{ id: requestId }], 1))
      .mockResolvedValueOnce(result());

    await completeExternalJobDisposition(requestId, claimToken, externalId);
    const queries = mocks.query.mock.calls.map(([text]) => String(text));
    expect(queries.some((text) => text.includes("SET status = 'reconciled'"))).toBe(true);
    expect(queries.some((text) => text.includes("SET state = 'reconciled'"))).toBe(true);
    expect(queries.at(-1)).toBe('COMMIT');
  });

  it('does not complete a verified job without its exact publish receipt', async () => {
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{
        request_kind: 'targeted_local_job',
        source_local_job_id: input.localJobId,
      }]))
      .mockResolvedValueOnce(result([job({
        status: 'verified',
        note_id: input.noteId,
        share_url: input.shareUrl,
        verified_at: '2026-08-04T12:05:00.000Z',
        external_disposition_request_id: requestId,
      })]))
      .mockResolvedValueOnce(result([request()]))
      .mockResolvedValueOnce(result([{
        id: batchItemId,
        notion_page_id: input.notionPageId,
        local_publish_job_id: input.localJobId,
        state: 'verified',
      }]))
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result());

    await expect(completeExternalJobDisposition(
      requestId,
      claimToken,
      externalId,
    )).rejects.toMatchObject({ code: 'DISPOSITION_RECEIPT_MISSING' });
    expect(mocks.query.mock.calls.some(([text]) =>
      String(text).includes("SET status = 'reconciled'"))).toBe(false);
  });

  it('requeues only the same safe or verified target after a failed attempt', async () => {
    mocks.load.mockResolvedValue(stored({ status: 'queued' }));
    mocks.query
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result([{
        request_kind: 'targeted_local_job',
        source_local_job_id: input.localJobId,
      }]))
      .mockResolvedValueOnce(result([job({
        status: 'verified',
        note_id: input.noteId,
        share_url: input.shareUrl,
        verified_at: '2026-08-04T12:05:00.000Z',
        external_disposition_request_id: requestId,
      })]))
      .mockResolvedValueOnce(result([request({ status: 'failed' })]))
      .mockResolvedValueOnce(result([{
        id: batchItemId,
        notion_page_id: input.notionPageId,
        local_publish_job_id: input.localJobId,
        state: 'verified',
      }]))
      .mockResolvedValueOnce(result([], 1))
      .mockResolvedValueOnce(result());
    await expect(retryExternalJobDisposition(requestId))
      .resolves.toMatchObject({ status: 'queued' });
  });
});

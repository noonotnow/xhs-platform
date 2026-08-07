import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  supersede: vi.fn(),
  loadReconciliation: vi.fn(),
  getPost: vi.fn(),
}));

vi.mock('@/lib/manual-public-receipt-supersession-store', () => ({
  findManualPublicReceiptSupersessionByIdempotencyKey: mocks.find,
  supersedeAmbiguousLocalAttemptWithManualReceipt: mocks.supersede,
}));
vi.mock('@/lib/manual-reconciliation-store', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/lib/manual-reconciliation-store')
  >();
  return { ...original, loadManualReconciliation: mocks.loadReconciliation };
});
vi.mock('@/lib/notion-posts', () => ({
  getXhsPostForManualHandling: mocks.getPost,
}));

import { createManualPublicReceiptSupersession } from
  '@/lib/manual-public-receipt-supersessions';

const key = '22222222-2222-4222-8222-222222222222';
const body = {
  notionPageId: 'ff813547-96bc-472c-8ec4-c4bcc9c058c0',
  expectedNotionVersion: '2026-08-06T18:30:00.000Z',
  jobId: 'a682cbdd-8392-4757-87b3-adb2ae729cfb',
  batchId: 'c05ef8d9-f4a0-4d5e-b75d-a99367ec8305',
  batchItemId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemHash: 'b'.repeat(64),
  snapshotRevision: '2026-08-04T09:44:00.000Z',
  noteId: '6a723ae5000000000f03a000',
  shareUrl: 'https://www.rednote.com/explore/6a723ae5000000000f03a000',
  provenance: 'manual',
  confirmed: true,
  supersedeAmbiguousWorkerAttempt: true,
};
const record = {
  id: '33333333-3333-4333-8333-333333333333',
  handlingId: '44444444-4444-4444-8444-444444444444',
  reconciliationId: '55555555-5555-4555-8555-555555555555',
  jobId: body.jobId,
  notionPageId: body.notionPageId,
  batchId: body.batchId,
  batchItemId: body.batchItemId,
  manifestHash: body.manifestHash,
  itemHash: body.itemHash,
  snapshotRevision: body.snapshotRevision,
  expectedNotionVersion: body.expectedNotionVersion,
  noteId: body.noteId,
  shareUrl: body.shareUrl,
  provenance: 'manual' as const,
  supersededBy: 'operator@example.com',
  supersededAt: '2026-08-07T20:00:00.000Z',
};
const reconciliation = {
  id: record.reconciliationId,
  notionPageId: body.notionPageId,
  noteId: body.noteId,
  shareUrl: body.shareUrl,
  expected: {
    title: 'Day 5',
    caption: 'Caption',
    mediaType: 'video' as const,
    notionVersion: body.expectedNotionVersion,
    matchFields: ['title', 'caption', 'mediaType'] as const,
  },
  kind: 'notion_only' as const,
  status: 'queued' as const,
  idempotencyKey: key,
  claimAttempts: 0,
  verificationAttempts: 0,
  createdAt: record.supersededAt,
  updatedAt: record.supersededAt,
};

describe('manual public receipt supersession service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.find.mockResolvedValue(null);
    mocks.getPost.mockResolvedValue({
      id: body.notionPageId,
      status: 'Approved',
      lastEditedTime: body.expectedNotionVersion,
      headline: 'Day 5',
      caption: 'Caption',
      hasVideo: true,
      manualWarnings: [],
      publishAt: '2026-08-04T19:30:00.000Z',
    });
    mocks.supersede.mockResolvedValue({ record, created: true });
    mocks.loadReconciliation.mockResolvedValue(reconciliation);
  });

  it('re-reads exact canonical state before creating manual verification work', async () => {
    await expect(createManualPublicReceiptSupersession(
      body,
      key,
      'operator@example.com',
    )).resolves.toMatchObject({
      created: true,
      supersession: { provenance: 'manual', jobId: body.jobId },
      reconciliation: { status: 'queued', noteId: body.noteId },
    });
    expect(mocks.supersede).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        expectedNotionVersion: body.expectedNotionVersion,
        noteId: body.noteId,
      }),
      expected: reconciliation.expected,
      idempotencyKey: key,
      operatorEmail: 'operator@example.com',
    }));
  });

  it('returns an exact replay without re-reading Notion', async () => {
    mocks.find.mockResolvedValue(record);
    await expect(createManualPublicReceiptSupersession(
      body,
      key,
      'operator@example.com',
    )).resolves.toMatchObject({ created: false });
    expect(mocks.getPost).not.toHaveBeenCalled();
    expect(mocks.supersede).not.toHaveBeenCalled();
  });

  it.each([
    ['revision drift', { lastEditedTime: '2026-08-06T18:31:00.000Z' },
      'NOTION_REVISION_CONFLICT'],
    ['Published state', { status: 'Published' }, 'POST_NOT_APPROVED'],
    ['existing note identity', { xhsNoteId: body.noteId }, 'PUBLIC_IDENTITY_EXISTS'],
    ['existing URL identity', { xhsShareUrl: body.shareUrl }, 'PUBLIC_IDENTITY_EXISTS'],
    ['existing Published At', { publishedAt: '2026-08-04T19:17:57.000Z' },
      'PUBLIC_IDENTITY_EXISTS'],
  ])('rejects canonical %s', async (_label, override, code) => {
    mocks.getPost.mockResolvedValueOnce({
      ...(await mocks.getPost()),
      ...override,
    });
    await expect(createManualPublicReceiptSupersession(
      body,
      key,
      'operator@example.com',
    )).rejects.toMatchObject({ code, status: 409 });
    expect(mocks.supersede).not.toHaveBeenCalled();
  });

  it('rejects a replay with different exact job evidence', async () => {
    mocks.find.mockResolvedValue(record);
    await expect(createManualPublicReceiptSupersession({
      ...body,
      itemHash: 'c'.repeat(64),
    }, key, 'operator@example.com')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
    });
  });
});

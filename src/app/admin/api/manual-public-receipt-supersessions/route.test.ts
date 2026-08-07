import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@/lib/xhs-operator-auth', () => ({
  authenticateXhsOperator: mocks.authenticate,
}));
vi.mock('@/lib/manual-public-receipt-supersessions', () => ({
  createManualPublicReceiptSupersession: mocks.create,
}));

import { POST } from
  '@/app/admin/api/manual-public-receipt-supersessions/route';

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

function request() {
  return new NextRequest(
    'https://xhs.justlikekatie.com/admin/api/manual-public-receipt-supersessions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    },
  );
}

describe('manual public receipt supersession Admin route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ email: 'operator@example.com' });
    mocks.create.mockResolvedValue({
      created: true,
      supersession: {
        id: '33333333-3333-4333-8333-333333333333',
        jobId: body.jobId,
        provenance: 'manual',
      },
      reconciliation: {
        id: '44444444-4444-4444-8444-444444444444',
        status: 'queued',
      },
    });
  });

  it('imports the exact route and forwards authenticated operator identity', async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-xhs-admin-api-contract'))
      .toBe('manual-public-receipt-supersessions/v1');
    expect(response.headers.get('x-xhs-state-authority')).toBe('postgresql');
    expect(response.headers.get('x-xhs-local-worker-state')).toBe('excluded');
    await expect(response.json()).resolves.toEqual({
      supersession: {
        id: '33333333-3333-4333-8333-333333333333',
        jobId: body.jobId,
        provenance: 'manual',
      },
      reconciliation: {
        id: '44444444-4444-4444-8444-444444444444',
        status: 'queued',
      },
    });
    expect(mocks.create).toHaveBeenCalledWith(
      body,
      key,
      'operator@example.com',
    );
  });

  it('does not inspect or mutate state when authentication fails', async () => {
    mocks.authenticate.mockRejectedValue(new Error('Unauthorized'));
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

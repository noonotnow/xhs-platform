import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  validateAccess: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@/lib/cloudflare-access', () => ({
  validateCloudflareAccessRequest: mocks.validateAccess,
}));
vi.mock('@/lib/manual-scheduling-attestations', () => ({
  createManualSchedulingAttestation: mocks.create,
}));

import { POST } from '@/app/admin/api/manual-scheduling-attestations/route';

const body = {
  notionPageId: 'notion-page',
  batchId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemId: '22222222-2222-4222-8222-222222222222',
  itemHash: 'b'.repeat(64),
  snapshotRevision: '2026-08-04T13:12:00.000Z',
  requestedPublishAt: '2026-08-06T14:30:00.000Z',
  confirmed: true,
};

function request() {
  return new NextRequest(
    'https://xhs.justlikekatie.com/admin/api/manual-scheduling-attestations',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': '33333333-3333-4333-8333-333333333333',
      },
      body: JSON.stringify(body),
    },
  );
}

describe('manual scheduling attestation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateAccess.mockResolvedValue({ email: 'operator@example.com' });
    mocks.create.mockResolvedValue({
      created: true,
      attestation: { id: 'receipt', provenance: 'manual_scheduled' },
    });
  });

  it('binds authenticated operator and idempotency to exact evidence', async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      body,
      '33333333-3333-4333-8333-333333333333',
      'operator@example.com',
    );
  });

  it('does not invoke storage when authentication fails', async () => {
    mocks.validateAccess.mockRejectedValueOnce(new Error('Unauthorized'));
    expect((await POST(request())).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

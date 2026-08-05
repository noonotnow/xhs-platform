import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  validateAccess: vi.fn(),
  create: vi.fn(),
}));

vi.mock('@/lib/cloudflare-access', () => ({
  validateCloudflareAccessRequest: mocks.validateAccess,
}));
vi.mock('@/lib/operator-success-attestations', () => ({
  createOperatorSuccessAttestation: mocks.create,
}));

import { POST } from '@/app/admin/api/local-publish-job-success-attestations/route';

const body = {
  batchId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
  itemHash: 'b'.repeat(64),
  snapshotRevision: '2026-08-04T13:12:00.000Z',
  requestedPublishAt: '2026-08-06T14:30:00.000Z',
  confirmed: true,
};

function request(payload: unknown = body) {
  return new NextRequest(
    'https://xhs.justlikekatie.com/admin/api/local-publish-job-success-attestations',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': '44444444-4444-4444-8444-444444444444',
      },
      body: JSON.stringify(payload),
    },
  );
}

describe('operator success attestation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateAccess.mockResolvedValue({ email: 'operator@example.com' });
    mocks.create.mockResolvedValue({
      created: true,
      attestation: { id: '55555555-5555-4555-8555-555555555555' },
    });
  });

  it('binds the authenticated actor to exact confirmed evidence', async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(
      body,
      '44444444-4444-4444-8444-444444444444',
      'operator@example.com',
    );
  });

  it('rejects unauthenticated requests before attestation', async () => {
    mocks.validateAccess.mockRejectedValueOnce(new Error('Unauthorized'));
    expect((await POST(request())).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

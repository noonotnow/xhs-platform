import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  validateAccess: vi.fn(),
  recover: vi.fn(),
}));

vi.mock('@/lib/cloudflare-access', () => ({
  validateCloudflareAccessRequest: mocks.validateAccess,
}));
vi.mock('@/lib/rednote-publish-job-recovery-store', () => ({
  recoverStoredApprovedPublishJob: mocks.recover,
}));

import { POST } from '@/app/admin/api/publish-job-recoveries/route';

const body = {
  batchId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
  itemHash: 'b'.repeat(64),
  snapshotRevision: '2026-08-04T13:12:00.000Z',
  confirmed: true,
};

function request(payload: unknown = body) {
  return new NextRequest(
    'https://xhs.justlikekatie.com/admin/api/publish-job-recoveries',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  );
}

describe('approved publish job recovery route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateAccess.mockResolvedValue({ email: 'operator@example.com' });
    mocks.recover.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      jobId: body.jobId,
      alreadyRecovered: false,
    });
  });

  it('authenticates the actor and submits only exact confirmed evidence', async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.recover).toHaveBeenCalledWith(
      {
        batchId: body.batchId,
        manifestHash: body.manifestHash,
        itemId: body.itemId,
        jobId: body.jobId,
        itemHash: body.itemHash,
        snapshotRevision: body.snapshotRevision,
      },
      'operator@example.com',
    );
  });

  it('rejects unauthenticated and non-exact requests before recovery', async () => {
    mocks.validateAccess.mockRejectedValueOnce(new Error('Unauthorized'));
    expect((await POST(request())).status).toBe(401);
    expect(mocks.recover).not.toHaveBeenCalled();

    const response = await POST(request({ ...body, jobId: 'not-a-uuid' }));
    expect(response.status).toBe(400);
    expect(mocks.recover).not.toHaveBeenCalled();
  });
});

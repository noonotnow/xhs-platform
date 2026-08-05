import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ access: vi.fn(), attest: vi.fn() }));
vi.mock('@/lib/cloudflare-access', () => ({ validateCloudflareAccessRequest: mocks.access }));
vi.mock('@/lib/operator-success-attestation-store', () => ({
  attestStoredScheduledAmbiguity: mocks.attest,
}));

import { POST } from '@/app/admin/api/local-publish-job-success-attestations/route';

const identity = {
  jobId: '11111111-1111-4111-8111-111111111111',
  pageId: 'page',
  batchId: '22222222-2222-4222-8222-222222222222',
  itemId: '33333333-3333-4333-8333-333333333333',
  snapshotDigest: 'a'.repeat(64),
  itemHash: 'a'.repeat(64),
  scheduledAt: '2026-08-05T13:00:00.000Z',
  claimTokenDigest: 'b'.repeat(64),
};

describe('operator success attestation route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.mockResolvedValue({ email: 'operator@example.com' });
    mocks.attest.mockResolvedValue({
      created: true,
      attestation: { id: 'id', state: 'operator_attested', publicationVerified: false },
      release: { disposition: 'release_compose_slot', publicationVerified: false },
    });
  });

  it('authenticates and records only exact confirmed evidence', async () => {
    const response = await POST(new NextRequest(
      'https://xhs.justlikekatie.com/admin/api/local-publish-job-success-attestations',
      {
        method: 'POST',
        body: JSON.stringify({
          revision: 'rednote.operator-success-attestation.v1',
          confirmed: true,
          identity,
        }),
      },
    ));
    expect(response.status).toBe(201);
    expect(mocks.attest).toHaveBeenCalledWith(identity, 'operator@example.com');
  });
});

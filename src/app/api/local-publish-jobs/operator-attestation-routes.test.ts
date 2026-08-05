import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  release: vi.fn(),
  receipt: vi.fn(),
  capabilities: vi.fn(),
}));

vi.mock('@/lib/operator-success-attestation-store', () => ({
  getOperatorAttestationRelease: mocks.release,
  recordOperatorAttestedReceipt: mocks.receipt,
  recordLocalPublishWorkerCapabilities: mocks.capabilities,
}));

import { GET as getRelease } from
  '@/app/api/local-publish-jobs/[id]/operator-attestation-release/route';
import { POST as postReceipt } from
  '@/app/api/local-publish-jobs/[id]/operator-attested-receipt/route';

const workerToken = 'worker-token-that-is-at-least-32-characters';
const jobId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const projectedIdentity = {
  jobId,
  pageId: 'page',
  batchId: '33333333-3333-4333-8333-333333333333',
  snapshotDigest: 'a'.repeat(64),
  itemHash: 'a'.repeat(64),
  scheduledAt: '2026-08-05T13:00:00.000Z',
  claimTokenDigest: 'b'.repeat(64),
};

describe('operator attestation worker routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOCAL_PUBLISH_WORKER_TOKEN = workerToken;
  });

  it('returns only the machine-readable release after exact prior-token matching', async () => {
    mocks.release.mockResolvedValue({
      disposition: 'release_compose_slot',
      publicationVerified: false,
      identity: projectedIdentity,
    });
    const response = await getRelease(new NextRequest(
      `https://xhs.justlikekatie.com/api/local-publish-jobs/${jobId}/operator-attestation-release`,
      {
        headers: {
          Authorization: `Bearer ${workerToken}`,
          'X-Local-Publish-Claim-Token': claimToken,
          'X-Local-Publish-Worker-Capabilities': 'rednote.operator-success-attestation.v1',
        },
      },
    ), { params: { id: jobId } });
    expect(response.status).toBe(200);
    expect(mocks.release).toHaveBeenCalledWith(jobId, claimToken);
    await expect(response.json()).resolves.toMatchObject({
      release: { disposition: 'release_compose_slot', publicationVerified: false },
    });
  });

  it('accepts pending receipt reconciliation without a dispatch claim', async () => {
    mocks.receipt.mockResolvedValue({
      state: 'operator_attested',
      verification: 'pending_receipt',
      publicationVerified: false,
    });
    const body = {
      revision: 'rednote.operator-success-attestation.v1',
      attestationId: '44444444-4444-4444-8444-444444444444',
      identity: projectedIdentity,
      result: {
        status: 'pending',
        code: 'RECEIPT_NOT_FOUND',
        message: 'No exact receipt is visible yet',
      },
    };
    const response = await postReceipt(new NextRequest(
      `https://xhs.justlikekatie.com/api/local-publish-jobs/${jobId}/operator-attested-receipt`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${workerToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    ), { params: { id: jobId } });
    expect(response.status).toBe(200);
    expect(mocks.receipt).toHaveBeenCalledWith(jobId, {
      attestationId: body.attestationId,
      identity: projectedIdentity,
      result: body.result,
    });
  });
});

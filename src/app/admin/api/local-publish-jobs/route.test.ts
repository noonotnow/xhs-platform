import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  readOperational: vi.fn(),
  getSummaries: vi.fn(),
  listAttestations: vi.fn(),
  queue: vi.fn(),
}));

vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));
vi.mock('@/lib/rednote-publishing-attempt-store', () => ({
  readRednotePublishingOperational: mocks.readOperational,
}));
vi.mock('@/lib/local-publish-jobs', () => ({
  getLocalPublishJobSummaries: mocks.getSummaries,
  normalizeLocalPublishJobError: (error: Error) => ({
    message: error.message,
    code: 'TEST_ERROR',
    status: 500,
  }),
  queueLocalPublishJob: mocks.queue,
}));
vi.mock('@/lib/operator-success-attestation-store', () => ({
  listOperatorSuccessAttestationEvidence: mocks.listAttestations,
}));

import { GET, POST } from '@/app/admin/api/local-publish-jobs/route';

describe('admin local publish jobs route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOperator.mockResolvedValue(null);
    mocks.readOperational.mockResolvedValue({
      contractVersion: 'publishing-v1',
      queue: [],
      attempts: [],
    });
    mocks.getSummaries.mockResolvedValue([{
      id: '11111111-1111-4111-8111-111111111111',
      notionPageId: 'legacy-post',
      status: 'failed',
      createdAt: '2026-09-08T12:00:00.000Z',
      updatedAt: '2026-09-08T13:00:00.000Z',
      verificationAttempts: 0,
    }]);
    mocks.listAttestations.mockResolvedValue([]);
  });

  it('keeps legacy job arrays beside the operational contract', async () => {
    const response = await GET(new NextRequest(
      'https://xhs.justlikekatie.com/admin/api/local-publish-jobs',
      { headers: { 'X-Workspace-Id': 'legacy-local-publish' } },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contractVersion: 'publishing-v1',
      jobs: [expect.objectContaining({
        notionPageId: 'legacy-post',
        status: 'failed',
      })],
      successAttestationCandidates: [],
    });
    expect(mocks.readOperational).toHaveBeenCalledWith('legacy-local-publish');
    expect(mocks.getSummaries).toHaveBeenCalledWith('legacy-local-publish');
    expect(mocks.listAttestations).toHaveBeenCalledWith('legacy-local-publish');
  });
  it.each([true, false])('reports a reused operation accurately when created=%s', async created => {
    mocks.queue.mockResolvedValue({ created, job: { id: 'job-1', status: 'queued' }, attempt: { id: 'attempt-1' } });
    const response = await POST(new NextRequest('https://test.invalid/admin/api/local-publish-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': 'legacy-local-publish',
        'Idempotency-Key': '22222222-2222-4222-8222-222222222222' },
      body: '{}',
    }));
    expect(response.status).toBe(created ? 201 : 200);
    expect(await response.json()).toEqual({
      job: { id: 'job-1', status: 'queued' },
      attempt: { id: 'attempt-1', state: 'queued' }, replayed: !created,
    });
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it.each([
    { status: 'failed', receiptLookupState: 'not_required', expected: 'failed' },
    { status: 'published', receiptLookupState: 'identity_pending', expected: 'identity_pending' },
  ])('returns canonical replay state without inventing success: $expected', async ({ status, receiptLookupState, expected }) => {
    mocks.queue.mockResolvedValue({
      created: false,
      job: { id: 'job-1', status },
      attempt: { id: 'attempt-1', receiptLookupState },
    });
    const response = await POST(new NextRequest('https://test.invalid/admin/api/local-publish-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Workspace-Id': 'legacy-local-publish',
        'Idempotency-Key': '22222222-2222-4222-8222-222222222222',
      },
      body: '{}',
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      attempt: { id: 'attempt-1', state: expected }, replayed: true,
    });
  });
  it('never queues an unauthorized submission', async () => {
    mocks.requireOperator.mockResolvedValue(new Response(null, { status: 401 }));
    const response = await POST(new NextRequest('https://test.invalid/admin/api/local-publish-jobs', { method: 'POST' }));
    expect(response.status).toBe(401);
    expect(mocks.queue).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  queue: vi.fn(),
  list: vi.fn(),
  claim: vi.fn(),
  authorize: vi.fn(),
  submit: vi.fn(),
}));

vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));

vi.mock('@/lib/local-publish-jobs', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/local-publish-jobs')>();
  return {
    ...original,
    queueLocalPublishJob: mocks.queue,
    getLocalPublishJobSummaries: mocks.list,
    claimNextLocalPublishJob: mocks.claim,
    authorizeLocalPublishJob: mocks.authorize,
    submitLocalPublishJobResult: mocks.submit,
  };
});

import {
  GET as listJobs,
  POST as queueJob,
} from '@/app/admin/api/local-publish-jobs/route';
import { GET as claimJob } from '@/app/api/local-publish-jobs/next/route';
import { GET as authorizeJob } from '@/app/api/local-publish-jobs/[id]/authorization/route';
import { POST as submitResult } from '@/app/api/local-publish-jobs/[id]/result/route';

const workerToken = 'worker-token-that-is-at-least-32-characters';
const jobId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const idempotencyKey = '33333333-3333-4333-8333-333333333333';

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`https://xhs.justlikekatie.com${path}`, init);
}

describe('local publish job routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOCAL_PUBLISH_WORKER_TOKEN = workerToken;
    mocks.requireOperator.mockResolvedValue(null);
    mocks.list.mockResolvedValue([]);
  });

  it('requires operator authentication for all admin job data', async () => {
    mocks.requireOperator.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const response = await listJobs(request('/admin/api/local-publish-jobs'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('queues an operator-confirmed request with the idempotency header', async () => {
    const job = { id: jobId, status: 'queued' };
    mocks.queue.mockResolvedValue({ job, created: true });
    const body = {
      notionPageId: jobId,
      lastEditedTime: '2026-08-01T12:00:00.000Z',
      confirmed: true,
      title: 'Title',
      caption: 'Caption',
      tags: [],
      media: { type: 'video', index: 0 },
    };
    const response = await queueJob(request('/admin/api/local-publish-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    }));

    expect(response.status).toBe(201);
    expect(mocks.queue).toHaveBeenCalledWith(body, idempotencyKey);
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('rejects unauthenticated workers without exposing job data', async () => {
    const response = await claimJob(request('/api/local-publish-jobs/next', {
      headers: { Authorization: 'Bearer wrong-token' },
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('claims one job and requires its rotating token for results', async () => {
    mocks.claim.mockResolvedValue({
      id: jobId,
      claimToken,
      compatibilityTrial: 'unverified_mov',
      publishAt: '2026-08-04T13:30:00.000Z',
    });
    const claimResponse = await claimJob(request('/api/local-publish-jobs/next', {
      headers: { Authorization: `Bearer ${workerToken}` },
    }));
    expect(claimResponse.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith('all');
    await expect(claimResponse.json()).resolves.toMatchObject({
      id: jobId,
      claimToken,
      compatibilityTrial: 'unverified_mov',
      publishAt: '2026-08-04T13:30:00.000Z',
    });

    const result = {
      status: 'failed',
      code: 'STAGING_DISCARDED',
      message: 'Operator discarded staging',
    };
    mocks.submit.mockResolvedValue({ id: jobId, status: 'failed' });
    const resultResponse = await submitResult(
      request(`/api/local-publish-jobs/${jobId}/result`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${workerToken}`,
          'Content-Type': 'application/json',
          'X-Local-Publish-Claim-Token': claimToken,
        },
        body: JSON.stringify(result),
      }),
      { params: { id: jobId } },
    );
    expect(resultResponse.status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledWith(jobId, claimToken, result);
  });

  it('selects an isolated worker lane without changing the response contract', async () => {
    mocks.claim.mockResolvedValue(null);
    const response = await claimJob(request(
      '/api/local-publish-jobs/next?lane=verification',
      { headers: { Authorization: `Bearer ${workerToken}` } },
    ));
    expect(response.status).toBe(204);
    expect(mocks.claim).toHaveBeenCalledWith('verification');
  });

  it('returns the current strict claim for worker reauthorization', async () => {
    const job = {
      id: jobId,
      status: 'staged',
      claimToken,
      batchAuthorization: {
        approvedState: 'approved',
        lateAction: 'schedule',
      },
    };
    mocks.authorize.mockResolvedValue(job);
    const response = await authorizeJob(
      request(`/api/local-publish-jobs/${jobId}/authorization`, {
        headers: {
          Authorization: 'Bearer ' + workerToken,
          'X-Local-Publish-Claim-Token': claimToken,
        },
      }),
      { params: { id: jobId } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.authorize).toHaveBeenCalledWith(jobId, claimToken);
    await expect(response.json()).resolves.toEqual({ job });
  });

  it('rejects unknown worker lanes before claiming', async () => {
    const response = await claimJob(request(
      '/api/local-publish-jobs/next?lane=metrics',
      { headers: { Authorization: `Bearer ${workerToken}` } },
    ));
    expect(response.status).toBe(400);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});

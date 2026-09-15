import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { LocalPublishJobError } from '@/lib/local-publish-job-input';
import exactActivationFixture from '@/contracts/exact-job-activation-v1.json';

const mocks = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  queue: vi.fn(),
  list: vi.fn(),
  claim: vi.fn(),
  claimActivated: vi.fn(),
  authorize: vi.fn(),
  submit: vi.fn(),
  attestationCandidates: vi.fn(),
  heartbeat: vi.fn(),
  fence: vi.fn(),
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
    claimActivatedLocalPublishJob: mocks.claimActivated,
    authorizeLocalPublishJob: mocks.authorize,
    submitLocalPublishJobResult: mocks.submit,
  };
});
vi.mock('@/lib/operator-success-attestation-store', () => ({
  listOperatorSuccessAttestationEvidence: mocks.attestationCandidates,
}));
vi.mock('@/lib/local-publish-worker-heartbeat', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/local-publish-worker-heartbeat')>();
  return { ...original, upsertLocalPublishWorkerHeartbeat: mocks.heartbeat };
});
vi.mock('@/lib/rednote-publishing-attempt-store', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rednote-publishing-attempt-store')>();
  return { ...original, fenceReadyX3SourceMutation: mocks.fence };
});

import {
  GET as listJobs,
  POST as queueJob,
} from '@/app/admin/api/local-publish-jobs/route';
import { GET as claimJob } from '@/app/api/local-publish-jobs/next/route';
import { GET as authorizeJob } from '@/app/api/local-publish-jobs/[id]/authorization/route';
import { POST as submitResult } from '@/app/api/local-publish-jobs/[id]/result/route';
import { POST as workerHeartbeat } from '@/app/api/local-publish-jobs/worker-heartbeat/route';
import { POST as canonicalWorkerHeartbeat } from '@/app/api/local-publish-worker/heartbeat/route';
import { POST as mutationFence } from '@/app/admin/api/local-publish-jobs/mutation-fence/route';

const workerToken = 'worker-token-that-is-at-least-32-characters';
const jobId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const idempotencyKey = '33333333-3333-4333-8333-333333333333';

function exactActivationRequest() {
  return {
    query: {
      ...exactActivationFixture.request,
      contractRevision: exactActivationFixture.contractRevision,
      expectedJobId: jobId,
      activationId: '44444444-4444-4444-8444-444444444444',
      expectedBatchId: '55555555-5555-4555-8555-555555555555',
      expectedItemId: '66666666-6666-4666-8666-666666666666',
      expectedWorkerAttestationId: '77777777-7777-4777-8777-777777777777',
    },
    headers: {
      workspaceId: 'workspace-one',
      claimToken,
      workerId: exactActivationFixture.workerId,
      nonce: 'fixture-activation-nonce-with-at-least-32-bytes',
    },
  };
}

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`https://xhs.justlikekatie.com${path}`, init);
}

describe('local publish job routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOCAL_PUBLISH_WORKER_TOKEN = workerToken;
    mocks.requireOperator.mockResolvedValue(null);
    mocks.list.mockResolvedValue([]);
    mocks.attestationCandidates.mockResolvedValue([]);
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

  it('authenticates and forwards only exact mutation-fence intent', async () => {
    mocks.fence.mockResolvedValue({
      publicationMayHaveStarted: false,
      invalidatedAttemptIds: [jobId],
      invalidatedJobIds: [jobId],
    });
    const response = await mutationFence(request('/admin/api/local-publish-jobs/mutation-fence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': 'workspace-one' },
      body: JSON.stringify({ notionPageId: jobId, lastEditedTime: '2026-08-01T12:00:00.000Z' }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ publicationMayHaveStarted: false });
    expect(mocks.fence).toHaveBeenCalledWith(
      'workspace-one', jobId, '2026-08-01T12:00:00.000Z',
    );
  });

  it('rejects unauthenticated mutation fences without calling durable state', async () => {
    mocks.requireOperator.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const response = await mutationFence(request('/admin/api/local-publish-jobs/mutation-fence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notionPageId: jobId, lastEditedTime: '2026-08-01T12:00:00.000Z' }),
    }));
    expect(response.status).toBe(401);
    expect(mocks.fence).not.toHaveBeenCalled();
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
    expect(await response.json()).toMatchObject({ replayed: false });
  });

  it('marks an identical durable queue response as replayed', async () => {
    const job = { id: jobId, status: 'queued' };
    const attempt = { id: claimToken, state: 'authorized' };
    mocks.queue.mockResolvedValue({ job, attempt, created: false });
    const response = await queueJob(request('/admin/api/local-publish-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        notionPageId: jobId,
        lastEditedTime: '2026-08-01T12:00:00.000Z',
        confirmed: true,
        title: 'Title',
        caption: 'Caption',
        tags: [],
        media: { type: 'video', index: 0 },
      }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ job, attempt, replayed: true });
  });

  it('rejects unauthenticated workers without exposing job data', async () => {
    const response = await claimJob(request('/api/local-publish-jobs/next', {
      headers: { Authorization: 'Bearer wrong-token' },
    }));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('records an authenticated workspace-scoped worker heartbeat without accepting browser data', async () => {
    const body = {
      workerId: 'desktop-worker-1',
      contractRevision: 'publishing-v1',
      compatibilityRevision: 'ready-x3/v1',
      pollingIntervalSeconds: 30,
      lastPollAt: '2026-08-04T13:30:00.000Z',
      nextPollAt: '2026-08-04T13:30:30.000Z',
    };
    mocks.heartbeat.mockResolvedValue({ state: 'online', online: true, id: body.workerId });
    const response = await workerHeartbeat(request('/api/local-publish-jobs/worker-heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${workerToken}`,
        'Content-Type': 'application/json',
        'X-Workspace-Id': 'workspace-1',
      },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    expect(mocks.heartbeat).toHaveBeenCalledWith('workspace-1', body);
    await expect(response.json()).resolves.toEqual({
      heartbeat: { state: 'online', online: true, id: body.workerId },
    });

    const unsafe = await workerHeartbeat(request('/api/local-publish-jobs/worker-heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${workerToken}`,
        'Content-Type': 'application/json',
        'X-Workspace-Id': 'workspace-1',
      },
      body: JSON.stringify({ ...body, browserCookies: 'secret' }),
    }));
    expect(unsafe.status).toBe(400);
    expect(mocks.heartbeat).toHaveBeenCalledOnce();
  });

  it('supports the canonical local-publish-worker heartbeat alias and exact revisions', async () => {
    const body = {
      workerId: 'desktop-worker-1',
      contractRevision: 'publishing-v1',
      compatibilityRevision: 'ready-x3/v1',
      pollingIntervalSeconds: 30,
      lastPollAt: '2026-08-04T13:30:00.000Z',
      nextPollAt: '2026-08-04T13:30:30.000Z',
    };
    mocks.heartbeat.mockResolvedValue({ state: 'online', online: true, id: body.workerId });
    const response = await canonicalWorkerHeartbeat(request('/api/local-publish-worker/heartbeat', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${workerToken}`,
        'Content-Type': 'application/json',
        'X-Workspace-Id': 'workspace-1',
      },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    expect(mocks.heartbeat).toHaveBeenCalledWith('workspace-1', body);
  });

  it('claims one job and requires its rotating token for results', async () => {
    mocks.claim.mockResolvedValue({
      id: jobId,
      claimToken,
      compatibilityTrial: 'unverified_mov',
      publishAt: '2026-08-04T13:30:00.000Z',
    });
    const claimResponse = await claimJob(request('/api/local-publish-jobs/next', {
      headers: {
        Authorization: `Bearer ${workerToken}`,
        'X-Local-Publish-Claim-Token': claimToken,
      },
    }));
    expect(claimResponse.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith('all', undefined, 'legacy-local-publish', claimToken);
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
      { headers: {
        Authorization: `Bearer ${workerToken}`,
        'X-Local-Publish-Claim-Token': claimToken,
      } },
    ));
    expect(response.status).toBe(204);
    expect(mocks.claim).toHaveBeenCalledWith(
      'verification',
      undefined,
      'legacy-local-publish',
      claimToken,
    );
  });

  it('forwards an authenticated exact verification selector without client-side filtering', async () => {
    mocks.claim.mockResolvedValue({
      id: jobId,
      status: 'operator_attested',
      claimToken,
      successAttestation: {
        jobId,
        releaseRequired: true,
        contractRevision: 'operator-success-attestation/v1',
      },
    });

    const response = await claimJob(request(
      `/api/local-publish-jobs/next?lane=verification&expectedJobId=${jobId}`,
      { headers: {
        Authorization: `Bearer ${workerToken}`,
        'X-Local-Publish-Claim-Token': claimToken,
      } },
    ));

    expect(response.status).toBe(200);
    expect(mocks.claim).toHaveBeenCalledWith(
      'verification',
      jobId,
      'legacy-local-publish',
      claimToken,
    );
    await expect(response.json()).resolves.toMatchObject({
      id: jobId,
      status: 'operator_attested',
      successAttestation: {
        jobId,
        releaseRequired: true,
        contractRevision: 'operator-success-attestation/v1',
      },
    });
  });

  it('fails closed when the exact verification job is not claimable', async () => {
    mocks.claim.mockRejectedValue(new LocalPublishJobError(
      'The expected verification job is not currently claimable',
      'EXPECTED_JOB_NOT_CLAIMABLE',
      409,
    ));

    const response = await claimJob(request(
      `/api/local-publish-jobs/next?lane=verification&expectedJobId=${jobId}`,
      { headers: {
        Authorization: `Bearer ${workerToken}`,
        'X-Local-Publish-Claim-Token': claimToken,
      } },
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'The expected verification job is not currently claimable',
      code: 'EXPECTED_JOB_NOT_CLAIMABLE',
    });
  });

  it('forwards only the complete exact dispatch activation tuple', async () => {
      const { query, headers } = exactActivationRequest();
      const exactActivation = {
        contractRevision: exactActivationFixture.contractRevision,
        activationId: query.activationId,
        batchId: query.expectedBatchId,
        itemId: query.expectedItemId,
        jobId: query.expectedJobId,
        manifestHash: query.expectedManifestHash,
        itemHash: query.expectedItemHash,
        sourceRevision: query.expectedSourceRevision,
        releaseId: query.expectedReleaseId,
        workerAttestationId: query.expectedWorkerAttestationId,
      };
      mocks.claimActivated.mockResolvedValue({
        id: query.expectedJobId,
        status: 'claimed',
        claimToken: headers.claimToken,
        exactActivation,
      });
      const search = new URLSearchParams(query);

      const response = await claimJob(request(
        `/api/local-publish-jobs/next?${search}`,
        { headers: {
          Authorization: 'Bearer ' + workerToken,
          'X-Local-Publish-Claim-Token': headers.claimToken,
          'X-Workspace-Id': headers.workspaceId,
          [exactActivationFixture.workerIdHeader]: headers.workerId,
          [exactActivationFixture.activationNonceHeader]: headers.nonce,
        } },
      ));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        id: query.expectedJobId,
        status: 'claimed',
        claimToken: headers.claimToken,
        exactActivation,
      });
      expect(mocks.claimActivated).toHaveBeenCalledWith(
        {
          ...query,
          nonce: headers.nonce,
        },
        headers.workspaceId,
        headers.claimToken,
        headers.workerId,
      );
      expect(mocks.claim).not.toHaveBeenCalled();
    });

    it('never falls back to generic dispatch for partial or rejected activations', async () => {
      const { query, headers } = exactActivationRequest();
      mocks.claimActivated.mockRejectedValue(new LocalPublishJobError(
        'The exact dispatch activation is not claimable',
        'DISPATCH_ACTIVATION_NOT_CLAIMABLE',
        409,
      ));
      const partial = await claimJob(request(
        `/api/local-publish-jobs/next?lane=dispatch&activationId=${query.activationId}`,
        { headers: {
          Authorization: 'Bearer ' + workerToken,
          'X-Workspace-Id': 'workspace-one',
          'X-Local-Publish-Claim-Token': claimToken,
          'X-Local-Publish-Worker-Id': 'worker-one',
        } },
      ));
      const search = new URLSearchParams(query);
      const rejected = await claimJob(request(
        `/api/local-publish-jobs/next?${search}`,
        { headers: {
          Authorization: 'Bearer ' + workerToken,
          'X-Workspace-Id': headers.workspaceId,
          'X-Local-Publish-Claim-Token': headers.claimToken,
          [exactActivationFixture.workerIdHeader]: headers.workerId,
          [exactActivationFixture.activationNonceHeader]: headers.nonce,
        } },
      ));

      expect(partial.status).toBe(400);
      expect(rejected.status).toBe(409);
      expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('rejects query nonce and missing worker identity without claiming', async () => {
    const { query, headers } = exactActivationRequest();
    const search = new URLSearchParams(query);
    search.set('nonce', headers.nonce);
    const queryNonce = await claimJob(request(
      `/api/local-publish-jobs/next?${search}`,
      { headers: {
        Authorization: 'Bearer ' + workerToken,
        'X-Workspace-Id': headers.workspaceId,
        'X-Local-Publish-Claim-Token': headers.claimToken,
        [exactActivationFixture.workerIdHeader]: headers.workerId,
      } },
    ));
    search.delete('nonce');
    const missingWorker = await claimJob(request(
      `/api/local-publish-jobs/next?${search}`,
      { headers: {
        Authorization: 'Bearer ' + workerToken,
        'X-Workspace-Id': headers.workspaceId,
        'X-Local-Publish-Claim-Token': headers.claimToken,
        [exactActivationFixture.activationNonceHeader]: headers.nonce,
      } },
    ));

    expect(queryNonce.status).toBe(400);
    await expect(queryNonce.json()).resolves.toMatchObject({
      code: 'ACTIVATION_NONCE_QUERY_FORBIDDEN',
    });
    expect(missingWorker.status).toBe(400);
    expect(mocks.claimActivated).not.toHaveBeenCalled();
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('rejects malformed, repeated, or non-verification exact selectors before claiming', async () => {
    const malformed = await claimJob(request(
      '/api/local-publish-jobs/next?lane=verification&expectedJobId=not-a-uuid',
      { headers: { Authorization: `Bearer ${workerToken}` } },
    ));
    const repeated = await claimJob(request(
      `/api/local-publish-jobs/next?lane=verification&expectedJobId=${jobId}` +
        `&expectedJobId=${claimToken}`,
      { headers: { Authorization: `Bearer ${workerToken}` } },
    ));
    const wrongLane = await claimJob(request(
      `/api/local-publish-jobs/next?lane=dispatch&expectedJobId=${jobId}`,
      { headers: { Authorization: `Bearer ${workerToken}` } },
    ));

    expect([malformed.status, repeated.status, wrongLane.status]).toEqual([400, 400, 400]);
    expect(mocks.claim).not.toHaveBeenCalled();
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

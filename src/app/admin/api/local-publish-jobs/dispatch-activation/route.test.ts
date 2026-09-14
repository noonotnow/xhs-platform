import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  inspect: vi.fn(),
  prepare: vi.fn(),
  activate: vi.fn(),
  cancel: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperatorIdentity: mocks.auth,
}));

vi.mock('@/lib/local-publish-dispatch-activation', () => ({
  inspectDispatchActivation: mocks.inspect,
  prepareDispatchActivation: mocks.prepare,
  activateDispatchActivation: mocks.activate,
  cancelDispatchActivation: mocks.cancel,
  releaseDispatchActivation: mocks.release,
}));

import { GET, POST } from './route';

const activationId = '11111111-1111-4111-8111-111111111111';
const jobId = '22222222-2222-4222-8222-222222222222';

function request(method: 'GET' | 'POST', body?: unknown) {
  return new NextRequest(
    'http://localhost/admin/api/local-publish-jobs/dispatch-activation',
    {
      method,
      ...(body === undefined
        ? {}
        : {
          body: JSON.stringify(body),
          headers: { 'Content-Type': 'application/json' },
        }),
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ identity: 'operator@example.com' });
});

describe('dispatch activation admin API', () => {
  it('requires authentication and marks the response no-store', async () => {
    mocks.auth.mockResolvedValue({
      response: NextResponse.json(
        { error: 'Unauthorized', code: 'XHS_OPERATOR_AUTH_NOT_SUPPLIED' },
        { status: 401 },
      ),
    });

    const response = await GET(request('GET'));

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('returns safe read-only activation status with no-store headers', async () => {
    mocks.inspect.mockResolvedValue({
      current: null,
      recent: [],
      inventory: {
        queuedBatchJobs: 0,
        failedBatchJobs: 1,
        activeApprovedAttempts: 0,
      },
    });

    const response = await GET(request('GET'));

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.json()).toEqual({
      current: null,
      recent: [],
      inventory: {
        queuedBatchJobs: 0,
        failedBatchJobs: 1,
        activeApprovedAttempts: 0,
      },
    });
  });

  it('requires exact confirmation and forwards authenticated operator identity', async () => {
    const input = {
      action: 'prepare',
      workspaceId: 'workspace-one',
      jobId,
      batchId: '33333333-3333-4333-8333-333333333333',
      itemId: '44444444-4444-4444-8444-444444444444',
      manifestHash: 'a'.repeat(64),
      itemHash: 'b'.repeat(64),
      sourceRevision: '2026-09-08T16:37:00.000Z',
      generation: 1,
      expectedWorkerId: 'worker-release-1',
      expectedWorkerContractRevision: 'publishing-v1',
      expectedWorkerCompatibilityRevision: 'ready-x3/v1',
    };

    const rejected = await POST(request('POST', {
      ...input,
      confirm: 'prepare',
    }));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      code: 'DISPATCH_ACTIVATION_CONFIRMATION_REQUIRED',
    });
    expect(mocks.prepare).not.toHaveBeenCalled();

    mocks.prepare.mockResolvedValue({
      activation: { id: activationId, state: 'prepared' },
      nonce: 'secret-once',
    });
    const accepted = await POST(request('POST', {
      ...input,
      confirm: `PREPARE EXACT DISPATCH ${jobId}`,
    }));
    expect(accepted.status).toBe(201);
    expect(mocks.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-one',
        jobId,
        generation: 1,
      }),
      'operator@example.com',
    );
  });

  it('uses exact confirmation for activate and release', async () => {
    mocks.activate.mockResolvedValue({ id: activationId, state: 'active' });
    mocks.release.mockResolvedValue({ id: activationId, state: 'released' });

    const activated = await POST(request('POST', {
      action: 'activate',
      activationId,
      nonce: 'n'.repeat(43),
      confirm: `ACTIVATE EXACT DISPATCH ${activationId}`,
    }));
    expect(activated.status).toBe(200);
    expect(mocks.activate).toHaveBeenCalledWith(
      activationId,
      'n'.repeat(43),
      'operator@example.com',
    );

    const cancelled = await POST(request('POST', {
      action: 'cancel',
      activationId,
      cancellationReason: 'Prepared nonce was not delivered',
      confirm: `CANCEL EXACT DISPATCH ${activationId}`,
    }));
    expect(cancelled.status).toBe(200);
    expect(mocks.cancel).toHaveBeenCalledWith(
      activationId,
      'operator@example.com',
      'Prepared nonce was not delivered',
    );

    const released = await POST(request('POST', {
      action: 'release',
      activationId,
      releaseReason: 'Worker stopped and verification completed',
      confirm: `RELEASE EXACT DISPATCH ${activationId}`,
    }));
    expect(released.status).toBe(200);
    expect(mocks.release).toHaveBeenCalledWith(
      activationId,
      'operator@example.com',
      'Worker stopped and verification completed',
    );
  });

  it('returns a stable validation error for malformed JSON', async () => {
    const malformed = new NextRequest(
      'http://localhost/admin/api/local-publish-jobs/dispatch-activation',
      {
        method: 'POST',
        body: '{',
        headers: { 'Content-Type': 'application/json' },
      },
    );

    const response = await POST(malformed);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Request body must be valid JSON',
      code: 'VALIDATION_ERROR',
    });
  });
});

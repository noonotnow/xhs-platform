import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  list: vi.fn(),
  retry: vi.fn(),
  claim: vi.fn(),
  submit: vi.fn(),
  requireOperator: vi.fn(),
}));

vi.mock('@/lib/manual-reconciliations', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/lib/manual-reconciliations')
  >();
  return {
    ...original,
    createManualReconciliation: mocks.create,
    getManualReconciliationSummaries: mocks.list,
    retryFailedManualReconciliation: mocks.retry,
    claimManualReconciliations: mocks.claim,
    submitManualReconciliationResult: mocks.submit,
  };
});
vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));

import {
  GET as listManual,
  POST as createManual,
} from '@/app/admin/api/manual-reconciliations/route';
import { POST as retryManual } from '@/app/admin/api/manual-reconciliations/[id]/retry/route';
import { GET as claimDue } from '@/app/api/manual-reconciliations/due/route';
import { POST as submitResult } from '@/app/api/manual-reconciliations/[id]/result/route';

const workerToken = 'worker-token-that-is-at-least-32-characters';
const requestId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const idempotencyKey = '33333333-3333-4333-8333-333333333333';

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`https://xhs.justlikekatie.com${path}`, init);
}

describe('manual reconciliation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOCAL_PUBLISH_WORKER_TOKEN = workerToken;
    mocks.requireOperator.mockResolvedValue(null);
    mocks.list.mockResolvedValue([]);
    mocks.claim.mockResolvedValue([]);
  });

  it('protects Admin initiation and accepts only idempotent confirmed requests', async () => {
    mocks.requireOperator.mockResolvedValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const denied = await createManual(request(
      '/admin/api/manual-reconciliations',
      { method: 'POST' },
    ));
    expect(denied.status).toBe(401);
    expect(denied.headers.get('cache-control')).toContain('no-store');
    expect(mocks.create).not.toHaveBeenCalled();

    mocks.create.mockResolvedValue({
      reconciliation: { id: requestId, status: 'queued' },
      created: true,
    });
    const body = {
      notionPageId: '44444444-4444-4444-8444-444444444444',
      publicPost: 'note_123',
      confirmed: true,
    };
    const response = await createManual(request(
      '/admin/api/manual-reconciliations',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    ));
    expect(response.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith(body, idempotencyKey);
  });

  it('lists and retries safe summaries without exposing claim tokens', async () => {
    mocks.list.mockResolvedValue([{ id: requestId, status: 'failed' }]);
    const listed = await listManual(request('/admin/api/manual-reconciliations'));
    await expect(listed.json()).resolves.toEqual({
      reconciliations: [{ id: requestId, status: 'failed' }],
    });
    mocks.retry.mockResolvedValue({ id: requestId, status: 'queued' });
    const retried = await retryManual(
      request(`/admin/api/manual-reconciliations/${requestId}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true }),
      }),
      { params: { id: requestId } },
    );
    expect(retried.status).toBe(200);
    expect(mocks.retry).toHaveBeenCalledWith(requestId, { confirmed: true });
  });

  it('claims a bounded separate lane and returns an empty 200 envelope', async () => {
    const response = await claimDue(request(
      '/api/manual-reconciliations/due?limit=20',
      { headers: { Authorization: ['Bearer', workerToken].join(' ') } },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ items: [] });
    expect(mocks.claim).toHaveBeenCalledWith(20);
  });

  it('requires the dedicated claim header for worker results', async () => {
    const body = {
      status: 'failed',
      code: 'POST_MISMATCH',
      message: 'The public post does not match the canonical packet',
    };
    const missingClaim = await submitResult(
      request(`/api/manual-reconciliations/${requestId}/result`, {
        method: 'POST',
        headers: {
          Authorization: ['Bearer', workerToken].join(' '),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
      { params: { id: requestId } },
    );
    expect(missingClaim.status).toBe(400);
    expect(mocks.submit).not.toHaveBeenCalled();

    mocks.submit.mockResolvedValue({ id: requestId, status: 'failed' });
    const response = await submitResult(
      request(`/api/manual-reconciliations/${requestId}/result`, {
        method: 'POST',
        headers: {
          Authorization: ['Bearer', workerToken].join(' '),
          'X-Manual-Reconciliation-Claim-Token': claimToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
      { params: { id: requestId } },
    );
    expect(response.status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledWith(requestId, claimToken, body);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  inventory: vi.fn(),
  quarantine: vi.fn(),
  requireOperator: vi.fn(),
}));

vi.mock('@/lib/local-publish-queue-quarantine', () => ({
  inventoryLocalPublishQueue: mocks.inventory,
  quarantineLocalPublishQueue: mocks.quarantine,
}));
vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));

import { GET, POST } from './route';

const inventory = {
  total: 2,
  priorStatusCounts: { queued: 1, staged: 1 },
  activeClaimCount: 1,
  dispatchEvidenceCount: 1,
  jobs: [],
};

function request(method: 'GET' | 'POST', body?: unknown) {
  return new NextRequest(
    'https://xhs.justlikekatie.com/admin/api/local-publish-jobs/quarantine',
    {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': '11111111-1111-4111-8111-111111111111',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

describe('local publish queue quarantine operator route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOperator.mockResolvedValue(null);
    mocks.inventory.mockResolvedValue(inventory);
    mocks.quarantine.mockResolvedValue({
      quarantineId: '22222222-2222-4222-8222-222222222222',
      cutoffAt: '2026-09-08T12:00:00.000Z',
      inventory,
      created: true,
    });
  });

  it('requires operator authentication', async () => {
    mocks.requireOperator.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const response = await GET(request('GET'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.inventory).not.toHaveBeenCalled();
  });

  it('inventories without mutating', async () => {
    const response = await POST(request('POST', {
      confirm: 'QUARANTINE_ALL_EXISTING_LOCAL_PUBLISH_JOBS',
      dryRun: true,
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ dryRun: true, inventory });
    expect(mocks.quarantine).not.toHaveBeenCalled();
  });

  it('rejects inexact confirmation before storage', async () => {
    const response = await POST(request('POST', {
      confirm: 'QUARANTINE',
      dryRun: false,
    }));
    expect(response.status).toBe(400);
    expect(mocks.quarantine).not.toHaveBeenCalled();
  });

  it('returns invalid idempotency keys as operator input errors', async () => {
    const invalid = new NextRequest(
      'https://xhs.justlikekatie.com/admin/api/local-publish-jobs/quarantine',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm: 'QUARANTINE_ALL_EXISTING_LOCAL_PUBLISH_JOBS',
          dryRun: false,
        }),
      },
    );
    const response = await POST(invalid);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: 'INVALID_IDEMPOTENCY_KEY',
    });
    expect(mocks.quarantine).not.toHaveBeenCalled();
  });

  it('applies the idempotent quarantine', async () => {
    const response = await POST(request('POST', {
      confirm: 'QUARANTINE_ALL_EXISTING_LOCAL_PUBLISH_JOBS',
      dryRun: false,
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      dryRun: false,
      created: true,
      inventory,
    });
    expect(mocks.quarantine).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
    );
  });
});

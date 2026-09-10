import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  validateAccess: vi.fn(),
  recover: vi.fn(),
  recoverBrowserClosed: vi.fn(),
}));

vi.mock('@/lib/cloudflare-access', () => ({
  validateCloudflareAccessRequest: mocks.validateAccess,
}));
vi.mock('@/lib/rednote-publish-job-recovery-store', () => ({
  recoverStoredApprovedPublishJob: mocks.recover,
  recoverStoredBrowserClosedPrePublishJob: mocks.recoverBrowserClosed,
}));

import { POST } from '@/app/admin/api/publish-job-recoveries/route';
import {
  BROWSER_CLOSED_PRE_PUBLISH_CONFIRMATION,
} from '@/lib/rednote-publish-job-recovery-contract';

const body = {
  batchId: '11111111-1111-4111-8111-111111111111',
  manifestHash: 'a'.repeat(64),
  itemId: '22222222-2222-4222-8222-222222222222',
  jobId: '33333333-3333-4333-8333-333333333333',
  itemHash: 'b'.repeat(64),
  snapshotRevision: '2026-08-04T13:12:00.000Z',
  confirmed: true,
};

const recovery = {
  id: '44444444-4444-4444-8444-444444444444',
  batchId: body.batchId,
  manifestHash: body.manifestHash,
  itemId: body.itemId,
  jobId: body.jobId,
  itemHash: body.itemHash,
  snapshotRevision: body.snapshotRevision,
  approvedAt: '2026-08-04T13:11:00.000Z',
  recoveredBy: 'operator@example.com',
  recoveredAt: '2026-08-04T13:20:00.000Z',
  priorClaimAttempts: 1,
  alreadyRecovered: false,
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
    mocks.recover.mockResolvedValue(recovery);
    mocks.recoverBrowserClosed.mockResolvedValue(recovery);
  });

  it('authenticates the actor and returns an actor-free normal recovery DTO', async () => {
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
    const json = await response.json();
    expect(json.recovery).toEqual({
      id: recovery.id,
      batchId: recovery.batchId,
      manifestHash: recovery.manifestHash,
      itemId: recovery.itemId,
      jobId: recovery.jobId,
      itemHash: recovery.itemHash,
      snapshotRevision: recovery.snapshotRevision,
      approvedAt: recovery.approvedAt,
      recoveredAt: recovery.recoveredAt,
      priorClaimAttempts: recovery.priorClaimAttempts,
      alreadyRecovered: false,
    });
    expect(json.recovery).not.toHaveProperty('recoveredBy');
    expect(JSON.stringify(json)).not.toContain('operator@example.com');
  });

  it('does not expose either actor during a cross-operator lineage repair', async () => {
    const originalActor = 'original@example.com';
    const repairActor = 'repairer@example.com';
    mocks.validateAccess.mockResolvedValueOnce({ email: repairActor });
    mocks.recover.mockResolvedValueOnce({
      ...recovery,
      recoveredBy: originalActor,
      alreadyRecovered: true,
    });

    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mocks.recover).toHaveBeenCalledWith(expect.any(Object), repairActor);
    const json = await response.json();
    expect(json.recovery).not.toHaveProperty('recoveredBy');
    expect(json.recovery.alreadyRecovered).toBe(true);
    expect(JSON.stringify(json)).not.toContain(originalActor);
    expect(JSON.stringify(json)).not.toContain(repairActor);
  });

  it('routes only the dedicated exact confirmation to browser-closed recovery', async () => {
    const response = await POST(request({
      ...body,
      confirmed: BROWSER_CLOSED_PRE_PUBLISH_CONFIRMATION,
    }));

    expect(response.status).toBe(201);
    expect(mocks.recoverBrowserClosed).toHaveBeenCalledWith(
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
    expect(mocks.recover).not.toHaveBeenCalled();
  });

  it.each([
    'Cloudflare Access assertion is missing',
    'Unauthorized',
  ])('rejects %s before reading recovery evidence', async (message) => {
    mocks.validateAccess.mockRejectedValueOnce(new Error(message));
    expect((await POST(request())).status).toBe(401);
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.validateAccess).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid or actor-spoofing bodies before recovery', async () => {
    const response = await POST(request({ ...body, jobId: 'not-a-uuid' }));
    expect(response.status).toBe(400);
    expect(mocks.recover).not.toHaveBeenCalled();

    const spoofed = await POST(request({
      ...body,
      recoveredBy: 'original@example.com',
    }));
    expect(spoofed.status).toBe(400);
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.recoverBrowserClosed).not.toHaveBeenCalled();

    const genericInternalConfirmation = await POST(request({
      ...body,
      confirmed: 'RECOVER_INTERNAL_ERROR',
    }));
    expect(genericInternalConfirmation.status).toBe(400);
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(mocks.recoverBrowserClosed).not.toHaveBeenCalled();
  });
});

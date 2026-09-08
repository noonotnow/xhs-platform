import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  validateAccess: vi.fn(),
  create: vi.fn(),
  approve: vi.fn(),
  list: vi.fn(),
}));
vi.mock('@/lib/cloudflare-access', () => ({
  validateCloudflareAccessRequest: mocks.validateAccess,
}));
vi.mock('@/lib/rednote-publish-batches', () => ({
  createPublishBatch: mocks.create,
  approvePublishBatch: mocks.approve,
  listPublishBatches: mocks.list,
}));

import { POST } from '@/app/api/xhs/publish-batches/route';

function request(body: unknown) {
  return new NextRequest('https://xhs.justlikekatie.com/api/xhs/publish-batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('publish batch route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.validateAccess.mockResolvedValue({ email: 'operator@example.com' });
    mocks.create.mockResolvedValue({ id: 'batch' });
    mocks.approve.mockResolvedValue({ id: 'batch', status: 'approved' });
  });

  it('builds the Day 16 bootstrap batch from only the explicitly selected card', async () => {
    const missing = await POST(request({ action: 'create', kind: 'bootstrap' }));
    expect(missing.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();

    const selected = await POST(request({
      action: 'create',
      kind: 'bootstrap',
      notionPageIds: ['day-16-page-id'],
    }));
    expect(selected.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith('bootstrap', ['day-16-page-id']);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it('requires a separate confirmed action for the exact frozen manifest', async () => {
    const unconfirmed = await POST(request({
      action: 'approve',
      batchId: 'batch-id',
      manifestHash: 'frozen-manifest-hash',
    }));
    expect(unconfirmed.status).toBe(400);
    expect(mocks.approve).not.toHaveBeenCalled();

    const confirmed = await POST(request({
      action: 'approve',
      batchId: 'batch-id',
      manifestHash: 'frozen-manifest-hash',
      confirmed: true,
    }));
    expect(confirmed.status).toBe(200);
    expect(mocks.approve).toHaveBeenCalledOnce();
    expect(mocks.approve).toHaveBeenCalledWith(
      'batch-id',
      'frozen-manifest-hash',
      'operator@example.com',
    );
  });
});

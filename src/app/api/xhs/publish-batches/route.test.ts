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
  });

  it('requires sparse explicit item selection independent of ScheduledDate', async () => {
    const missing = await POST(request({ action: 'create', kind: 'bootstrap' }));
    expect(missing.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();

    const selected = await POST(request({
      action: 'create',
      kind: 'bootstrap',
      notionPageIds: ['post-page-id'],
    }));
    expect(selected.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith('bootstrap', ['post-page-id']);
  });
});

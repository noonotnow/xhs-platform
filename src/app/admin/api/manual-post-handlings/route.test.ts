import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireOperator: vi.fn(),
  mark: vi.fn(),
  list: vi.fn(),
}));
vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));
vi.mock('@/lib/manual-post-handlings', () => ({
  markManualPostHandled: mocks.mark,
  getManualPostHandlingSummaries: mocks.list,
}));

import { GET, POST } from '@/app/admin/api/manual-post-handlings/route';

const body = {
  notionPageId: '11111111-1111-4111-8111-111111111111',
  expectedLastEditedTime: '2026-08-06T16:00:00.000Z',
  mode: 'scheduled',
};
const key = '22222222-2222-4222-8222-222222222222';

function request(method = 'POST') {
  return new NextRequest('https://xhs.justlikekatie.com/admin/api/manual-post-handlings', {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

describe('manual post handling Admin route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOperator.mockResolvedValue(null);
    mocks.mark.mockResolvedValue({
      created: true,
      handling: { id: 'handling', receiptStatus: 'pending' },
    });
    mocks.list.mockResolvedValue([{ id: 'handling', receiptStatus: 'pending' }]);
  });

  it('records authenticated exact evidence with idempotency', async () => {
    const response = await POST(request());
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.mark).toHaveBeenCalledWith(body, key);
  });

  it('returns durable handling state to authenticated Admin', async () => {
    const response = await GET(request('GET'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      handlings: [{ id: 'handling', receiptStatus: 'pending' }],
    });
  });

  it('does not read or write state when authentication fails', async () => {
    mocks.requireOperator.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    expect((await POST(request())).status).toBe(401);
    expect((await GET(request('GET'))).status).toBe(401);
    expect(mocks.mark).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

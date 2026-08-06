import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  mark: vi.fn(),
  load: vi.fn(),
}));

vi.mock('@/lib/plan-operator-scheduled', () => ({
  markPlanOperatorScheduled: mocks.mark,
}));
vi.mock('@/lib/plan-operator-scheduled-store', () => ({
  loadPlanOperatorScheduledState: mocks.load,
}));

import { GET, POST } from '@/app/api/integrations/plan/operator-scheduled/route';

const token = 'plan-token-that-is-at-least-32-characters';
const key = '22222222-2222-4222-8222-222222222222';
const notionPageId = '11111111-1111-4111-8111-111111111111';
const body = {
  notionPageId,
  expectedNotionVersion: '2026-08-06T16:00:00.000Z',
  expectedScheduledAt: '2026-08-07T14:30:00.000Z',
};

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`https://xhs.justlikekatie.com${path}`, init);
}

describe('PLAN operator-scheduled integration route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PLAN_INTEGRATION_TOKEN = token;
  });

  it('requires the dedicated bearer token without exposing execution state', async () => {
    const response = await POST(request(
      '/api/integrations/plan/operator-scheduled',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong', 'Idempotency-Key': key },
        body: JSON.stringify(body),
      },
    ));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe('Bearer');
    expect(mocks.mark).not.toHaveBeenCalled();
  });

  it('creates and exactly replays the page-level state', async () => {
    const execution = {
      notionPageId,
      state: 'operator_scheduled_receipt_pending',
      scheduledAt: body.expectedScheduledAt,
    };
    mocks.mark
      .mockResolvedValueOnce({ execution, created: true })
      .mockResolvedValueOnce({ execution, created: false });
    const init = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    };
    expect((await POST(request('/api/integrations/plan/operator-scheduled', init))).status)
      .toBe(201);
    expect((await POST(request('/api/integrations/plan/operator-scheduled', init))).status)
      .toBe(200);
    expect(mocks.mark).toHaveBeenNthCalledWith(1, body, key);
  });

  it('reads current execution state by Notion page', async () => {
    mocks.load.mockResolvedValue({
      notionPageId,
      state: 'operator_scheduled_receipt_pending',
      scheduledAt: body.expectedScheduledAt,
    });
    const response = await GET(request(
      `/api/integrations/plan/operator-scheduled?notionPageId=${notionPageId}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      execution: { notionPageId, state: 'operator_scheduled_receipt_pending' },
    });
  });
});

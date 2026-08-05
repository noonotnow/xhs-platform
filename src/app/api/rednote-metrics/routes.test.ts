import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@/lib/rednote-metrics', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rednote-metrics')>();
  return {
    ...original,
    claimDueRednoteMetricPosts: mocks.claim,
    recordRednoteMetricObservations: mocks.record,
  };
});

import { GET as getDue } from '@/app/api/rednote-metrics/due/route';
import { POST as postObservations } from '@/app/api/rednote-metrics/observations/route';

const workerToken = 'worker-token-that-is-at-least-32-characters';

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`https://xhs.justlikekatie.com${path}`, init);
}

describe('RedNote metrics routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOCAL_PUBLISH_WORKER_TOKEN = workerToken;
  });

  it('returns one bounded claim summary rather than per-field responses', async () => {
    mocks.claim.mockResolvedValue([{ notionPageId: 'post-1' }, { notionPageId: 'post-2' }]);
    const response = await getDue(request('/api/rednote-metrics/due?limit=20', {
      headers: { Authorization: `Bearer ${workerToken}` },
    }));
    await expect(response.json()).resolves.toMatchObject({
      items: [{ notionPageId: 'post-1' }, { notionPageId: 'post-2' }],
      summary: { claimed: 2, measured: 0, snapshotsWritten: 0, failures: 0 },
    });
    expect(mocks.claim).toHaveBeenCalledWith(20, false);
  });

  it('returns an empty 200 envelope instead of the lane claim 204 behavior', async () => {
    mocks.claim.mockResolvedValue([]);
    const response = await getDue(request('/api/rednote-metrics/due', {
      headers: { Authorization: `Bearer ${workerToken}` },
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      items: [],
      summary: {
        claimed: 0,
        verified: 0,
        measured: 0,
        snapshotsWritten: 0,
        failures: 0,
      },
    });
  });

  it('returns one consolidated observation summary', async () => {
    mocks.record.mockResolvedValue({
      claimed: 0,
      verified: 0,
      measured: 1,
      snapshotsWritten: 0,
      failures: 0,
    });
    const body = {
      observations: [{
        notionPageId: 'post-1',
        claimToken: '11111111-1111-4111-8111-111111111111',
        observedAt: '2026-08-02T12:00:00.000Z',
        metrics: { views: 1, likes: 1, comments: 0, saves: 0, shares: 0 },
      }],
    };
    const response = await postObservations(request('/api/rednote-metrics/observations', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${workerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      summary: {
        claimed: 0,
        verified: 0,
        measured: 1,
        snapshotsWritten: 0,
        failures: 0,
      },
    });
    expect(mocks.record).toHaveBeenCalledTimes(1);
  });
});

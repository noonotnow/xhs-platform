import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(),
  requireOperator: vi.fn(),
  list: vi.fn(),
}));

vi.mock('@/lib/external-post-reconciliations', () => ({
  reconcileVerifiedExternalPost: mocks.reconcile,
}));
vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));
vi.mock('@/lib/external-post-reconciliation-store', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/lib/external-post-reconciliation-store')
  >();
  return { ...original, listExternalReconciliations: mocks.list };
});

import { POST as reconcileExternal } from './reconcile-external/route';
import { GET as listExternal } from '@/app/admin/api/external-post-reconciliations/route';

const workerToken = 'worker-token-that-is-at-least-32-characters';
const idempotencyKey = '33333333-3333-4333-8333-333333333333';
const body = {
  noteId: 'note_123',
  shareUrl: 'https://www.rednote.com/explore/note_123',
  title: 'Final title',
  caption: 'Final caption',
  mediaType: 'video',
};

function request(path: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`https://xhs.justlikekatie.com${path}`, init);
}

describe('external reconciliation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOCAL_PUBLISH_WORKER_TOKEN = workerToken;
    mocks.requireOperator.mockResolvedValue(null);
    mocks.list.mockResolvedValue([]);
  });

  it('requires worker auth and does not expose reconciliation data', async () => {
    const response = await reconcileExternal(request(
      '/api/local-publish-jobs/reconcile-external',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    ));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.reconcile).not.toHaveBeenCalled();
  });

  it('accepts only a verified, idempotent worker snapshot', async () => {
    mocks.reconcile.mockResolvedValue({
      id: 'receipt',
      status: 'succeeded',
      notionPageId: 'notion-page',
      outcome: 'created',
    });
    const response = await reconcileExternal(request(
      '/api/local-publish-jobs/reconcile-external',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${workerToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify(body),
      },
    ));
    expect(response.status).toBe(200);
    expect(mocks.reconcile).toHaveBeenCalledWith({
      snapshot: body,
      idempotencyKey,
    });
    expect(response.headers.get('cache-control')).toContain('no-store');

    const invalid = await reconcileExternal(request(
      '/api/local-publish-jobs/reconcile-external',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${workerToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ ...body, mediaUrl: 'https://untrusted.example/video.mp4' }),
      },
    ));
    expect(invalid.status).toBe(400);
    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
  });

  it('protects the operator audit endpoint', async () => {
    mocks.requireOperator.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const response = await listExternal(
      request('/admin/api/external-post-reconciliations'),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.list).not.toHaveBeenCalled();
  });
});

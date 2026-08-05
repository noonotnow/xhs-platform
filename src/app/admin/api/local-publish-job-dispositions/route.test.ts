import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

const mocks = vi.hoisted(() => ({
  insert: vi.fn(),
  requireOperator: vi.fn(),
}));

vi.mock('@/lib/external-job-disposition-store', async (importOriginal) => {
  const original = await importOriginal<
    typeof import('@/lib/external-job-disposition-store')
  >();
  return { ...original, insertExternalJobDisposition: mocks.insert };
});
vi.mock('@/lib/xhs-operator-auth', () => ({
  requireXhsOperator: mocks.requireOperator,
}));

import { POST } from './route';

const idempotencyKey = '11111111-1111-4111-8111-111111111111';
const body = {
  notionPageId: 'notion-page',
  localJobId: '22222222-2222-4222-8222-222222222222',
  noteId: 'note_123',
  shareUrl: 'https://www.rednote.com/explore/note_123',
  confirmed: true,
};

function request(value: unknown) {
  return new NextRequest(
    'https://xhs.justlikekatie.com/admin/api/local-publish-job-dispositions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(value),
    },
  );
}

describe('external job disposition operator route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireOperator.mockResolvedValue(null);
    mocks.insert.mockResolvedValue({
      request: {
        id: '33333333-3333-4333-8333-333333333333',
        notionPageId: body.notionPageId,
        sourceLocalJobId: body.localJobId,
        noteId: body.noteId,
        shareUrl: body.shareUrl,
        expected: { title: 'Title', caption: 'Caption', mediaType: 'video' },
        kind: 'targeted_local_job',
        status: 'queued',
        idempotencyKey,
        claimAttempts: 0,
        verificationAttempts: 0,
        createdAt: '2026-08-04T12:00:00.000Z',
        updatedAt: '2026-08-04T12:00:00.000Z',
      },
      created: true,
    });
  });

  it('requires operator authentication and never reaches storage when denied', async () => {
    mocks.requireOperator.mockResolvedValue(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    );
    const response = await POST(request(body));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it('creates the strict disposition tuple with no-store semantics', async () => {
    const response = await POST(request(body));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(response.json()).resolves.toMatchObject({
      disposition: {
        localJobId: body.localJobId,
        status: 'queued',
      },
    });
  });

  it.each(['staged', 'submitted', 'scheduled', 'publishing', 'Published'])(
    'rejects %s dispatch-shaped input before any store or publish operation',
    async (status) => {
      const response = await POST(request({ ...body, status }));
      expect(response.status).toBe(400);
      expect(mocks.insert).not.toHaveBeenCalled();
    },
  );
});

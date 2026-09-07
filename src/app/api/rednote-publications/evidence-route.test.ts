import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  record: vi.fn(),
}));

vi.mock('@/lib/rednote-publication-evidence', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/rednote-publication-evidence')>();
  return {
    ...original,
    readRednotePublicationEvidence: mocks.read,
    recordRednotePublicationEvidence: mocks.record,
  };
});

import {
  GET,
  POST,
} from '@/app/api/rednote-publications/[noteId]/evidence/route';

const workerToken = 'worker-token-that-is-at-least-32-characters';
const context = { params: { noteId: 'note_123' } };

function request(method: 'GET' | 'POST', body?: unknown, authorized = true) {
  return new NextRequest(
    'https://xhs.justlikekatie.com/api/rednote-publications/note_123/evidence',
    {
      method,
      headers: {
        ...(authorized ? { authorization: `Bearer ${workerToken}` } : {}),
        'x-workspace-id': 'workspace-1',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
}

describe('RedNote publication evidence route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LOCAL_PUBLISH_WORKER_TOKEN = workerToken;
  });

  it('requires worker authentication for evidence reads', async () => {
    const response = await GET(request('GET', undefined, false), context);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it('stores token-free xsec refresh evidence', async () => {
    mocks.record.mockResolvedValue({
      noteId: 'note_123',
      xsecAccess: { accessible: true, capturedAt: '2026-08-02T12:00:00.000Z' },
    });
    const response = await POST(request('POST', {
      contractVersion: 'rednote-evidence/v1',
      kind: 'xsec_access',
      capturedAt: '2026-08-02T12:00:00Z',
      accessible: true,
    }), context);
    expect(response.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith('workspace-1', 'note_123', {
      contractVersion: 'rednote-evidence/v1',
      kind: 'xsec_access',
      capturedAt: '2026-08-02T12:00:00.000Z',
      accessible: true,
    });
  });

  it('rejects secret-bearing xsec evidence before persistence', async () => {
    const response = await POST(request('POST', {
      contractVersion: 'rednote-evidence/v1',
      kind: 'xsec_access',
      capturedAt: '2026-08-02T12:00:00Z',
      accessible: true,
      xsecToken: 'secret',
    }), context);
    expect(response.status).toBe(400);
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

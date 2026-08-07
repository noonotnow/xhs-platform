import { afterEach, describe, expect, it, vi } from 'vitest';
import { RednotePublishingError } from '@/lib/rednote-publishing-input';

const publishing = vi.hoisted(() => ({
  createAttempt: vi.fn(),
}));

vi.mock('@/lib/rednote-publishing', () => ({
  createRednoteAttempt: publishing.createAttempt,
}));

import { POST } from './route';

const TOKEN = 'c'.repeat(32);
const KEY = '11111111-1111-4111-8111-111111111111';

function request(body: string, token = TOKEN) {
  return new Request('https://xhs.example/api/integrations/create/rednote-publishing/attempts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Idempotency-Key': KEY,
      'Content-Type': 'application/json',
    },
    body,
  });
}

describe('CREATE Rednote attempt route', () => {
  afterEach(() => {
    delete process.env.CREATE_INTEGRATION_TOKEN;
    vi.clearAllMocks();
  });

  it('returns 201 for creation and 200 for exact replay', async () => {
    process.env.CREATE_INTEGRATION_TOKEN = TOKEN;
    publishing.createAttempt
      .mockResolvedValueOnce({ attempt: { id: 'attempt-1' }, created: true })
      .mockResolvedValueOnce({ attempt: { id: 'attempt-1' }, created: false });

    const created = await POST(request('{}'));
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('no-store');
    expect(await created.json()).toMatchObject({ created: true });

    const replay = await POST(request('{}'));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ created: false });
    expect(publishing.createAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: KEY,
        principal: {
          requester: 'create',
          actorId: 'create-integration',
        },
      }),
    );
  });

  it('returns structured malformed JSON and auth errors', async () => {
    process.env.CREATE_INTEGRATION_TOKEN = TOKEN;
    const malformed = await POST(request('{'));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      error: 'Request body must be valid JSON',
      code: 'REDNOTE_REQUEST_INVALID',
    });

    const unauthorized = await POST(request('{}', 'wrong'));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('surfaces disabled creation without changing existing writers', async () => {
    process.env.CREATE_INTEGRATION_TOKEN = TOKEN;
    publishing.createAttempt.mockRejectedValue(new RednotePublishingError(
      'The Rednote publishing control plane is disabled',
      'REDNOTE_CONTROL_PLANE_DISABLED',
      503,
    ));
    const response = await POST(request('{}'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'REDNOTE_CONTROL_PLANE_DISABLED',
    });
  });
});

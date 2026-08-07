import { afterEach, describe, expect, it, vi } from 'vitest';
import { RednotePublishingError } from '@/lib/rednote-publishing-input';

const publishing = vi.hoisted(() => ({
  claimAttempt: vi.fn(),
}));

vi.mock('@/lib/rednote-publishing', () => ({
  claimRednoteAttempt: publishing.claimAttempt,
}));

import { POST } from './route';

const TOKEN = 'w'.repeat(32);
const ATTEMPT_ID = '11111111-1111-4111-8111-111111111111';

function request() {
  return new Request(`https://xhs.example/api/rednote-publishing/attempts/${ATTEMPT_ID}/claim`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      expectedActiveAttemptId: null,
      workerRunId: 'worker-run-1',
      occurredAt: '2026-08-07T16:00:00.000Z',
    }),
  });
}

describe('Rednote worker claim route', () => {
  afterEach(() => {
    delete process.env.LOCAL_PUBLISH_WORKER_TOKEN;
    vi.clearAllMocks();
  });

  it('binds the trusted worker and exact route attempt', async () => {
    process.env.LOCAL_PUBLISH_WORKER_TOKEN = TOKEN;
    publishing.claimAttempt.mockResolvedValue({
      attempt: { id: ATTEMPT_ID, active: true },
    });
    const response = await POST(request(), { params: { id: ATTEMPT_ID } });
    expect(response.status).toBe(200);
    expect(publishing.claimAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        attemptId: ATTEMPT_ID,
        principal: {
          requester: 'worker',
          actorId: 'local-publish-worker',
        },
      }),
    );
  });

  it('fails closed when Posts projection is unavailable', async () => {
    process.env.LOCAL_PUBLISH_WORKER_TOKEN = TOKEN;
    publishing.claimAttempt.mockRejectedValue(new RednotePublishingError(
      'Notion is unavailable',
      'REDNOTE_NOTION_UNAVAILABLE',
      503,
    ));
    const response = await POST(request(), { params: { id: ATTEMPT_ID } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'REDNOTE_NOTION_UNAVAILABLE',
    });
  });
});

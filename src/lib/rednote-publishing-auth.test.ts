import { afterEach, describe, expect, it, vi } from 'vitest';

const access = vi.hoisted(() => ({
  validate: vi.fn(),
}));

vi.mock('@/lib/cloudflare-access', () => ({
  validateCloudflareAccessRequest: access.validate,
}));

import {
  requireRednoteAdmin,
  requireRednoteCreate,
  requireRednotePlan,
  requireRednoteWorker,
} from '@/lib/rednote-publishing-auth';

const CREATE = 'c'.repeat(32);
const PLAN = 'p'.repeat(32);
const WORKER = 'w'.repeat(32);

describe('Rednote publishing authentication', () => {
  afterEach(() => {
    delete process.env.CREATE_INTEGRATION_TOKEN;
    delete process.env.PLAN_INTEGRATION_TOKEN;
    delete process.env.LOCAL_PUBLISH_WORKER_TOKEN;
    vi.clearAllMocks();
  });

  it('keeps CREATE, PLAN, and worker credentials separate', () => {
    process.env.CREATE_INTEGRATION_TOKEN = CREATE;
    process.env.PLAN_INTEGRATION_TOKEN = PLAN;
    process.env.LOCAL_PUBLISH_WORKER_TOKEN = WORKER;

    expect(requireRednoteCreate(`Bearer ${CREATE}`)).toEqual({
      requester: 'create',
      actorId: 'create-integration',
    });
    expect(requireRednotePlan(`Bearer ${PLAN}`)).toEqual({
      requester: 'plan',
      actorId: 'plan-integration',
    });
    expect(requireRednoteWorker(`Bearer ${WORKER}`)).toEqual({
      requester: 'worker',
      actorId: 'local-publish-worker',
    });
    expect(() => requireRednoteCreate(`Bearer ${PLAN}`)).toThrowError(
      expect.objectContaining({ code: 'UNAUTHORIZED', status: 401 }),
    );
  });

  it('fails closed when a bearer capability is not configured', () => {
    expect(() => requireRednoteCreate(`Bearer ${CREATE}`)).toThrowError(
      expect.objectContaining({
        code: 'REDNOTE_AUTH_NOT_CONFIGURED',
        status: 503,
      }),
    );
  });

  it('binds the verified Cloudflare Access email', async () => {
    access.validate.mockResolvedValue({ email: 'operator@example.com' });
    const request = new Request('https://xhs.example/admin');
    await expect(requireRednoteAdmin(request)).resolves.toEqual({
      requester: 'admin',
      actorId: 'operator@example.com',
    });
  });
});

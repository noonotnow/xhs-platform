import { afterEach, describe, expect, it } from 'vitest';
import {
  isLocalPublishWorkerAuthorized,
  requireLocalPublishWorker,
} from '@/lib/local-publish-worker-auth';

describe('local publish worker authentication', () => {
  afterEach(() => delete process.env.LOCAL_PUBLISH_WORKER_TOKEN);

  it('accepts only the exact server-side bearer token', () => {
    process.env.LOCAL_PUBLISH_WORKER_TOKEN = 'worker-token-that-is-at-least-32-characters';
    expect(isLocalPublishWorkerAuthorized(
      'Bearer worker-token-that-is-at-least-32-characters',
    )).toBe(true);
    expect(isLocalPublishWorkerAuthorized('Bearer wrong')).toBe(false);
    expect(isLocalPublishWorkerAuthorized(null)).toBe(false);
  });

  it('fails closed when the worker token is not safely configured', () => {
    expect(() => requireLocalPublishWorker('Bearer anything')).toThrow(
      'authentication is not configured',
    );
  });
});

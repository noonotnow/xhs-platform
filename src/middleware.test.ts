import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const validateCloudflareAccessRequest = vi.hoisted(() => vi.fn());

vi.mock('@/lib/cloudflare-access', () => ({
  validateCloudflareAccessRequest,
}));

import { middleware } from '@/middleware';

beforeEach(() => {
  vi.unstubAllEnvs();
  validateCloudflareAccessRequest.mockReset();
});

describe('admin middleware', () => {
  it('lets route-authenticated machine APIs reach their handlers', async () => {
    const response = await middleware(new NextRequest(
      'https://xhs.justlikekatie.com/admin/api/local-publish-jobs',
    ));

    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(validateCloudflareAccessRequest).not.toHaveBeenCalled();
  });

  it('keeps the human admin UI behind Cloudflare identity validation', async () => {
    validateCloudflareAccessRequest.mockResolvedValue({ email: 'operator@example.com' });

    await middleware(new NextRequest('https://xhs.justlikekatie.com/admin'));

    expect(validateCloudflareAccessRequest).toHaveBeenCalledTimes(1);
  });

  it('accepts the configured same-origin browser-test cookie outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('XHS_BROWSER_TEST_COOKIE', 'local-playwright-admin');

    const response = await middleware(new NextRequest(
      'http://127.0.0.1:3119/admin',
      { headers: { Cookie: '__xhs_browser_test=local-playwright-admin' } },
    ));

    expect(response.headers.get('x-middleware-next')).toBe('1');
    expect(validateCloudflareAccessRequest).not.toHaveBeenCalled();
  });

  it('ignores the browser-test cookie in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('XHS_BROWSER_TEST_COOKIE', 'local-playwright-admin');
    validateCloudflareAccessRequest.mockRejectedValue(new Error('invalid access assertion'));

    const response = await middleware(new NextRequest(
      'https://xhs.justlikekatie.com/admin',
      { headers: { Cookie: '__xhs_browser_test=local-playwright-admin' } },
    ));

    expect(response.status).toBe(401);
    expect(validateCloudflareAccessRequest).toHaveBeenCalledTimes(1);
  });
});
    
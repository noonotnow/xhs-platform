import { beforeEach, describe, expect, it, vi } from 'vitest';
    import { NextRequest } from 'next/server';

    const validateCloudflareAccessRequest = vi.hoisted(() => vi.fn());

    vi.mock('@/lib/cloudflare-access', () => ({
    validateCloudflareAccessRequest,
    }));

    import { middleware } from '@/middleware';

    beforeEach(() => {
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
    });
    
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

    const validateCloudflareAccessRequest = vi.hoisted(() => vi.fn());

    vi.mock('@/lib/cloudflare-access', () => ({
    validateCloudflareAccessRequest,
    }));

    import { requireXhsOperator } from '@/lib/xhs-operator-auth';

    beforeEach(() => {
    vi.stubEnv('XHS_PLATFORM_API_TOKEN', 'server-held-token');
    validateCloudflareAccessRequest.mockReset();
    });

    afterEach(() => {
    vi.unstubAllEnvs();
    });

    describe('XHS operator authentication', () => {
    it('accepts the dedicated server-only operator header', async () => {
      const result = await requireXhsOperator({
        headers: new Headers({ 'X-XHS-Operator-Token': 'server-held-token' }),
      });

      expect(result).toBeNull();
      expect(validateCloudflareAccessRequest).not.toHaveBeenCalled();
    });
    });
    
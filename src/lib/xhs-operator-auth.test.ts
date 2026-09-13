import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const validateCloudflareAccessRequest = vi.hoisted(() => vi.fn());

vi.mock('@/lib/cloudflare-access', () => ({
  validateCloudflareAccessRequest,
}));

import { requireXhsOperator } from '@/lib/xhs-operator-auth';

beforeEach(() => {
  vi.stubEnv('XHS_PLATFORM_OPERATOR_TOKEN', '');
  vi.stubEnv('XHS_PLATFORM_API_TOKEN', 'server-held-token');
  vi.stubEnv('XHS_PLATFORM_ACCEPTANCE_TOKEN', '');
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

  it('accepts the API token when a different operator token is configured', async () => {
    vi.stubEnv('XHS_PLATFORM_OPERATOR_TOKEN', 'existing-operator-token');

    const result = await requireXhsOperator({
      headers: new Headers({ Authorization: 'Bearer server-held-token' }),
    });

    expect(result).toBeNull();
    expect(validateCloudflareAccessRequest).not.toHaveBeenCalled();
  });

  it('continues to accept the existing operator token', async () => {
    vi.stubEnv('XHS_PLATFORM_OPERATOR_TOKEN', 'existing-operator-token');

    const result = await requireXhsOperator({
      headers: new Headers({ Authorization: 'Bearer existing-operator-token' }),
    });

    expect(result).toBeNull();
    expect(validateCloudflareAccessRequest).not.toHaveBeenCalled();
  });

  it('accepts a separate acceptance token without replacing existing tokens', async () => {
    vi.stubEnv('XHS_PLATFORM_OPERATOR_TOKEN', 'existing-operator-token');
    vi.stubEnv('XHS_PLATFORM_API_TOKEN', 'existing-api-token');
    vi.stubEnv('XHS_PLATFORM_ACCEPTANCE_TOKEN', 'acceptance-token');

    const result = await requireXhsOperator({
      headers: new Headers({ Authorization: 'Bearer acceptance-token' }),
    });

    expect(result).toBeNull();
    expect(validateCloudflareAccessRequest).not.toHaveBeenCalled();
  });
});
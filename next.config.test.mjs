import { describe, expect, it } from 'vitest';
import nextConfig from './next.config.mjs';

describe('protected admin rewrites', () => {
  it('maps admin browser paths to the existing authenticated XHS handlers', async () => {
    const rewrites = await nextConfig.rewrites();

    expect(rewrites.beforeFiles).toEqual([
      {
        source: '/admin/api/ready-posts',
        destination: '/api/xhs/ready-posts',
      },
      {
        source: '/admin/api/ready-posts/:path*',
        destination: '/api/xhs/ready-posts/:path*',
      },
      {
        source: '/admin/api/xhs/:path*',
        destination: '/api/xhs/:path*',
      },
      {
        source: '/admin/api/publish-batches',
        destination: '/api/xhs/publish-batches',
      },
    ]);
  });
});

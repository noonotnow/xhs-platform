/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Enables src/instrumentation.ts, which runs DB migrations at server
    // startup before the first request is handled.
    instrumentationHook: true,
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.xhs.justlikekatie.com',
      },
    ],
  },
  async rewrites() {
    return {
      beforeFiles: [
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
      ],
    };
  },
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'images.xhs.justlikekatie.com',
      },
    ],
  },
  outputFileTracingIncludes: {
    '/admin/api/local-publish-jobs/schema-readiness': ['./migrations/*.sql'],
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
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
};

export default nextConfig;

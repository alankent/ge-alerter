import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Fully static: hosted on Firebase Hosting, all state lives in Firebase.
  output: 'export',
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default nextConfig;

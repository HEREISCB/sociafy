import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16 blocks dev resources (HMR, fonts, chunks) when the origin isn't
  // localhost. Tunnels and ngrok URLs need to be allowlisted explicitly.
  allowedDevOrigins: [
    'winqc.velinaai.in',
    '*.velinaai.in',
    '*.trycloudflare.com',
    '*.ngrok-free.app',
    '*.ngrok.io',
  ],
};

export default nextConfig;

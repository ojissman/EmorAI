import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Allow the sandbox preview tunnel domain to fetch dev assets / HMR.
  allowedDevOrigins: ["*.space-z.ai"],
};

export default nextConfig;

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingRoot: process.cwd().replace(/[\\/]packages[\\/]web$/, ""),
  transpilePackages: ["@interview-prep/core"],
};

export default nextConfig;

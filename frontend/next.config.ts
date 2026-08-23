import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Monorepo: dependencies are hoisted to the repo root (where bun.lock
  // lives), so Turbopack's filesystem root must include it or `next`,
  // react, and workspace packages fail to resolve.
  turbopack: {
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;

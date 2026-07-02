import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained production build for the Docker image (dockerfiles/prod.dockerfile).
  output: "standalone",
};

export default nextConfig;

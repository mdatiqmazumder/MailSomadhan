import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const apiTarget = process.env.API_PROXY || "http://127.0.0.1:18080";

const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  reactStrictMode: true,
  // In production nginx routes /api to the backend; this rewrite only matters for `npm run dev`.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiTarget}/api/:path*` }];
  },
};

export default nextConfig;

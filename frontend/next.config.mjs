import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const apiTarget = process.env.API_PROXY || "http://127.0.0.1:18080";
const dev = process.env.NODE_ENV !== "production";

// Content-Security-Policy for every page. Email bodies are shown in sandboxed srcdoc iframes,
// which inherit this policy (plus their own stricter one); remote images inside mail are only
// loaded after the reader clicks "Show images", hence img-src https:/http:.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`, // Next.js inline bootstrap scripts
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  // Firebase Cloud Messaging registers the browser for new-mail notifications from these two hosts.
  `connect-src 'self' https://firebaseinstallations.googleapis.com https://fcmregistrations.googleapis.com${dev ? " ws:" : ""}`,
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

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
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;

// next.config.mjs

/** @type {import('next').NextConfig} */
// Where the web app's server reaches the API. A packaged install sets BACKEND_INTERNAL_URL (the browser-facing
// address in NEXT_PUBLIC_API_BASE is then the public one); everything else keeps using NEXT_PUBLIC_API_BASE.
const backend = (process.env.BACKEND_INTERNAL_URL || process.env.NEXT_PUBLIC_API_BASE || "http://localhost:3001").replace(/\/+$/, "");

const nextConfig = {
  // The packaged install runs the small self-contained server this produces.
  ...(process.env.RIQ_STANDALONE === "1" ? { output: "standalone" } : {}),
  // Only HTTP rewrites (no ws://)
  async rewrites() {
    return [
      // Proxy REST API to the Nest backend
      { source: "/api/:path*", destination: `${backend}/api/:path*` },

      // Serve uploaded files from the backend's static mount
      { source: "/static/:path*", destination: `${backend}/static/:path*` },
    ];
  },
  // Browser hardening for every page. The app is never shown inside another site's frame (clickjacking), and it uses no camera,
  // microphone or location (the remote console only draws the remote screen and uses the clipboard, which stays allowed).
  // The CSP holds only frame-ancestors: a full policy would block the inline scripts Next and the branding boot rely on.
  // HSTS is left to the reverse proxy that terminates TLS.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;

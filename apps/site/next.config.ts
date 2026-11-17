import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { securityHeaders } from "./lib/security-headers.ts";

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

const config: NextConfig = {
  turbopack: { root: workspaceRoot },
  outputFileTracingRoot: workspaceRoot,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders(process.env.NODE_ENV !== "production"),
      },
    ];
  },
};

export default config;

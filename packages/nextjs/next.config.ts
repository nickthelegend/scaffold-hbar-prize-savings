import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, "../.."),
  reactStrictMode: true,
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  eslint: {
    ignoreDuringBuilds: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  webpack: (config, { dev, webpack }) => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    // @scaffold-hbar-ui/hooks prices HBAR with CoinGecko from the browser, which rate-limits visitors and then fails
    // CORS (a red console error on every page with a balance). Swap in this app's module with the same exports, which
    // reads the network's own exchange rate from the mirror node.
    config.plugins.push(
      new webpack.NormalModuleReplacementPlugin(
        /@scaffold-hbar-ui[\\/]hooks[\\/]dist[\\/](esm|cjs)[\\/]hbarPrice\.js$/,
        path.join(__dirname, "utils/scaffold-hbar/hbarPrice.ts"),
      ),
    );
    config.externals.push("pino-pretty", "lokijs", "encoding");
    if (dev) {
      config.watchOptions = {
        followSymlinks: true,
      };
      config.snapshot = { ...(config.snapshot as object), managedPaths: [] };
    }
    return config;
  },
};

module.exports = nextConfig;

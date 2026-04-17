import fs from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function readHttpsConfig() {
  const keyPath = process.env.KODER_HTTPS_KEY_PATH?.trim();
  const certPath = process.env.KODER_HTTPS_CERT_PATH?.trim();

  if (!keyPath || !certPath) {
    return undefined;
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

const https = readHttpsConfig();
const relayProxyTarget = process.env.KODER_RELAY_PROXY_TARGET?.trim();
const disableHmr = process.env.KODER_DISABLE_HMR?.trim().toLowerCase() === "true";
const proxy = relayProxyTarget
  ? {
      "/relay": {
        target: relayProxyTarget,
        changeOrigin: true,
        ws: true,
      },
      "/v1": {
        target: relayProxyTarget,
        changeOrigin: true,
      },
      "/health": {
        target: relayProxyTarget,
        changeOrigin: true,
      },
    }
  : undefined;

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    https,
    hmr: disableHmr ? false : undefined,
    proxy
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    strictPort: true,
    https
  },
  build: {
    outDir: "dist",
    sourcemap: true
  }
});

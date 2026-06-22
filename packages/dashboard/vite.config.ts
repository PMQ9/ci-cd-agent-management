import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const target = process.env.CONTROL_PLANE_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target, changeOrigin: true },
      "/auth": { target, changeOrigin: true },
      "/webhook": { target, changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});

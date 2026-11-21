import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import legacy from "@vitejs/plugin-legacy";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    legacy({ targets: ["chrome 51"] }),
  ],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/tv-ready-notice": {
        target: "https://tvadmin.colonialplazapinda.com.br",
        changeOrigin: true,
        secure: true,
        rewrite: () => "/backend/api/orders/ready-notice.php",
      },
    },
  },
});

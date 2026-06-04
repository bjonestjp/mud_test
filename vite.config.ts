import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          map: ["maplibre-gl"],
          react: ["react", "react-dom"]
        }
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173
  }
});

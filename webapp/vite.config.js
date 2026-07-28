import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vuetify from "vite-plugin-vuetify";
import { resolve } from "path";
import { gzipAssets } from "./vite-plugins/gzip-assets.js";

export default defineConfig({
  plugins: [
    vue(),
    vuetify({ autoImport: true }),
    // Must come last: it writes a .gz beside each emitted file.
    gzipAssets(),
  ],
  build: {
    outDir: resolve(__dirname, "../main/webapp"),
    emptyOutDir: true,
    rollupOptions: {
      external: ["/measurement_sample.jpg"],
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://192.168.0.140",
        changeOrigin: true,
      },
    },
    fs: {
      allow: [resolve(__dirname, "..")],
    },
  },
});

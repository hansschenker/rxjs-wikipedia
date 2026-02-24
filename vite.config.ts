import { defineConfig } from "vite";

export default defineConfig({
  server: {
    proxy: {
      "/wiki": {
        target: "https://en.wikipedia.org",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/wiki/, ""),
      },
    },
  },
});

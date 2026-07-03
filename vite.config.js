import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    exclude: ["@imgly/background-removal"],
  },
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
});

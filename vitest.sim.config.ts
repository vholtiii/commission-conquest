import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    environment: "node",
    include: ["src/engine/sim/**/*.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});

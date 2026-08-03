import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    fileParallelism: false,
    hookTimeout: 30_000,
    passWithNoTests: false,
    testTimeout: 30_000,
  },
});

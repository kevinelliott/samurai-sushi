import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.integration.test.ts"],
    passWithNoTests: true
  }
});

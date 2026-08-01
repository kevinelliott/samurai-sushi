import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.integration.test.ts", "scripts/**/*.integration.test.ts"],
    passWithNoTests: false
  }
});

import { defineConfig } from "vitest/config";

const integration = process.env.STELLARSAFE_INTEGRATION === "1";

export default defineConfig({
  test: {
    include: integration ? ["test/integration/**/*.test.ts"] : ["test/unit/**/*.test.ts"],
    testTimeout: integration ? 120_000 : 5_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      reporter: ["text", "lcov"],
      thresholds: { lines: 90, functions: 90, branches: 85, statements: 90 },
    },
  },
});

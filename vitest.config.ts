import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    // Points KINV_HOME at a throwaway directory, so no test reads or writes the
    // developer's own catalog. See tests/setup.ts.
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // Only core/ carries a floor: demanding coverage of CLI rendering
      // produces tests that assert nothing.
      thresholds: {
        "src/core/**": { statements: 90, branches: 85, functions: 90, lines: 90 },
      },
    },
  },
});

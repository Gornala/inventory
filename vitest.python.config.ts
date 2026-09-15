import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * The browser tests, run against the Python server.
 *
 *   npx vitest run -c vitest.python.config.ts
 *
 * Every test in tests/ui starts the server through `src/ui/server.js`; that
 * one import is redirected to scripts/python-server.ts, which starts
 * `python -m kinv.ui.testserve` instead. Nothing in the tests changes, so a
 * pass means the Python server serves the page, answers its API, and writes
 * its files the way the TypeScript one does. KINV_PYTHON picks the
 * interpreter — KiCad's own, for instance.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^.*\/src\/ui\/server\.js$/,
        replacement: resolve(import.meta.dirname, "scripts/python-server.ts"),
      },
    ],
  },
  test: {
    include: ["tests/ui/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

/**
 * Every test file gets its own empty inventory.
 *
 * The catalog is one directory for all boards, which means it defaults to the
 * developer's own `~/.kinv`. A test run that read it would be neither hermetic
 * nor honest — the reference board's counts would depend on whose machine it
 * ran on — and a test that wrote to it would edit a real catalog. `KINV_HOME`
 * exists for exactly this, and pointing it at a temp directory here means no
 * individual test has to remember to.
 */
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "kinv-test-home-"));
  process.env["KINV_HOME"] = home;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

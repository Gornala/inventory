import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const fixtureDir = dirname(fileURLToPath(import.meta.url));

export function fixture(...parts: string[]): string {
  return join(fixtureDir, ...parts);
}

/**
 * The reference board: a real, messy, hierarchical KiCad 10 project (646 placed
 * symbols across 13 sheets). Committed fixtures are snapshots taken from it, so
 * the normal test run stays hermetic; tests that want the live project guard on
 * `liveProject()` and skip when it is not on this machine.
 *
 * Override with KINV_TEST_PROJECT to point at a different board.
 */
const defaultLiveProject =
  "C:/Users/gewac/Documents/multi_source/moduls hardware/Resonat Power Supply/transformator_test_v3/transformer_test.kicad_pro";

export function liveProject(): string | undefined {
  const path = process.env["KINV_TEST_PROJECT"] ?? defaultLiveProject;
  return existsSync(path) ? path : undefined;
}

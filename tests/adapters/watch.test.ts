import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { watchProject, type Watcher } from "../../src/adapters/kicad/watch.js";

let dir: string;
let watcher: Watcher | undefined;

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kinv-watch-"));
  revision = 0;
});

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  rmSync(dir, { recursive: true, force: true });
});

let revision = 0;

/**
 * A hierarchical save touches several sheets in quick succession.
 *
 * Each revision writes a different amount of content on purpose. Two writes in
 * the same millisecond with the same length are indistinguishable to any
 * mtime+size check — real saves are seconds apart and change the file, but a
 * test can outrun the clock.
 */
function saveSheets(count: number, tag: string): void {
  revision += 1;
  for (let i = 0; i < count; i++) {
    writeFileSync(
      join(dir, `sheet${i}.kicad_sch`),
      `(kicad_sch ${tag} ${i})${"x".repeat(revision)}`,
    );
  }
}

describe("watching a project", () => {
  it("fires once for a save that touches many sheets", async () => {
    const project = join(dir, "board.kicad_pro");
    saveSheets(5, "before");
    writeFileSync(project, "{}");

    let fired = 0;
    watcher = watchProject(project, () => (fired += 1), { settleMs: 60, sweepMs: 20 });

    await wait(120);
    expect(fired).toBe(0); // nothing has changed yet

    saveSheets(5, "after"); // KiCad writing the whole hierarchy
    await wait(300);
    expect(fired).toBe(1);
  });

  it("fires again for a second save", async () => {
    const project = join(dir, "board.kicad_pro");
    saveSheets(1, "v1");

    let fired = 0;
    watcher = watchProject(project, () => (fired += 1), { settleMs: 60, sweepMs: 20 });

    saveSheets(1, "v2");
    await wait(250);
    saveSheets(1, "v3");
    await wait(250);
    expect(fired).toBe(2);
  });

  it("ignores files that are not schematics", async () => {
    const project = join(dir, "board.kicad_pro");
    saveSheets(1, "v1");

    let fired = 0;
    watcher = watchProject(project, () => (fired += 1), { settleMs: 60, sweepMs: 20 });

    // lock files, backups and the netlist all land in the same directory
    writeFileSync(join(dir, "~board.kicad_sch.lck"), "lock");
    writeFileSync(join(dir, "board.kicad_prl"), "{}");
    writeFileSync(join(dir, "board.net"), "netlist");
    await wait(250);
    expect(fired).toBe(0);
  });

  it("stops when told to", async () => {
    const project = join(dir, "board.kicad_pro");
    saveSheets(1, "v1");

    let fired = 0;
    watcher = watchProject(project, () => (fired += 1), { settleMs: 60, sweepMs: 20 });
    watcher.stop();

    saveSheets(1, "v2");
    await wait(250);
    expect(fired).toBe(0);
  });

  it("watches the file itself when given a csv", async () => {
    const csv = join(dir, "bom.csv");
    writeFileSync(csv, "a\n");

    let fired = 0;
    watcher = watchProject(csv, () => (fired += 1), { settleMs: 60, sweepMs: 20 });

    writeFileSync(csv, "a\nb\n");
    await wait(250);
    expect(fired).toBe(1);
  });
});

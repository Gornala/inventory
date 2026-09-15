import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readAssignments,
  readCatalog,
  writeAssignments,
  writeCatalog,
} from "../../src/adapters/store/inventory.js";
import { buildProgram } from "../../src/cli/program.js";
import { buildReport } from "../../src/report.js";
import { fixture } from "../fixtures/index.js";

/** Runs the CLI in-process and collects what it printed. */
async function run(...argv: string[]): Promise<{ out: string; code: number | undefined }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.join(" "));
  });
  process.exitCode = undefined;
  try {
    await buildProgram().parseAsync(["node", "kinv", ...argv]);
    return { out: lines.join("\n"), code: process.exitCode as number | undefined };
  } finally {
    log.mockRestore();
    process.exitCode = undefined;
  }
}

describe("kinv resolve", () => {
  let dir: string;
  let project: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kinv-cli-"));
    project = join(dir, "board.bom.csv");
    writeFileSync(
      project,
      [
        '"Reference","Value","Footprint","QUANTITY","DNP"',
        '"R1,R2","10k","Resistor_SMD:R_0402_1005Metric","2",""',
        '"C1","100n","Capacitor_SMD:C_0603_1608Metric","1",""',
      ].join("\n"),
      "utf8",
    );
    writeCatalog([]);
    writeAssignments([]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists what is still unresolved, and fails while any is", async () => {
    const { out, code } = await run("resolve", project);
    expect(out).toContain("NOT YET RESOLVED");
    expect(out).toContain("R|10k|0402");
    expect(out).toContain("C|100n|0603");
    expect(out).toContain("0 of 2 parts resolved");
    // so it drops into CI or a pre-order check the same way `kinv check` does
    expect(code).toBe(1);
  });

  it("assigns a part, and says nothing more about it", async () => {
    await run("resolve", project, "--set", "R|10k|0402=RC0402FR-0710KL@Yageo");

    expect(readCatalog()).toMatchObject([{ mpn: "RC0402FR-0710KL", manufacturer: "Yageo" }]);
    expect(readAssignments().map((a) => a.key)).toEqual(["R|10k|0402"]);

    const { out } = await run("resolve", project);
    expect(out).not.toContain("R|10k|0402");
    expect(out).toContain("1 of 2 parts resolved");
  });

  it("exits zero once every part is bought", async () => {
    const { code } = await run(
      "resolve",
      project,
      "--set",
      "R|10k|0402=RC0402FR-0710KL",
      "--set",
      "C|100n|0603=CL10B104KB8NNNC",
    );
    expect(code).toBeUndefined();
    expect(readCatalog()).toHaveLength(2);
  });

  it("refuses a key that is not on this board", async () => {
    // a typo would otherwise sit in a catalog that outlives the board,
    // attached to nothing
    await expect(run("resolve", project, "--set", "R|10k|0603=WRONG-1")).rejects.toThrow(
      /no part on this board keyed/,
    );
    expect(readCatalog()).toEqual([]);
  });

  it("clears an assignment", async () => {
    await run("resolve", project, "--set", "R|10k|0402=RC0402FR-0710KL");
    await run("resolve", project, "--clear", "R|10k|0402");
    expect(readAssignments()).toEqual([]);
    expect(readCatalog()).toHaveLength(1);
  });

  it("shows everything with --all, and the catalog path", async () => {
    await run("resolve", project, "--set", "R|10k|0402=RC0402FR-0710KL");
    const { out } = await run("resolve", project, "--all");
    expect(out).toContain("EVERY PART");
    expect(out).toContain("RC0402FR-0710KL");
    expect(out).toContain("1 in the catalog");
  });

  it("has a machine-readable form", async () => {
    await run("resolve", project, "--set", "R|10k|0402=RC0402FR-0710KL");
    const { out } = await run("resolve", project, "--json");
    const parsed = JSON.parse(out) as { parts: { key: string; part?: { mpn: string } }[] };
    expect(parsed.parts.find((p) => p.key === "R|10k|0402")?.part?.mpn).toBe("RC0402FR-0710KL");
  });
});

describe("every command reads the board the same way", () => {
  it("check, resolve and the report agree on how many parts there are", async () => {
    // `kinv check` used to do its own read and skip the geometry step that
    // decides what is a purchase at all, so it reported 81 parts where the page
    // reported 83 — the two Würth SMD standoffs, thrown out by the mounting-hole
    // rule and put back by the copper.
    const board = fixture("kicad10", "transformer_test.bom.csv");
    const report = await buildReport(board);

    const check = await run("check", board, "--quiet");
    expect(check.out).toContain(`${report.summary.placements} placements`);
    expect(check.out).toContain(`${report.summary.lines} BOM lines`);
    expect(check.out).toContain(`${report.summary.parts} distinct parts`);

    const resolve = await run("resolve", board);
    expect(resolve.out).toContain(`of ${report.summary.parts} parts resolved`);
  });
});

describe("kinv init", () => {
  it("says where the inventory is", async () => {
    const { out } = await run("init");
    expect(out).toContain("catalog.json");
    expect(out).toContain("assignments.json");
    expect(out).toContain("KINV_HOME");
  });
});

describe("kinv fields write", () => {
  let dir: string;
  let sheet: string;
  let project: string;
  let original: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kinv-fw-"));
    sheet = join(dir, "board.kicad_sch");
    project = join(dir, "board.bom.csv");
    copyFileSync(fixture("kicad10", "encoder.kicad_sch"), sheet);
    writeFileSync(
      project,
      [
        '"Reference","Value","Footprint","QUANTITY","DNP"',
        '"R10002","10k","Resistor_SMD:R_0402_1005Metric","1",""',
      ].join("\n"),
      "utf8",
    );
    original = readFileSync(sheet, "utf8");
    writeCatalog([]);
    writeAssignments([]);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("has nothing to write before anything is resolved", async () => {
    const { out } = await run("fields", "write", project);
    expect(out).toContain("no part on this board has an MPN yet");
    expect(readFileSync(sheet, "utf8")).toBe(original);
  });

  it("shows the diff and writes nothing without --apply", async () => {
    await run("resolve", project, "--set", "R|10k|0402=RC0402FR-0710KL@Yageo");
    const { out } = await run("fields", "write", project);

    expect(out).toContain("R10002");
    expect(out).toContain('+ MPN = "RC0402FR-0710KL"');
    expect(out).toContain('+ Manufacturer = "Yageo"');
    expect(out).toContain("dry run — nothing written");
    expect(readFileSync(sheet, "utf8")).toBe(original);
  });

  it("writes the fields with --apply, and is idempotent", async () => {
    await run("resolve", project, "--set", "R|10k|0402=RC0402FR-0710KL@Yageo");
    const { out } = await run("fields", "write", project, "--apply");
    expect(out).toContain("wrote 1 symbols");

    const after = readFileSync(sheet, "utf8");
    expect(after).toContain('(property "MPN" "RC0402FR-0710KL"');
    expect(after).toContain('(property "Manufacturer" "Yageo"');
    expect(readFileSync(`${sheet}.bak`, "utf8")).toBe(original);

    // running it again is a no-op: the schematic already says so
    const second = await run("fields", "write", project, "--apply");
    expect(second.out).toContain("every field already written");
    expect(readFileSync(sheet, "utf8")).toBe(after);
  });

  it("leaves the designer's own fields alone", async () => {
    // Value and Footprint are the designer's; Description and Datasheet come
    // from the symbol library. Only what the tool decided gets written.
    await run("resolve", project, "--set", "R|10k|0402=RC0402FR-0710KL");
    await run("fields", "write", project, "--apply");

    const after = readFileSync(sheet, "utf8");
    expect(after).toContain('(property "Value" "10k"');
    expect(after).toContain('(property "Footprint" "Resistor_SMD:R_0402_1005Metric"');
    expect(after).toContain('(property "Description" "Resistor"');
  });
});
